import {
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve, sep, normalize, dirname } from 'node:path';

/**
 * Per-session file workspace: `data/workshop/sessions/<channelId>/`.
 *
 * Everything the sandboxed python run and the file tools touch lives here.
 * The bwrap sandbox bind-mounts EXACTLY this directory read-write (as
 * /workspace), so the path-traversal guard below is the boundary the LLM's
 * file tools get — nothing outside the session dir is ever readable/writable
 * through them.
 */

export interface WorkspaceFile {
  /** Path relative to the workspace root, using forward slashes. */
  path: string;
  bytes: number;
  modifiedAt: number;
}

/** Files/dirs never shown to the model nor sent to Discord. */
const HIDDEN_PREFIXES = ['.workshop'];

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path escapes the session workspace: ${requested}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve a model/user-supplied relative path INSIDE `root`, rejecting
 * absolute paths, `..` traversal and null bytes. Pure given its inputs —
 * unit-tested directly.
 */
export function safeJoin(root: string, requested: string): string {
  if (requested.includes('\0')) throw new PathEscapeError(requested);
  const cleaned = requested.trim().replace(/^[/\\]+/, '');
  if (cleaned.length === 0) throw new PathEscapeError(requested);
  const abs = resolve(root, normalize(cleaned));
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new PathEscapeError(requested);
  }
  return abs;
}

export class SessionWorkspace {
  constructor(readonly root: string) {}

  ensure(): void {
    mkdirSync(this.root, { recursive: true });
  }

  /** Absolute path for a workspace-relative path (traversal-guarded). */
  absolute(relPath: string): string {
    return safeJoin(this.root, relPath);
  }

  exists(relPath: string): boolean {
    return existsSync(this.absolute(relPath));
  }

  writeText(relPath: string, content: string): void {
    const abs = this.absolute(relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  writeBytes(relPath: string, bytes: Uint8Array): void {
    const abs = this.absolute(relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }

  readText(relPath: string, maxBytes: number): { content: string; truncated: boolean; bytes: number } {
    const abs = this.absolute(relPath);
    const size = statSync(abs).size;
    const buf = readFileSync(abs);
    const slice = buf.subarray(0, maxBytes);
    return { content: slice.toString('utf-8'), truncated: size > maxBytes, bytes: size };
  }

  stat(relPath: string): { bytes: number } {
    return { bytes: statSync(this.absolute(relPath)).size };
  }

  /** Delete one local file (the durable copy may live on Discord). */
  remove(relPath: string): void {
    unlinkSync(this.absolute(relPath));
  }

  /** Recursive listing (visible files only), sorted by path. */
  list(): WorkspaceFile[] {
    if (!existsSync(this.root)) return [];
    const out: WorkspaceFile[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (HIDDEN_PREFIXES.some((h) => rel === h || rel.startsWith(`${h}/`))) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (entry.isFile()) {
          const st = statSync(abs);
          out.push({ path: rel, bytes: st.size, modifiedAt: st.mtimeMs });
        }
      }
    };
    walk(this.root, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Total bytes of visible files (for status/limits). */
  totalBytes(): number {
    return this.list().reduce((acc, f) => acc + f.bytes, 0);
  }
}

/** Workspace root for one session channel. */
export function workspaceDirFor(dataDir: string, channelId: string): string {
  // channelId is a snowflake (digits only) — safe as a path segment; guard anyway.
  if (!/^\d{5,25}$/.test(channelId)) throw new Error(`Invalid channel id: ${channelId}`);
  return join(dataDir, 'workshop', 'sessions', channelId);
}
