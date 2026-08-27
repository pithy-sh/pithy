// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Write `docs/catalog.generated.json` — what the kit contains, for the docs site's own check.
 *
 * See `./catalog.ts` for why the export exists and why it is strict JSON. This is the writer, and it is
 * the same shape as `scripts/stampVersions.ts` at the repository root, for the same reason: the file is
 * **committed**, so a consumer that is neither this repository nor an installer of it can read it with
 * no build step — and a committed generated file is exactly the kind that goes stale quietly.
 *
 * `--check` fails instead of writing, and runs in CI's whole-repo verify job beside the stamped
 * versions. Drift here is a docs check reporting `ok` against a kit that has moved: every page passes,
 * and the pages are wrong.
 *
 * **It lives under `src/`, not `scripts/`, and that is forced.** `scripts/tsconfig.json` is a Node-only
 * program — `types: ["node"]`, no Workers types — because nothing it holds may drag the CLI's graph in
 * behind it. Building the catalog means composing the real command tree, which reaches every capability
 * package and every `CryptoKey` and `HTMLRewriter` in them. So the entry script belongs in the program
 * that already has those types, exactly as `bin.ts` does.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOptionalFile } from "../project/readOptionalFile";
import { buildDocsCatalog, CATALOG_PATH, renderDocsCatalog } from "./catalog";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const path = join(REPO_ROOT, CATALOG_PATH);
const expected = renderDocsCatalog(await buildDocsCatalog());

// `readOptionalFile`, not a swallowed `readFileSync`: absent means "write it", and every other failure
// has to be loud. A discarded permission error would make `--check` report drift it could not see and
// a plain run overwrite a file it never read.
const actual = await readOptionalFile(path);

if (actual === expected) {
  process.stdout.write(`${CATALOG_PATH} is current.\n`);
} else if (process.argv.includes("--check")) {
  process.stderr.write(`${CATALOG_PATH} is stale. Run \`bun run docs-catalog\`.\n`);
  process.exit(1);
} else {
  writeFileSync(path, expected);
  process.stdout.write(`Wrote ${CATALOG_PATH}.\n`);
}
