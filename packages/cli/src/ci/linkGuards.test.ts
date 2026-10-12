// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, relative, resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { isTestFile, readSource, sourcePaths } from "./sourceFiles";

/**
 * **"Is this path a link?" is asked through one seam: `project/linkView.ts` (#697).**
 *
 * A dry run works in a copy of the project where a link out of it to a directory is a snapshot of that
 * directory — a real directory, so the command can read and write it without touching the adopter's files.
 * Every guard that refuses a path *because it is a link* would then answer for the copy rather than the
 * project, and plan a success the real run refuses: the scaffold gate's `apps/api/src/routes is a symlink.`
 * became a planned scaffold. The seam answers for a snapshot with the link's own `lstat`, and asks plain
 * `lstat` everywhere else.
 *
 * So a module that asks `isSymbolicLink()` asks it of what the seam returned. Two are allowed to ask the disk
 * directly, each for a reason that is not the guard's:
 *
 * - `plan/shadow.ts` makes the copy. It reads the project as it is, and is what registers the snapshots.
 * - `platform/rc.ts` guards the user's shell rc file, in their home directory. No project, and no dry run.
 *
 * The atomic writer follows real links itself, and checks each one's owner; it asks the seam for the owner of a
 * snapshot, which is why it is held to the same rule rather than excused from it.
 */

/** The CLI's source root. */
const SRC = resolve(import.meta.dirname, "..");

/** The modules that may ask the disk itself, and why — see the header. */
const ASKS_THE_DISK = new Set(["plan/shadow.ts", "platform/rc.ts"]);

/** A guard's question: is this a link? */
const LINK_QUESTION = /\.isSymbolicLink\(\)/;

/** What a module asking through the seam calls. */
const SEAM_CALL = /\b(?:lstatAsProject|linkStandingAt)\(/;

/** Every shipped source under `src/`, comments blanked so prose about links is not read as code. */
function shippedSources(): { path: string; code: string }[] {
  return (
    sourcePaths(SRC)
      .filter((path) => (path.endsWith(".ts") || path.endsWith(".tsx")) && !isTestFile(basename(path)))
      // A test's helpers read the fixtures they built, and no command reaches them.
      .filter((path) => !relative(SRC, path).startsWith("test-utils"))
      .flatMap((path) => {
        const source = readSource(path);
        return source === null
          ? []
          : [{ path: relative(SRC, path).split("\\").join("/"), code: blankComments(source) }];
      })
  );
}

/** The modules that ask whether a path is a link without asking the seam, as `src`-relative paths. */
function offenders(sources: readonly { path: string; code: string }[]): string[] {
  return sources
    .filter(({ path, code }) => !ASKS_THE_DISK.has(path) && LINK_QUESTION.test(code) && !SEAM_CALL.test(code))
    .map(({ path }) => path);
}

describe("link guards ask through the seam", () => {
  const sources = shippedSources();

  test("every module that asks whether a path is a link asks project/linkView.ts", () => {
    expect(offenders(sources)).toEqual([]);
  });

  test("the rule has something to hold: the guards a dry run reaches are among the askers", () => {
    const askers = sources.filter(({ code }) => LINK_QUESTION.test(code)).map(({ path }) => path);
    expect(askers.length).toBeGreaterThan(4);
    expect(askers).toEqual(expect.arrayContaining(["project/scaffold.ts", "project/atomic.ts"]));
    for (const excused of ASKS_THE_DISK) expect(askers, excused).toContain(excused);
  });

  test("a planted guard that asks lstat itself is caught", () => {
    const planted = {
      path: "project/planted.ts",
      code: 'const entry = await lstat(path);\nif (entry.isSymbolicLink()) throw new Error("a link");\n',
    };
    expect(offenders([planted])).toEqual(["project/planted.ts"]);
    const routed = { ...planted, code: planted.code.replace("lstat(", "lstatAsProject(") };
    expect(offenders([routed])).toEqual([]);
  });
});
