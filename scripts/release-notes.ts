// Print the CHANGELOG.md section for a version as GitHub release notes.
// Used by .github/workflows/ci.yml to create the `vX.Y.Z` tag + GitHub Release;
// exits 1 when the version has no changelog section, so a version bump without
// release notes fails the release job instead of shipping an empty release.
//
// Usage:
//   tsx scripts/release-notes.ts            # the version in package.json
//   tsx scripts/release-notes.ts 2.7.0      # a specific version
import { readFileSync } from "node:fs";
import { readChangelog } from "./lib/changelog.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
   version: string;
};
const version = process.argv[2] ?? pkg.version;
const section = readChangelog().find((s) => s.version === version);
if (!section || !section.body) {
   console.error(
      `CHANGELOG.md has no "## ${version} — YYYY-MM-DD" section with content. ` +
         `Add the community release notes before bumping package.json.`,
   );
   process.exit(1);
}
process.stdout.write(`${section.body}\n`);
