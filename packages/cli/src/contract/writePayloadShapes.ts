// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Write `payloadShapes.generated.json` — every command's `--json` keys at its `schemaVersion` (#697).
 *
 * The same shape as `../docs/writeCatalog.ts`, and under `src/` for the reason it gives: building the shapes
 * means composing the real command tree. `payloadShapes.test.ts` fails while the file is stale, and this is
 * what it asks you to run.
 *
 * **It refuses to record a break.** A key removed or retyped while its command's `schemaVersion` stood still
 * is what the file exists to catch, so writing it over would be the check signing off on itself. The refusal
 * names the command to bump; bump it, and the next run writes.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../main";
import { readOptionalFile } from "../project/readOptionalFile";
import { EXIT } from "../terminal/exitClass";
import {
  breakingChanges,
  PAYLOAD_SHAPES_PATH,
  type PayloadShapes,
  payloadShapesOf,
  renderPayloadShapes,
} from "./payloadShapes";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const path = join(REPO_ROOT, PAYLOAD_SHAPES_PATH);
const current = await payloadShapesOf(main);
const expected = renderPayloadShapes(current);
const actual = await readOptionalFile(path);

const broken = actual === null ? [] : breakingChanges(JSON.parse(actual) as PayloadShapes, current);

if (broken.length > 0) {
  for (const line of broken) process.stderr.write(`${line}\n`);
  process.exit(EXIT.failed);
} else if (actual === expected) {
  process.stdout.write(`${PAYLOAD_SHAPES_PATH} is current.\n`);
} else {
  writeFileSync(path, expected);
  process.stdout.write(`Wrote ${PAYLOAD_SHAPES_PATH}.\n`);
}
