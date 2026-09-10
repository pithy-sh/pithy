// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The entry point for the shipped-declaration gate.
 *
 *   bun run dist-types                                # after a build, from the repository root
 *   bun packages/cli/src/ci/checkDistTypes.ts         # the same thing, as CI runs it
 *
 * The logic is in `./distTypes.ts`, which states what the gate reads and what it does not cover. This
 * file resolves the repository root, runs it, prints, and exits — the shape `scripts/license-headers.ts`
 * uses at the root, kept here for the reason `../docs/writeCatalog.ts` gives: a program that imports the
 * kit needs the CLI's own types and `node_modules`, and `scripts/` has neither.
 *
 * It runs in CI's whole-repo `verify` job, immediately after `Build`, because there is nothing to read
 * before `dist` exists.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDistTypes } from "./distTypes";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// A throw from here is the gate refusing to answer — an unbuilt package, a capability whose tables it
// cannot read, a population under its floor. Each of those already carries the sentence a reader needs,
// so it is printed as one rather than as a stack: the fault is in the tree, not in this file.
const { code, output } = await checkDistTypes(root).catch((failure: unknown) => ({
  code: 1,
  output: failure instanceof Error ? failure.message : String(failure),
}));

process[code === 0 ? "stdout" : "stderr"].write(`${output}\n`);
process.exit(code);
