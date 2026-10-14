// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Write `docs/openapi.generated.json` — the kit's own OpenAPI document, every route every capability ships.
 *
 * See `./kitDocument.ts` for what is composed and why. This is the writer, and it is the same shape as
 * `../docs/writeCatalog.ts`, under `src/` for the reason that file gives: composing the kit reaches every
 * capability package and every Workers type in them, so the entry script belongs in the program that
 * already has those types.
 *
 * `--check` fails instead of writing. `kitDocument.test.ts` fails on the same drift, so a stale document
 * is red in the CLI's own suite whether or not a CI step runs this.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOptionalFile } from "../project/readOptionalFile";
import { EXIT } from "../terminal/exitClass";
import {
  KIT_CONTRACT_PATH,
  KIT_SOCKET_CONTRACT_PATH,
  kitComposition,
  kitDocument,
  kitSocketDocument,
  kitSocketGroups,
} from "./kitDocument";
import { renderDocument } from "./workerContract";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const { capabilities, groups } = kitComposition();
const documents = [
  { file: KIT_CONTRACT_PATH, expected: renderDocument(kitDocument(groups)) },
  { file: KIT_SOCKET_CONTRACT_PATH, expected: renderDocument(kitSocketDocument(kitSocketGroups(capabilities))) },
];

let stale = false;
for (const { file, expected } of documents) {
  const path = join(REPO_ROOT, file);
  // `readOptionalFile`, not a swallowed `readFileSync`: absent means "write it", and every other failure has
  // to be loud, for the reason `writeCatalog.ts` gives.
  const actual = await readOptionalFile(path);
  if (actual === expected) {
    process.stdout.write(`${file} is current.\n`);
  } else if (process.argv.includes("--check")) {
    process.stderr.write(`${file} is stale. Run \`bun run kit-contract\`.\n`);
    stale = true;
  } else {
    writeFileSync(path, expected);
    process.stdout.write(`Wrote ${file}.\n`);
  }
}
if (stale) process.exit(EXIT.failed);
