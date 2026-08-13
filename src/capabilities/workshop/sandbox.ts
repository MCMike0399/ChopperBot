import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../log.js';

/**
 * Sandboxed Python execution for workshop sessions, via bubblewrap (`bwrap`,
 * present on the Pi at /usr/bin/bwrap).
 *
 * The security model — user code runs with:
 *   - NO network (`--unshare-all` covers the net namespace).
 *   - NO /home, /root, /var: only /usr, /etc (read-only), the optional venv
 *     (read-only at /opt/venv) and the session workspace (read-write at
 *     /workspace) are mounted. The bot's `.env`, the SQLite DB and every other
 *     session's files are simply not in the mount tree.
 *   - CPU + address-space rlimits (via the sh -c 'ulimit …' wrapper) and a
 *     wall-clock kill from the Node side (SIGKILL on the bwrap PID;
 *     --die-with-parent takes the children down with it).
 *   - Output capped (a print-loop can't flood the model context).
 *
 * If bwrap is missing the tool REFUSES to run code (deterministic posture) —
 * it never falls back to executing user code unsandboxed.
 */

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** True when stdout/stderr were cut at the cap. */
  truncated: boolean;
}

export interface SandboxOptions {
  /** Absolute host path of the session workspace (mounted rw at /workspace). */
  workspaceDir: string;
  /** Absolute host path of the skills venv; mounted ro at /opt/venv when present. */
  venvDir: string | null;
  timeoutMs: number;
  /** Per-stream output cap in bytes. */
  maxOutputBytes?: number;
}

const BWRAP_BIN = '/usr/bin/bwrap';
/** Address-space cap for user code, in KB (1.5 GB — pandas/matplotlib fit). */
const MEMORY_LIMIT_KB = 1_572_864;
const DEFAULT_MAX_OUTPUT = 64 * 1024;
/** Where the code file is staged inside the workspace (hidden from listings). */
const RUN_DIR = '.workshop';

export function sandboxAvailable(): boolean {
  return existsSync(BWRAP_BIN);
}

/**
 * The bwrap argv for one run. Pure — unit tests assert the mount list never
 * includes /home and always unshares everything.
 */
export function buildBwrapArgs(opts: {
  workspaceDir: string;
  venvDir: string | null;
  scriptRelPath: string;
  cpuSeconds: number;
}): string[] {
  const python = opts.venvDir ? '/opt/venv/bin/python3' : '/usr/bin/python3';
  const args = [
    '--die-with-parent',
    '--unshare-all',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    // /etc read-only: glibc/ssl/fontconfig config. No user secrets live there
    // (the bot's .env is in /home, which is NOT mounted).
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', opts.workspaceDir, '/workspace',
    ...(opts.venvDir ? ['--ro-bind', opts.venvDir, '/opt/venv'] : []),
    '--chdir', '/workspace',
    '--setenv', 'HOME', '/workspace',
    '--setenv', 'PATH', opts.venvDir ? '/opt/venv/bin:/usr/bin:/bin' : '/usr/bin:/bin',
    '--setenv', 'PYTHONUNBUFFERED', '1',
    // matplotlib/fontconfig need writable caches — point them at the tmpfs.
    '--setenv', 'MPLCONFIGDIR', '/tmp/mpl',
    '--setenv', 'XDG_CACHE_HOME', '/tmp/cache',
    '--',
    '/bin/sh', '-c',
    // /bin/sh is dash: one option per ulimit call (a combined `ulimit -v … -t …`
    // fails with "too many arguments" and silently drops ALL the limits).
    // -f is in 512-byte blocks: 2097152 ≈ 1 GiB per created file.
    `ulimit -v ${MEMORY_LIMIT_KB}; ulimit -t ${opts.cpuSeconds}; ulimit -f 2097152; exec ${python} ${opts.scriptRelPath}`,
  ];
  return args;
}

/** Run `code` as a python script inside the sandbox. */
export async function runPython(code: string, opts: SandboxOptions): Promise<SandboxRunResult> {
  if (!sandboxAvailable()) {
    throw new Error(
      'bwrap no está instalado en el host — la ejecución de código está deshabilitada (instala bubblewrap).',
    );
  }
  const maxOut = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const runDir = join(opts.workspaceDir, RUN_DIR);
  // Rebuild the staging dir from scratch every run instead of `mkdir -p`-ing
  // whatever is there. A previous run's python could have left `.workshop` as a
  // SYMLINK (recursive mkdir happily accepts an existing link-to-dir), and the
  // script write below — which happens in the bot process, outside the sandbox
  // — would then follow it and write user-supplied code anywhere the bot can
  // write. `rmSync` unlinks a symlink rather than following it, so what mkdir
  // creates next is always a real directory. The dir is wiped after each run
  // anyway (see `finish`), so nothing is lost.
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const scriptRel = `${RUN_DIR}/run.py`;
  writeFileSync(join(opts.workspaceDir, scriptRel), code, {
    encoding: 'utf-8',
    flag: 'wx', // fail if it somehow exists: never write through a leftover link
  });

  const cpuSeconds = Math.max(5, Math.ceil(opts.timeoutMs / 1000) + 5);
  const args = buildBwrapArgs({
    workspaceDir: opts.workspaceDir,
    venvDir: opts.venvDir,
    scriptRelPath: scriptRel,
    cpuSeconds,
  });

  const startedAt = Date.now();
  return new Promise<SandboxRunResult>((resolvePromise) => {
    const child = spawn(BWRAP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const cap = (cur: Buffer, chunk: Buffer): Buffer => {
      if (cur.length >= maxOut) {
        truncated = true;
        return cur;
      }
      const next = Buffer.concat([cur, chunk]);
      if (next.length > maxOut) {
        truncated = true;
        return next.subarray(0, maxOut);
      }
      return next;
    };
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));

    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const finish = (exitCode: number | null): void => {
      clearTimeout(killer);
      // Best-effort cleanup of the staged script; the dir is hidden anyway.
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolvePromise({
        stdout: stdout.toString('utf-8'),
        stderr: stderr.toString('utf-8'),
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    };

    child.on('error', (err) => {
      log.error({ err }, 'workshop.sandbox.spawn_failed');
      clearTimeout(killer);
      resolvePromise({
        stdout: '',
        stderr: `No pude lanzar el sandbox: ${err.message}`,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        truncated: false,
      });
    });
    child.on('close', (code) => finish(code));
  });
}
