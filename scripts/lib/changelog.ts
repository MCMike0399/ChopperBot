// CHANGELOG.md parsing, shared by the Discord publisher (scripts/publish-release.ts)
// and the GitHub release workflow (scripts/release-notes.ts). Deliberately free of
// `src/config.ts` so it runs in CI without the bot's env.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface ReleaseSection {
   version: string;
   date: string; // YYYY-MM-DD as written in the changelog
   body: string; // markdown between this header and the next version header
}

export function changelogPath(): string {
   const here = dirname(fileURLToPath(import.meta.url));
   return join(here, "..", "..", "CHANGELOG.md");
}

export function readChangelog(): ReleaseSection[] {
   return parseChangelog(readFileSync(changelogPath(), "utf8"));
}

/** Parse every `## <version> — <date>` section out of CHANGELOG.md, newest first. */
export function parseChangelog(md: string): ReleaseSection[] {
   const lines = md.split("\n");
   const headerRe = /^##\s+(\d+\.\d+\.\d+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/;
   const sections: ReleaseSection[] = [];
   let current: ReleaseSection | null = null;
   let buf: string[] = [];
   const flush = () => {
      if (current) {
         current.body = buf.join("\n").trim();
         sections.push(current);
      }
   };
   for (const line of lines) {
      const m = headerRe.exec(line);
      if (m) {
         flush();
         current = { version: m[1], date: m[2], body: "" };
         buf = [];
         continue;
      }
      if (current) {
         // A horizontal rule separates versions in the changelog — don't carry it.
         if (line.trim() === "---") continue;
         buf.push(line);
      }
   }
   flush();
   return sections;
}
