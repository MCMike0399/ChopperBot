import { extname } from "node:path";
import { runPython } from "./sandbox.js";
import type { SessionWorkspace } from "./workspace.js";

export interface ArtifactCheck {
   checked: boolean;
   ok: boolean;
   errors: string[];
   warnings: string[];
   facts: Record<string, unknown>;
}

const SUPPORTED = new Set([
   ".docx",
   ".xlsx",
   ".pptx",
   ".pdf",
   ".png",
   ".jpg",
   ".jpeg",
   ".gif",
]);

/** Reopen the actual deliverable with its native reader INSIDE bwrap. No host parsers. */
export async function checkWorkshopFile(
   workspace: SessionWorkspace,
   path: string,
   venvDir: string | null,
): Promise<ArtifactCheck> {
   workspace.absolute(path); // Same traversal/symlink contract as every other file tool.
   if (!SUPPORTED.has(extname(path).toLowerCase())) {
      return {
         checked: false,
         ok: true,
         errors: [],
         warnings: ["Este formato no tiene revisión automática."],
         facts: {},
      };
   }
   if (!venvDir)
      return {
         checked: false,
         ok: true,
         errors: [],
         warnings: [
            "No está disponible el entorno de revisión; no se verificó el archivo.",
         ],
         facts: {},
      };
   const result = await runPython(buildArtifactCheckScript(path), {
      workspaceDir: workspace.root,
      venvDir,
      timeoutMs: 30_000,
   });
   try {
      const report = JSON.parse(result.stdout) as ArtifactCheck;
      if (
         result.exitCode === 0 &&
         typeof report.ok === "boolean" &&
         Array.isArray(report.errors) &&
         Array.isArray(report.warnings) &&
         report.facts
      )
         return report;
   } catch {
      /* Timeout, import failure, or malformed checker output is not a passed check. */
   }
   return {
      checked: false,
      ok: false,
      errors: [
         "No se completó la revisión del archivo. Reintenta o corrige el error con Python.",
      ],
      warnings: [],
      facts: { timed_out: result.timedOut, detail: result.stderr.slice(-1500) },
   };
}

export function buildArtifactCheckScript(path: string): string {
   return (
      `from pathlib import Path
import json
p = Path(${JSON.stringify(path)})
` +
      String.raw`
r = dict(checked=True, ok=True, errors=[], warnings=[], facts={})
def warn(s):
    if len(r['warnings']) < 12: r['warnings'].append(s)
def error(s):
    if len(r['errors']) < 12: r['errors'].append(s)
try:
    if not p.is_file() or p.stat().st_size == 0:
        raise ValueError('Archivo vacío o inexistente')
    ext = p.suffix.lower()
    if ext in ('.docx', '.xlsx', '.pptx'):
        from zipfile import ZipFile
        with ZipFile(p) as z:
            if z.testzip() is not None: raise ValueError('Contenedor Office dañado')
    if ext == '.docx':
        from docx import Document
        d = Document(p)
        texts = [x.text for x in d.paragraphs] + [c.text for t in d.tables for row in t.rows for c in row.cells]
        chars = sum(len(t.strip()) for t in texts)
        r['facts'] = dict(paragraphs=len(d.paragraphs), tables=len(d.tables), images=len(d.inline_shapes), text_chars=chars)
        if not chars and not len(d.inline_shapes): error('Documento sin contenido visible')
        if chars and not any(x.style.name.startswith(('Heading', 'Title', 'Título')) for x in d.paragraphs): warn('Sin estilos de título: revisa la estructura del documento.')
        if any(s.left_margin + s.right_margin >= s.page_width for s in d.sections): error('Los márgenes no dejan área útil en la página')
        warn('No se midieron páginas ni desbordamientos: convierte a PDF para revisar la distribución.')
    elif ext == '.xlsx':
        from openpyxl import load_workbook
        w = load_workbook(p, read_only=True, data_only=False)
        cached = load_workbook(p, read_only=True, data_only=True)
        formulas = missing = used = scanned = 0
        sheets = []
        for s in w:
            sheets.append(dict(name=s.title, rows=s.max_row, columns=s.max_column))
            if s.max_row * s.max_column > 100000:
                warn('Hoja demasiado grande para una revisión completa: ' + s.title)
                continue
            for row, values in zip(s.iter_rows(), cached[s.title].iter_rows()):
                for c, v in zip(row, values):
                    scanned += 1
                    if c.value is not None: used += 1
                    if c.data_type == 'e' or v.data_type == 'e': error('Error de Excel en ' + s.title + '!' + c.coordinate)
                    if c.data_type == 'f':
                        formulas += 1
                        if v.value is None: missing += 1
                        if '#REF!' in str(c.value): error('Referencia rota en ' + s.title + '!' + c.coordinate)
        r['facts'] = dict(sheets=sheets[:20], formulas=formulas, formulas_without_cached_value=missing, nonempty_cells=used, scanned_cells=scanned)
        if not used and not r['warnings']: error('Libro sin datos')
        if missing: warn(str(missing) + ' fórmulas sin resultado guardado. openpyxl no calcula: recalcula una copia con LibreOffice o explica que se calcularán al abrir.')
        if formulas: warn('La coherencia matemática y los supuestos requieren comprobaciones independientes en Python.')
        w.close(); cached.close()
    elif ext == '.pptx':
        from pptx import Presentation
        d = Presentation(p)
        count = len(d.slides)
        r['facts'] = dict(slides=count, width_inches=round(d.slide_width/914400, 2), height_inches=round(d.slide_height/914400, 2))
        if not count: error('Presentación sin diapositivas')
        for i, slide in enumerate(d.slides, 1):
            chars = 0
            for shape in slide.shapes:
                if shape.left < 0 or shape.top < 0 or shape.left + shape.width > d.slide_width + 9144 or shape.top + shape.height > d.slide_height + 9144: warn('Forma fuera de la diapositiva ' + str(i))
                if shape.has_text_frame:
                    chars += len(shape.text)
                    for para in shape.text_frame.paragraphs:
                        for run in para.runs:
                            size = run.font.size or para.font.size
                            if size is not None and size.pt < 18: warn('Texto menor de 18 pt en diapositiva ' + str(i))
            if chars > 900: warn('Mucho texto en la diapositiva ' + str(i) + ': considera dividirla.')
        warn('No se midió el desbordamiento del texto; revisa una conversión a PDF.')
    elif ext == '.pdf':
        from pypdf import PdfReader
        d = PdfReader(p)
        if d.is_encrypted: raise ValueError('PDF cifrado: no se pudo revisar')
        pages = len(d.pages)
        chars = sum(len(page.extract_text() or '') for page in d.pages[:100])
        r['facts'] = dict(pages=pages, text_chars=chars, pages_sampled=min(pages,100))
        if not pages: error('PDF sin páginas')
        if not chars: warn('Sin texto extraíble; puede ser un documento de imágenes. No se verificó su contenido.')
        warn('La extracción de texto no demuestra que el diseño esté bien: revisa una vista previa cuando sea posible.')
    else:
        from PIL import Image
        with Image.open(p) as im:
            width, height = im.size
            r['facts'] = dict(width=width, height=height, format=im.format)
            im.verify()
        if min(width,height) < 400: warn('Resolución pequeña: las etiquetas pueden ser ilegibles.')
except Exception as e:
    error(type(e).__name__ + ': ' + str(e)[:350])
r['ok'] = not r['errors']
print(json.dumps(r, ensure_ascii=False))
`
   );
}
