/**
 * Narrow any file this repository carries that is world-writable, setuid, or executable against what
 * git records.
 *
 *   bun scripts/fileModes.ts          # the repo root's postinstall
 *
 * It exists because `bun install` chmods `packages/cli/src/bin.ts` to `0777` — the only `bin` in the
 * workspace, linked into `tooling/browser-scopes/node_modules/.bin/pithy` by a symlink onto the source
 * file. `rwxrwxrwx` on the program that reads an adopter's dev secrets, and a mode change git reports
 * in every worktree from the moment it is cut (#345).
 *
 * The rule and the repair live in `@pithy-sh/cli`'s `src/ci/fileModes.ts`, next to the gate that fails
 * the build when one of them lands, because `scripts/` sits in no vitest project and nothing in it can
 * be tested. This file is the entry point `postinstall` names: it resolves the repo root, runs, and
 * says only what it changed. The same reason, and the same shape, as `scripts/license-headers.ts`.
 *
 * Because it is the install that breaks the mode, it is the install that repairs it. A worktree already
 * carrying the change is corrected by re-running `bun install`, not by hand.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repair } from "../packages/cli/src/ci/fileModes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixed = repair(root);

if (fixed.length > 0) {
  process.stdout.write(`Narrowed ${fixed.length} file mode(s): ${fixed.join(", ")}\n`);
}
