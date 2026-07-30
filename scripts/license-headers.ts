/**
 * SPDX headers and LICENSE files, checked or repaired.
 *
 *   bun scripts/license-headers.ts --check            # the CI gate
 *   bun scripts/license-headers.ts --fix              # stamp the repo
 *   bun scripts/license-headers.ts --fix <paths...>   # stamp only these (lint-staged)
 *
 * The logic lives in `@pithy-sh/license-headers` rather than here, because `scripts/` sits in no
 * vitest project and nothing in it can be tested. This file is the entry point the docs name: it
 * resolves the repo root, runs, prints, and exits.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@pithy-sh/license-headers/src/cli";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { code, output } = run(process.argv.slice(2), root);

process.stdout.write(`${output}\n`);
process.exit(code);
