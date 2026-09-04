/**
 * Release records, the four steps of them.
 *
 *   bun scripts/releaseRecords.ts snapshot   # before `changeset version` — it deletes the changesets
 *   bun scripts/releaseRecords.ts build      # after it, joining the snapshot to the new versions
 *   bun scripts/releaseRecords.ts post       # to the dashboard, or a line saying it is off
 *   bun scripts/releaseRecords.ts replay     # rebuild from the changelogs, to recover a failed write
 *
 * The logic lives in `@pithy-sh/release` rather than here, because `scripts/` sits in no vitest project
 * and nothing in it can be tested. This file is the entry point `release.yml` names: it resolves the
 * repo root, runs, prints, and exits.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@pithy-sh/release/src/cli";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { code, output } = await run(process.argv.slice(2), { root, env: process.env });

process.stdout.write(`${output}\n`);
process.exit(code);
