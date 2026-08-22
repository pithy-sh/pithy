// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **A JSONC document Pithy re-emits goes through the one printer, or it is not Pithy's to write.**
 *
 * #249 fixed the shape of that output: `comment-json`'s `stringify` puts every array element on its own
 * line, the Biome the kit scaffolds collapses a short one, so a config the CLI wrote failed the
 * pre-commit hook the CLI installed — and a two-line edit arrived as a whole-file reformat nobody could
 * review. `project/jsonc.ts` is the fix and `ui/formatting.test.ts` proves it for `pithy ui`.
 *
 * This is the *class*. Every producer of that defect has the same shape — parse a JSONC file, mutate the
 * tree, `stringify` it, write the bytes — and there have been four of them in three directories. A gate
 * naming files would have missed `provision/wranglerEnv.ts`, which did not exist when #249 landed and
 * reintroduced the bug the same week.
 *
 * `parse` is untouched — reading a JSONC document is what every one of these modules is for.
 *
 * ## Why the rule moved off the write verb
 *
 * It used to be *imports `stringify` **and** calls `writeFile(` or `writeFileAtomic(`*, which is a rule
 * about two spellings of a call rather than about the call. `writeFileSync`, `appendFile`,
 * `createWriteStream`, an `fs.writeFile` through a namespace import, or a helper one layer down all emit
 * the same bytes and none of them were seen — and this repository has already watched an escape class
 * arrive as three different verbs while the gate enumerated verbs.
 *
 * So the write half is gone entirely, and what is left is the property that has no spellings to miss:
 * **the set of modules that can reach `comment-json`'s `stringify` at all is this list.** Reaching it
 * without emitting a file is legitimate and rare, so the one module that does it is named here with its
 * reason rather than inferred from what it does afterwards. A fifth producer is caught by its import,
 * before it has written a byte.
 *
 * The extractor is the other half, and it **refuses what it cannot name**. A `comment-json` import in a
 * form it does not recognize throws rather than returning "does not reach stringify" — a sweep whose
 * unrecognised case is silently empty cannot observe the thing it was built for.
 */

const CLI_SRC = join(import.meta.dirname, "..");

/** The one module allowed to serialize, plus the exceptions that are still open, each with its reason. */
const ALLOWED = new Map<string, string>([
  ["project/jsonc.ts", "the printer itself — this is where `stringify` is supposed to be"],
  [
    "project/appWorkflows.ts",
    // Reaches `stringify` and emits nothing. `stringify(stanza) !== stanzaBefore` is how it knows
    // whether it changed anything, and the bytes go out through `writeWranglerConfig` — the printer.
    // Serializing for a comparison is not emitting a file, and a gate that could not tell the two apart
    // would be a gate somebody turns off. Named rather than inferred: the old rule inferred it from the
    // absence of a write verb, which is what made the verb list load-bearing.
    "serializes to compare two trees, never to emit — the bytes go out through project/jsonc.ts",
  ],
  [
    "devSecrets/file.ts",
    // Listed rather than excused, and asserted exactly, so closing it fails this test until the list
    // shrinks with it. `.dev.secrets.jsonc` is scaffolded, Biome formats it since #249 stopped exempting
    // Pithy's own files, and this writer still emits `stringify`'s shape. It is `0o600` and hand-edited,
    // so the diff cost is lower than `wrangler.jsonc`'s — which is why it is a backlog item and not a
    // reason to weaken the rule.
    "still writes `stringify`'s shape for .dev.secrets.jsonc — open, tracked, and not a license",
  ],
]);

/** Every import form this extractor understands. An eighth spelling is a hole, so it throws instead. */
const COMMENT_JSON_IMPORT =
  /^import\s+(?:(\*\s+as\s+\w+)|(\{[^}]*\})|(\w+))\s+from\s+"comment-json";$|^import\s+"comment-json";$/;

/**
 * Whether a module can reach `comment-json`'s `stringify`, under whatever name it gave it.
 *
 * Throws on a `comment-json` import it cannot classify — a namespace import, a `require`, a dynamic
 * `import()`, a default import used as an object. None of those is in the tree today; the point is that
 * the day one arrives this file goes red rather than quietly answering "no".
 */
function reachesStringify(path: string, source: string): boolean {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  let reaches = false;
  for (const line of withoutComments.split("\n")) {
    if (!/\bfrom\s+"comment-json"|import\s+"comment-json"/.test(line) && !/["']comment-json["']/.test(line)) continue;
    const statement = line.trim();
    const match = COMMENT_JSON_IMPORT.exec(statement);
    if (!match) {
      throw new Error(
        `${path} reaches comment-json in a form this gate cannot classify: ${statement}\nTeach the extractor this form — a shape it cannot read is a producer it cannot catch.`,
      );
    }
    const namespace = match[1];
    const named = match[2];
    const fallback = match[3];
    if (namespace || fallback) {
      // A whole-module binding can reach anything on it, so it counts unless the module never mentions
      // the member. Erring towards reporting is the right side to err on for a gate.
      const binding = (namespace ?? fallback ?? "").replace(/^\*\s+as\s+/, "");
      if (new RegExp(`\\b${binding}\\s*\\.\\s*stringify\\b`).test(withoutComments)) reaches = true;
      continue;
    }
    if (!named) continue;
    for (const specifier of named.slice(1, -1).split(",")) {
      const [imported, local] = specifier.split(/\s+as\s+/).map((part) => part.trim());
      if (imported !== "stringify") continue;
      if (new RegExp(`\\b${local ?? imported}\\s*\\(`).test(withoutComments)) reaches = true;
    }
  }
  return reaches;
}

describe("a JSONC document Pithy re-emits goes through the one printer", () => {
  // The shared walker (#185), not a hand-rolled one. Its default `keep` is already this rule — a
  // shipped `.ts`, neither a test nor a declaration — and it hands back the text, so nothing here
  // reads a file twice. A walk written out again here would be the defect this repository has paid
  // for five times, in the gate built to stop the sixth.
  const files = sourceFiles(CLI_SRC);

  it("finds the CLI's sources", () => {
    // Non-vacuity, near-exact rather than a comfortable floor: the CLI holds 192 shipped modules as this
    // is written, and a walk returning 101 of them would be green while missing half the package.
    expect(files.length).toBeGreaterThanOrEqual(185);
    expect(files.some((file) => file.path.endsWith(join("project", "jsonc.ts")))).toBe(true);
    expect(files.some((file) => file.path.endsWith(join("provision", "wranglerEnv.ts")))).toBe(true);
  });

  it("only the printer, and the exceptions this file names, can reach comment-json's stringify", () => {
    const serializers = files
      .filter((file) => reachesStringify(relative(CLI_SRC, file.path), file.text))
      .map((file) => relative(CLI_SRC, file.path).split("\\").join("/"))
      .sort();
    expect(
      serializers,
      "A module reaching `comment-json`'s `stringify` re-emits a JSONC document the adopter has to read the diff of. Route it through `project/jsonc.ts`, or add it here with the reason it is an exception.",
    ).toEqual([...ALLOWED.keys()].sort());
  });

  it("the extractor sees every spelling it is asked about, and refuses the ones it is not", () => {
    // The gate over the gate. `reachesStringify` is the whole check, so a form it reads as "no" is a
    // producer the check above cannot report — and a bare `writeFileSync` beside a `stringify` was
    // exactly that under the previous rule.
    expect(reachesStringify("named.ts", 'import { stringify } from "comment-json";\nstringify(tree);')).toBe(true);
    expect(reachesStringify("aliased.ts", 'import { stringify as print } from "comment-json";\nprint(tree);')).toBe(
      true,
    );
    expect(reachesStringify("parseonly.ts", 'import { parse } from "comment-json";\nJSON.stringify(x);')).toBe(false);
    expect(reachesStringify("commented.ts", '// import { stringify } from "comment-json";')).toBe(false);
    // The unnameable case throws rather than answering "no".
    expect(() =>
      reachesStringify("namespaced.ts", 'const json = require("comment-json");\njson.stringify(x);'),
    ).toThrow(/cannot classify/);
  });
});
