import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapArgs, runPython, sandboxAvailable } from "../sandbox.js";

describe("buildBwrapArgs (the security contract)", () => {
   const args = buildBwrapArgs({
      workspaceDir: "/data/workshop/sessions/123",
      venvDir: "/data/workshop/venv",
      scriptRelPath: ".workshop/run.py",
      cpuSeconds: 35,
   });

   test("never mounts /home, /root or /var", () => {
      for (const forbidden of ["/home", "/root", "/var"]) {
         expect(args).not.toContain(forbidden);
      }
   });

   test("unshares all namespaces (incl. network) and dies with the parent", () => {
      expect(args).toContain("--unshare-all");
      expect(args).toContain("--die-with-parent");
   });

   test("workspace is the only writable bind; venv is read-only", () => {
      const bindIdx = args.indexOf("--bind");
      expect(args[bindIdx + 1]).toBe("/data/workshop/sessions/123");
      expect(args[bindIdx + 2]).toBe("/workspace");
      // exactly one rw --bind
      expect(args.filter((a) => a === "--bind")).toHaveLength(1);
      const roVenv = args.indexOf("/data/workshop/venv");
      expect(args[roVenv - 1]).toBe("--ro-bind");
      expect(args[roVenv + 1]).toBe("/opt/venv");
   });

   test("uses the venv python via PATH and sets rlimits", () => {
      const sh = args[args.length - 1];
      expect(sh).toContain("ulimit -v");
      expect(sh).toContain("/opt/venv/bin/python3 .workshop/run.py");
   });

   test("falls back to system python without a venv", () => {
      const noVenv = buildBwrapArgs({
         workspaceDir: "/w",
         venvDir: null,
         scriptRelPath: ".workshop/run.py",
         cpuSeconds: 10,
      });
      expect(noVenv[noVenv.length - 1]).toContain("/usr/bin/python3");
      expect(noVenv).not.toContain("/opt/venv");
   });
});

// Live integration — runs only where bwrap exists (the Pi; skipped elsewhere).
describe.skipIf(!sandboxAvailable())("runPython (live bwrap)", () => {
   test("runs code, writes to the workspace, and has no network", async () => {
      const ws = mkdtempSync(join(tmpdir(), "workshop-sbx-"));
      try {
         const result = await runPython(
            [
               'print("hello from sandbox")',
               'open("out.txt", "w").write("persisted")',
               "import socket",
               "try:",
               '    socket.create_connection(("1.1.1.1", 53), timeout=2)',
               '    print("NETWORK-OK")',
               "except OSError:",
               '    print("NETWORK-BLOCKED")',
               'import os; print("HOME-VISIBLE" if os.path.exists("/home") else "HOME-HIDDEN")',
            ].join("\n"),
            { workspaceDir: ws, venvDir: null, timeoutMs: 20_000 },
         );
         expect(result.exitCode).toBe(0);
         expect(result.stdout).toContain("hello from sandbox");
         expect(result.stdout).toContain("NETWORK-BLOCKED");
         expect(result.stdout).toContain("HOME-HIDDEN");
      } finally {
         rmSync(ws, { recursive: true, force: true });
      }
   }, 30_000);

   test("kills a runaway script at the timeout", async () => {
      const ws = mkdtempSync(join(tmpdir(), "workshop-sbx-"));
      try {
         const result = await runPython(
            "import time\nwhile True: time.sleep(1)",
            {
               workspaceDir: ws,
               venvDir: null,
               timeoutMs: 3_000,
            },
         );
         expect(result.timedOut).toBe(true);
      } finally {
         rmSync(ws, { recursive: true, force: true });
      }
   }, 20_000);
});
