/**
 * Refuse a Bun older than the root manifest's `engines.bun`, before anything runs `bun check`.
 *
 *   bun scripts/bunFloor.ts          # the first half of the root `typecheck`
 *
 * The rule lives in `@pithy-sh/cli`'s `src/ci/bunFloor.ts`, where it is tested, because `scripts/` sits in
 * no vitest project. This file reads the two versions, and says nothing unless the running Bun is too old.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunFloorRefusal } from "../packages/cli/src/ci/bunFloor.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { engines?: { bun?: string } };
const refusal = bunFloorRefusal(Bun.version, manifest.engines?.bun ?? "");

if (refusal) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}
