import { statSync } from 'node:fs';
import { runPython, sandboxAvailable } from './sandbox.js';
import type { SessionWorkspace } from './workspace.js';

/**
 * Document index for big texts (the "RAG" of the workshop): a canned,
 * sandboxed Python pass extracts a PDF/DOCX/TXT once into page-aware chunks +
 * an outline, and the doc tools then answer from the index — search retrieves
 * only the relevant fragments, read serves bounded page ranges. The document
 * itself never has to fit in the model's context.
 *
 * Why (live 2026-08-06): a 408-page book PDF exhausted a whole turn's context
 * in one pass (147k input tokens) and the model lost the tool protocol. The
 * batched-by-chapters prompt helped, but the model still had to improvise the
 * extraction every session. The index makes the structure durable and cheap.
 *
 * Layout (hidden from listings, purged with the workspace):
 *   .docindex/<slug>/meta.json    — source identity + outline
 *   .docindex/<slug>/chunks.jsonl — one JSON chunk per line
 */

/** Workspace dir that holds every document index (hidden prefix). */
export const DOCINDEX_DIR = '.docindex';

/** Source extensions the indexer can extract. */
export const INDEXABLE_EXTS = new Set(['.pdf', '.docx', '.txt', '.md']);

/** Target characters per chunk (page-aware, split on paragraph boundaries). */
const CHUNK_CHARS = 1800;

export interface DocChunk {
  id: number;
  page_start: number;
  page_end: number;
  heading: string | null;
  text: string;
}

export interface DocOutlineEntry {
  heading: string;
  page: number;
  chunk: number;
}

export interface DocMeta {
  source: string;
  /** `${bytes}:${mtimeMs}` of the source at index time — freshness check. */
  source_key: string;
  pages: number;
  chars: number;
  chunks: number;
  outline: DocOutlineEntry[];
}

/** Deterministic, filesystem-safe index dir for a source path. */
export function docIndexDirFor(sourceRel: string): string {
  let hash = 5381;
  for (let i = 0; i < sourceRel.length; i++) {
    hash = ((hash << 5) + hash + sourceRel.charCodeAt(i)) >>> 0;
  }
  const slug = sourceRel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `${DOCINDEX_DIR}/${slug || 'doc'}-${hash.toString(16)}`;
}

/** Identity of the source file right now (freshness key). */
export function sourceKeyFor(workspace: SessionWorkspace, sourceRel: string): string {
  const st = statSync(workspace.absolute(sourceRel));
  return `${st.size}:${Math.floor(st.mtimeMs)}`;
}

/**
 * The canned extraction/chunking script. Pure string builder — unit-tested
 * for parameter injection; the behavior test runs it through the real
 * sandbox where bwrap exists.
 */
export function buildIndexerScript(input: {
  sourceRel: string;
  outDirRel: string;
  sourceKey: string;
}): string {
  const params = JSON.stringify({
    src: input.sourceRel,
    out: input.outDirRel,
    source_key: input.sourceKey,
    chunk_chars: CHUNK_CHARS,
  });
  return `
import json, os, re, subprocess, sys, unicodedata

P = json.loads(${JSON.stringify(params)})
SRC, OUT, CHUNK_CHARS = P["src"], P["out"], P["chunk_chars"]

def emit(obj):
    print("DOCINDEX_RESULT " + json.dumps(obj, ensure_ascii=False))
    sys.exit(0)

def fail(reason):
    emit({"ok": False, "reason": reason})

if not os.path.exists(SRC):
    fail("no_existe: " + SRC)
ext = os.path.splitext(SRC)[1].lower()

pages = []
if ext == ".pdf":
    try:
        r = subprocess.run(["pdftotext", "-layout", SRC, "-"], capture_output=True, text=True)
    except FileNotFoundError:
        fail("pdftotext_no_disponible")
    if r.returncode != 0:
        fail("pdftotext_fallo: " + (r.stderr or "")[:200])
    pages = r.stdout.split("\\f")
elif ext == ".docx":
    try:
        import docx
    except ImportError:
        fail("python_docx_no_disponible")
    d = docx.Document(SRC)
    pages = ["\\n".join(p.text for p in d.paragraphs)]
elif ext in (".txt", ".md"):
    with open(SRC, encoding="utf-8", errors="replace") as f:
        pages = [f.read()]
else:
    fail("formato_no_soportado: " + ext)

total_chars = sum(len(p) for p in pages)
if total_chars < 200:
    fail("sin_texto_extraible (PDF escaneado sin OCR, o documento vacio)")

HEAD_RE = re.compile(
    r"^\\s*(cap[i\\u00ed]tulo|chapter|parte|secci[o\\u00f3]n|unidad|tema|"
    r"introducci[o\\u00f3]n|conclusi[o\\u00f3]n|pr[o\\u00f3]logo|ep[i\\u00ed]logo|"
    r"bibliograf[i\\u00ed]a|anexo|ap[e\\u00e9]ndice)\\b.{0,80}$",
    re.I,
)

def is_heading(line):
    s = line.strip()
    if not (4 <= len(s) <= 90):
        return False
    if HEAD_RE.match(s):
        return True
    letters = [c for c in s if c.isalpha()]
    return (
        len(letters) >= 8
        and all(c.isupper() for c in letters)
        and not s.rstrip().endswith((".", ",", ";", ":"))
    )

chunks, outline = [], []
buf, buf_len, cur_heading, start_page = [], 0, None, 1

def flush(end_page):
    global buf, buf_len
    text = "\\n".join(buf).strip()
    buf, buf_len = [], 0
    if not text:
        return
    chunks.append({
        "id": len(chunks),
        "page_start": start_page,
        "page_end": end_page,
        "heading": cur_heading,
        "text": text,
    })

for pno, ptext in enumerate(pages, 1):
    for para in re.split(r"\\n\\s*\\n", ptext):
        para = para.strip("\\n")
        if not para.strip():
            continue
        first_line = para.strip().splitlines()[0]
        if is_heading(first_line):
            flush(pno)
            cur_heading = re.sub(r"\\s+", " ", first_line.strip())[:90]
            start_page = pno
            outline.append({"heading": cur_heading, "page": pno, "chunk": len(chunks)})
        if buf_len == 0:
            start_page = pno
        buf.append(para)
        buf_len += len(para)
        if buf_len >= CHUNK_CHARS:
            flush(pno)
flush(len(pages))

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "chunks.jsonl"), "w", encoding="utf-8") as f:
    for c in chunks:
        f.write(json.dumps(c, ensure_ascii=False) + "\\n")
meta = {
    "source": SRC,
    "source_key": P["source_key"],
    "pages": len(pages),
    "chars": total_chars,
    "chunks": len(chunks),
    "outline": outline[:120],
}
with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False)
emit({"ok": True, "pages": len(pages), "chars": total_chars, "chunks": len(chunks),
      "outline_entries": len(outline)})
`;
}

/** Parsed result line of an indexer run. */
export interface IndexerRunResult {
  ok: boolean;
  reason?: string;
  pages?: number;
  chars?: number;
  chunks?: number;
  outline_entries?: number;
}

/** Extract the DOCINDEX_RESULT line from the script's stdout. */
export function parseIndexerOutput(stdout: string): IndexerRunResult | null {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('DOCINDEX_RESULT '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('DOCINDEX_RESULT '.length)) as IndexerRunResult;
  } catch {
    return null;
  }
}

/** Read a built index; null when absent or unreadable. */
export function readDocIndex(
  workspace: SessionWorkspace,
  sourceRel: string,
): { meta: DocMeta; dir: string } | null {
  const dir = docIndexDirFor(sourceRel);
  try {
    const meta = JSON.parse(
      Buffer.from(workspace.readBytes(`${dir}/meta.json`)).toString('utf-8'),
    ) as DocMeta;
    return { meta, dir };
  } catch {
    return null;
  }
}

/** Load the chunk list of a built index (a few MB at most — fine per call). */
export function readDocChunks(workspace: SessionWorkspace, dir: string): DocChunk[] {
  const raw = Buffer.from(workspace.readBytes(`${dir}/chunks.jsonl`)).toString('utf-8');
  const out: DocChunk[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DocChunk);
    } catch {
      /* skip a corrupt line rather than fail the whole read */
    }
  }
  return out;
}

/**
 * Build (or rebuild) the index for a workspace source file, via the sandbox.
 * Returns the parsed result, or an { ok:false } with a Spanish reason.
 */
export async function ensureDocIndex(input: {
  workspace: SessionWorkspace;
  sourceRel: string;
  venvDir: string | null;
  timeoutMs: number;
}): Promise<{ meta: DocMeta; dir: string } | { error: string }> {
  const { workspace, sourceRel } = input;
  if (!workspace.exists(sourceRel)) {
    return { error: `No existe: ${sourceRel}. Usa workshop_list_files.` };
  }
  const ext = /\.[a-z0-9]{1,10}$/i.exec(sourceRel)?.[0]?.toLowerCase() ?? '';
  if (!INDEXABLE_EXTS.has(ext)) {
    return {
      error: `Formato no indexable (${ext || 'sin extensión'}). Soportados: PDF, DOCX, TXT, MD.`,
    };
  }
  const sourceKey = sourceKeyFor(workspace, sourceRel);
  const existing = readDocIndex(workspace, sourceRel);
  if (existing && existing.meta.source_key === sourceKey) return existing;

  if (!sandboxAvailable()) {
    return { error: 'La indexación no está disponible en este host (falta bubblewrap).' };
  }
  const dir = docIndexDirFor(sourceRel);
  const script = buildIndexerScript({ sourceRel, outDirRel: dir, sourceKey });
  const run = await runPython(script, {
    workspaceDir: workspace.root,
    venvDir: input.venvDir,
    timeoutMs: input.timeoutMs,
  });
  const result = parseIndexerOutput(run.stdout);
  if (!result) {
    return {
      error: `La indexación falló (${run.timedOut ? 'timeout' : `exit ${run.exitCode}`}): ${run.stderr.slice(0, 300)}`,
    };
  }
  if (!result.ok) {
    return { error: `No pude indexar el documento: ${result.reason ?? 'razón desconocida'}` };
  }
  const built = readDocIndex(workspace, sourceRel);
  if (!built) return { error: 'La indexación no dejó un índice legible — reinténtalo.' };
  return built;
}

// ── Lexical search over chunks ───────────────────────────────────────────────

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const tokenize = (s: string): string[] => normalize(s).match(/[a-z0-9]{2,}/g) ?? [];

/** Spanish/English stopwords that would otherwise dominate idf-less overlap. */
const STOPWORDS = new Set(
  ('de la el en y a los del las un una que es por con para su al lo como mas o ' +
    'the of and to in a is that for on as with it this').split(' '),
);

export interface DocSearchHit {
  chunk: DocChunk;
  score: number;
}

/**
 * Rank chunks against a query: idf-weighted token overlap plus a bonus when
 * the full normalized query appears as a phrase. Pure and unit-tested.
 */
export function searchChunks(chunks: DocChunk[], query: string, k: number): DocSearchHit[] {
  const queryTokens = [...new Set(tokenize(query).filter((t) => !STOPWORDS.has(t)))];
  if (queryTokens.length === 0 || chunks.length === 0) return [];

  const df = new Map<string, number>();
  const chunkTokens: Array<Map<string, number>> = chunks.map((c) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(c.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of queryTokens) if (tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const idf = (t: string): number => Math.log(1 + chunks.length / (1 + (df.get(t) ?? 0)));

  const phrase = normalize(query).trim();
  const hits: DocSearchHit[] = chunks.map((chunk, i) => {
    let score = 0;
    for (const t of queryTokens) {
      const tf = chunkTokens[i].get(t) ?? 0;
      if (tf > 0) score += idf(t) * Math.sqrt(tf);
    }
    if (phrase.length >= 8 && normalize(chunk.text).includes(phrase)) {
      score += 2 * queryTokens.reduce((acc, t) => acc + idf(t), 0);
    }
    return { chunk, score };
  });
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Trim a chunk to `maxChars`, centered on the first query-token hit. */
export function excerptAround(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tokens = tokenize(query).filter((t) => !STOPWORDS.has(t));
  const hay = normalize(text);
  let at = -1;
  for (const t of tokens) {
    const i = hay.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, Math.min(at < 0 ? 0 : at - Math.floor(maxChars / 3), text.length - maxChars));
  const slice = text.slice(start, start + maxChars);
  return `${start > 0 ? '…' : ''}${slice}${start + maxChars < text.length ? '…' : ''}`;
}
