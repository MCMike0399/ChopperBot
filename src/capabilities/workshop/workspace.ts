import {
   closeSync,
   constants as fsConstants,
   lstatSync,
   mkdirSync,
   openSync,
   readdirSync,
   statSync,
   readFileSync,
   writeFileSync,
   existsSync,
   unlinkSync,
} from "node:fs";
import { join, resolve, sep, normalize, dirname } from "node:path";

/**
 * Per-session file workspace: `data/workshop/sessions/<channelId>/`.
 *
 * Everything the sandboxed python run and the file tools touch lives here.
 * The bwrap sandbox bind-mounts EXACTLY this directory read-write (as
 * /workspace), so the path guards below are the boundary the LLM's file tools
 * get — nothing outside the session dir is ever readable/writable through them.
 *
 * **Two guards, because a lexical one is not enough.** `safeJoin` rejects
 * absolute paths, `..` and null bytes, but it only reasons about the *string*;
 * the file tools run in the BOT process, outside the sandbox, and `readFileSync`
 * & friends follow symlinks. Sandboxed python cannot read `/home` — but it can
 * write `os.symlink('../../../../.env', '/workspace/loot.pdf')` inside its own
 * mount, and then ask for `loot.pdf` back through `workshop_send_file`
 * (→ DISCORD_TOKEN, DEEPSEEK_API_KEY, the MinIO keys straight into a Discord
 * channel) or overwrite `dist/index.js` through `workshop_write_file`. So every
 * path is ALSO checked component-by-component for symlinks
 * ({@link assertNoSymlink}), and the actual open uses `O_NOFOLLOW`.
 */

export interface WorkspaceFile {
   /** Path relative to the workspace root, using forward slashes. */
   path: string;
   bytes: number;
   modifiedAt: number;
}

/** Files/dirs never shown to the model nor sent to Discord. `.workshop` is
 * the per-run staging dir (wiped after each python run); `.docindex` holds the
 * document indexes (see docindex.ts) and persists between turns.
 *
 * `.scratch` and `recalc` are WORK dirs: LibreOffice recalculates a copy of a
 * workbook there, and the converted-preview dir of the pdf recipe lives there
 * too. They are hidden because a scratch copy is not a deliverable and, when it
 * carries the same basename as the real file, the auto-delivery net used to
 * attach BOTH (live 2026-11-16/17, two sessions: `Control_cooperativa_puntos
 * .xlsx` arrived twice with different sizes, once from `recalc/`). Hiding them
 * keeps them out of the model's listing AND out of the delivery net, while
 * `read_file` can still reach them by explicit path. */
const SCRATCH_PREFIXES = [".scratch", "recalc"];
const HIDDEN_PREFIXES = [".workshop", ".docindex", ...SCRATCH_PREFIXES];

/** Work dirs the GC may wipe for an idle session (recomputable copies only). */
export const SCRATCH_DIRS: readonly string[] = SCRATCH_PREFIXES;

export class PathEscapeError extends Error {
   constructor(requested: string) {
      super(`Path escapes the session workspace: ${requested}`);
      this.name = "PathEscapeError";
   }
}

/**
 * Resolve a model/user-supplied relative path INSIDE `root`, rejecting
 * absolute paths, `..` traversal and null bytes. Pure given its inputs —
 * unit-tested directly.
 */
export function safeJoin(root: string, requested: string): string {
   if (requested.includes("\0")) throw new PathEscapeError(requested);
   const cleaned = requested.trim().replace(/^[/\\]+/, "");
   if (cleaned.length === 0) throw new PathEscapeError(requested);
   const abs = resolve(root, normalize(cleaned));
   const rootAbs = resolve(root);
   if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      throw new PathEscapeError(requested);
   }
   return abs;
}

/**
 * Reject a path that would leave the workspace through a SYMLINK — the escape
 * `safeJoin` cannot see, because a symlink is a legal-looking name.
 *
 * Every component below `root` is `lstat`ed (never `stat`ed: that would follow
 * the very link we're looking for) and any symlink is refused, wherever it
 * points. Symlinks have no legitimate use in a session workspace, so this is a
 * flat ban rather than a "resolve it and re-check containment" — no room for a
 * clever relative target, and no dependence on evaluation order.
 *
 * A component that does not exist yet ends the walk: nothing below it can exist
 * either, and creating it is what `writeText` is for.
 */
export function assertNoSymlink(
   root: string,
   abs: string,
   requested = abs,
): void {
   const rootAbs = resolve(root);
   if (abs === rootAbs) return;
   const parts = abs.slice(rootAbs.length).split(sep).filter(Boolean);
   let cursor = rootAbs;
   for (const part of parts) {
      cursor = join(cursor, part);
      let st;
      try {
         st = lstatSync(cursor);
      } catch {
         return; // not there (yet) — nothing to follow
      }
      if (st.isSymbolicLink()) throw new PathEscapeError(requested);
   }
}

/**
 * The full guard: lexical containment ({@link safeJoin}) AND no symlink on the
 * way in ({@link assertNoSymlink}). Every workspace file operation goes through
 * this — use it instead of `safeJoin` anywhere a path is about to be opened.
 */
export function resolveInside(root: string, requested: string): string {
   const abs = safeJoin(root, requested);
   assertNoSymlink(root, abs, requested);
   return abs;
}

/** `O_NOFOLLOW` where the platform has it (POSIX); 0 elsewhere. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Open the FINAL component with `O_NOFOLLOW` and run `body` on the fd. This
 * closes the gap {@link assertNoSymlink} leaves open by construction — the
 * check and the open are two syscalls, and the kernel is the only place they
 * can be made one. `ELOOP` (the final component is a symlink) surfaces as the
 * same {@link PathEscapeError} as every other escape.
 */
function withNoFollowFd<T>(
   abs: string,
   flags: number,
   requested: string,
   body: (fd: number) => T,
): T {
   let fd: number;
   try {
      fd = openSync(abs, flags | O_NOFOLLOW);
   } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP")
         throw new PathEscapeError(requested);
      throw err;
   }
   try {
      return body(fd);
   } finally {
      closeSync(fd);
   }
}

export class SessionWorkspace {
   constructor(readonly root: string) {}

   ensure(): void {
      mkdirSync(this.root, { recursive: true });
   }

   /**
    * Absolute path for a workspace-relative path, guarded against BOTH `..`
    * traversal and symlink escapes. Throws {@link PathEscapeError} either way —
    * callers outside this class (docindex, the file tools) get the same boundary.
    */
   absolute(relPath: string): string {
      return resolveInside(this.root, relPath);
   }

   exists(relPath: string): boolean {
      return existsSync(this.absolute(relPath));
   }

   writeText(relPath: string, content: string): void {
      this.write(relPath, content, "utf-8");
   }

   writeBytes(relPath: string, bytes: Uint8Array): void {
      this.write(relPath, bytes);
   }

   /** Create-or-truncate write that never follows a symlink (see the file header). */
   private write(
      relPath: string,
      data: string | Uint8Array,
      encoding?: BufferEncoding,
   ): void {
      const abs = this.absolute(relPath);
      mkdirSync(dirname(abs), { recursive: true });
      const flags =
         fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC;
      withNoFollowFd(abs, flags, relPath, (fd) => {
         if (typeof data === "string")
            writeFileSync(fd, data, encoding ?? "utf-8");
         else writeFileSync(fd, data);
      });
   }

   readText(
      relPath: string,
      maxBytes: number,
   ): { content: string; truncated: boolean; bytes: number } {
      const buf = Buffer.from(this.readBytes(relPath));
      const slice = buf.subarray(0, maxBytes);
      return {
         content: slice.toString("utf-8"),
         truncated: buf.length > maxBytes,
         bytes: buf.length,
      };
   }

   /** Raw bytes of a workspace file (binary-safe — for storage uploads). */
   readBytes(relPath: string): Uint8Array {
      const abs = this.absolute(relPath);
      return withNoFollowFd(abs, fsConstants.O_RDONLY, relPath, (fd) =>
         readFileSync(fd),
      );
   }

   stat(relPath: string): { bytes: number } {
      // lstat, not stat: `absolute()` already refused a symlink, and lstat can't
      // be talked into reporting the size of something outside the workspace.
      return { bytes: lstatSync(this.absolute(relPath)).size };
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
            if (
               HIDDEN_PREFIXES.some((h) => rel === h || rel.startsWith(`${h}/`))
            )
               continue;
            const abs = join(dir, entry.name);
            if (entry.isDirectory()) {
               walk(abs, rel);
            } else if (entry.isFile()) {
               const st = statSync(abs);
               out.push({ path: rel, bytes: st.size, modifiedAt: st.mtimeMs });
            }
         }
      };
      walk(this.root, "");
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
   if (!/^\d{5,25}$/.test(channelId))
      throw new Error(`Invalid channel id: ${channelId}`);
   return join(dataDir, "workshop", "sessions", channelId);
}

/**
 * Extensions that count as user-facing deliverables (the auto-delivery safety
 * net and the delivery ledger). Intermediates (.txt/.json/.md extracts…) are
 * deliberately excluded — only files a member would want to download.
 */
const DELIVERABLE_EXTS = new Set([
   ".xlsx",
   ".docx",
   ".pptx",
   ".pdf",
   ".png",
   ".jpg",
   ".jpeg",
   ".gif",
   ".svg",
   ".csv",
   ".zip",
   ".mp3",
   ".wav",
]);

/**
 * Whether a workspace path looks like a user-facing deliverable. User uploads
 * (`uploads/…`) never qualify — they came FROM the user.
 */
export function isDeliverablePath(relPath: string): boolean {
   if (relPath.startsWith("uploads/")) return false;
   const ext = /\.[a-z0-9]{1,10}$/i.exec(relPath)?.[0]?.toLowerCase();
   return ext !== undefined && DELIVERABLE_EXTS.has(ext);
}

/**
 * The auto-delivery safety net, pure and unit-tested: files created or
 * modified THIS turn that look like deliverables and were neither queued for
 * sending by the model nor already recorded in the durable manifest. Live
 * 2026-08-09: a session's estatutos .docx/.pdf were generated but the model
 * ended the turn without `workshop_send_file` — the user never got them and
 * the model couldn't tell. The watcher sends whatever this returns.
 *
 * Two rules keep the net from spamming a member:
 * - files over `maxBytes` are left out (Discord rejects them; the ledger shows
 *   ⚠️ next turn so the model can zip or split them);
 * - ONE file per basename: a member never needs two `foo.xlsx` attachments, and
 *   the shallowest path wins (the root-level file is the real deliverable, a
 *   deeper one is a work copy).
 */
export function listUndeliveredDeliverables(
   before: Map<string, number>,
   after: WorkspaceFile[],
   skip: ReadonlySet<string>,
   maxBytes = Number.POSITIVE_INFINITY,
): WorkspaceFile[] {
   const candidates = after.filter(
      (f) =>
         isDeliverablePath(f.path) &&
         before.get(f.path) !== f.modifiedAt && // created or rewritten this turn
         !skip.has(f.path) &&
         f.bytes <= maxBytes,
   );
   const byName = new Map<string, WorkspaceFile>();
   for (const f of candidates) {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      const seen = byName.get(name);
      if (!seen || depth(f.path) < depth(seen.path)) byName.set(name, f);
   }
   return [...byName.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Path depth (number of separators) — used to prefer the root-level copy. */
function depth(relPath: string): number {
   return relPath.split("/").length;
}

/** Discord's per-message attachment ceiling for grouped deliveries. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Split a list into groups of at most `size` (keeps input order). */
export function batchForSend<T>(
   items: readonly T[],
   size = MAX_ATTACHMENTS_PER_MESSAGE,
): T[][] {
   const out: T[][] = [];
   for (let i = 0; i < items.length; i += size)
      out.push(items.slice(i, i + size));
   return out;
}
