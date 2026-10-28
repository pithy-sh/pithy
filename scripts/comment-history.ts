/**
 * Lower `comment-history.jsonc` to match the tree, or write the first one.
 *
 *   bun scripts/comment-history.ts           # lower every count that fell; refuse any that rose
 *   bun scripts/comment-history.ts --init    # write the first baseline
 *
 * The rule and the writer live in `@pithy-sh/cli`'s `src/ci/commentHistory.ts`, where they are tested,
 * because `scripts/` sits in no vitest project.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommentHistory } from "../packages/cli/src/ci/commentHistory.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = runCommentHistory(root, process.argv.slice(2));

(result.code === 0 ? process.stdout : process.stderr).write(`${result.output}\n`);
process.exit(result.code);
