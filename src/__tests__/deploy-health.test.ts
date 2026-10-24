import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("deploy health drains a verbose ready journal under pipefail", () => {
   const script = readFileSync("deploy/pull-deploy.sh", "utf8");
   const filter = script.match(/\|\s*(grep[^\n]*READY_MARKER[^\n]*)/)?.[1];
   expect(filter).toBeDefined();
   const dir = mkdtempSync(join(tmpdir(), "deploy-health-"));
   try {
      const emitter = join(dir, "journal.cjs");
      writeFileSync(
         emitter,
         `const fs=require('node:fs');fs.writeSync(1,'Discord client ready\\n');for(let i=0;i<4096;i++)fs.writeSync(1,'x'.repeat(4096)+'\\n');`,
      );
      expect(() =>
         execFileSync(
            "/bin/bash",
            [
               "-o",
               "pipefail",
               "-c",
               `READY_MARKER='Discord client ready'; "$1" "$2" | ${filter}`,
               "--",
               process.execPath,
               emitter,
            ],
            { stdio: "pipe" },
         ),
      ).not.toThrow();
   } finally {
      rmSync(dir, { recursive: true, force: true });
   }
});
