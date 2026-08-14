// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  offence,
  recordedExecutable,
  repair,
  repairedMode,
  type TrackedFile,
  trackedFiles,
  violations,
} from "./fileModes";

/**
 * **The gate for #345: no file this repository carries is world-writable, and none is executable
 * against what git records.**
 *
 * The rule, why it is that rule and not a stricter one, and why the exec bit on `bin.ts` is wanted
 * rather than removed, are all argued in `./fileModes.ts`. This file is the half that fails the build,
 * plus the half that proves the detector can say no — because a mode gate is the easiest kind of test to
 * write green over nothing, and `expect(violations).toEqual({})` is exactly what passing and vacuous
 * both look like.
 *
 * So, in the taxonomy `./sweepPopulation.test.ts` keeps: the permitted set here is a **frozen literal**
 * (shape 2), the population is pinned near-exactly rather than at a comfortable floor (shape 8), and the
 * detector is exercised against modes it must reject as well as ones it must accept (shape 3). The
 * repairer is run against a scratch repository rather than this one, deliberately — a test that repaired
 * the tree it then asserts about could never fail twice.
 */

/** The repository. This file lives at `packages/cli/src/ci/`; the anchors below fail if it moves. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/**
 * **Every file git records executable, by name and by reason.** Exact in both directions.
 *
 * Three, and each one is a program something else executes directly. A file joining this list is a file
 * somebody decided should be runnable, and that decision costs one line and one sentence here.
 */
const EXECUTABLE_ON_PURPOSE: Record<string, string> = {
  ".husky/commit-msg":
    "git runs the hook itself, by path. A hook without the bit is a hook that silently never runs, which is commitlint not enforcing anything.",
  ".husky/pre-commit": "The same, for the hook that runs Biome and the licence stamp over staged files.",
  "packages/cli/src/bin.ts":
    "The `pithy` bin, opening `#!/usr/bin/env bun`. bun links a workspace bin by symlinking `node_modules/.bin/pithy` straight at this source file rather than at a shim, so clearing the bit makes the link bun just created unrunnable (#345).",
};

/** The sweep, once. Every test below asks about the same listing. */
const FILES: TrackedFile[] = trackedFiles(REPO_ROOT);

describe("the sweep sees what git sees", () => {
  test("it reaches the index, including the dotted directories a source walk skips", () => {
    // A scan that silently reaches nothing passes every rule written under it (#185). Anchored on four
    // paths from four different corners of the tree, so a scan that collapsed to one package shows here.
    const paths = FILES.map(({ path }) => path);
    expect(paths).toContain("packages/cli/src/bin.ts");
    expect(paths).toContain("packages/cli/src/ci/fileModes.ts");
    expect(paths).toContain("templates/starter/package.json");
    expect(paths).toContain(".husky/pre-commit");
    expect(paths).toContain(".changeset/config.json");
  });

  test("and it reaches all of it — 2,371 paths as this is written, not a comfortable floor", () => {
    // Near-exact on purpose. `toBeGreaterThan(5)` against two thousand files is the shape of a guard
    // rather than a guard; this one fails if the listing loses three percent of the tree.
    expect(FILES.length).toBeGreaterThanOrEqual(2300);
  });

  test("and nothing .gitignore covers, so an installed dependency is not a finding", () => {
    expect(FILES.filter(({ path }) => path.includes("node_modules") || path.includes("/.smoke-"))).toEqual([]);
  });

  test("and every path it found is on disk, so the rule is quantified over real files", () => {
    // `mode: null` is how a path git names but the tree lacks arrives here, and every such path is one
    // the rule cannot speak about. A listing that was all nulls would satisfy every assertion below.
    expect(FILES.filter(({ mode }) => mode === null)).toEqual([]);
  });
});

describe("no file this repository carries is world-writable", () => {
  test("nor executable against what git records", () => {
    expect(
      violations(FILES),
      "`bun install` chmods the CLI entrypoint to 0777. Re-run `bun install` — the repo root's postinstall narrows it. If this names something else, the file's own permissions are the defect (#345).",
    ).toEqual({});
  });

  test("and the files git records executable are exactly the three written down here", () => {
    // Frozen literal, failing from both sides. A new executable is in neither list and shows up; one
    // that stopped being executable stops matching and shows up too, so the list cannot rot.
    const executable = FILES.filter(({ recorded }) => recorded === true).map(({ path }) => path);
    expect(executable, "an executable file is a decision. Name it in EXECUTABLE_ON_PURPOSE with the reason.").toEqual(
      Object.keys(EXECUTABLE_ON_PURPOSE).sort(),
    );
  });

  test("and each one says why, in a sentence somebody has to disagree with", () => {
    for (const [path, why] of Object.entries(EXECUTABLE_ON_PURPOSE)) {
      expect(why.trim().length, path).toBeGreaterThan(40);
    }
  });
});

describe("the detector says no", () => {
  /** One synthetic entry, so the detector is exercised on modes this tree does not currently hold. */
  function file(mode: number, recorded: boolean | null): TrackedFile {
    return { path: "probe", recorded, mode };
  }

  test("to the mode bun leaves behind, for both reasons at once", () => {
    // 0777 against git's 100644 is the reported defect exactly: world-writable, and executable when git
    // says it is not.
    const why = offence(file(0o777, false));
    expect(why).toContain("world-writable");
    expect(why).toContain("100644");
  });

  test("to world-writable even when git records the file executable", () => {
    // The half that would have been lost by fixing #345 with `git update-index --chmod=+x` alone: git
    // status goes quiet and `rwxrwxrwx` is still `rwxrwxrwx`.
    expect(offence(file(0o777, true))).toContain("world-writable");
    expect(offence(file(0o776, true))).toContain("world-writable");
  });

  test("and to group-write on a program, which is the tighter half of the rule", () => {
    // `0775` is what a checkout under umask 0002 writes, and it is refused on the three files git
    // records executable — the two hooks git runs by path, and the `pithy` entrypoint.
    expect(offence(file(0o775, true))).toContain("group-writable");
    expect(offence(file(0o755, true))).toBeNull();
    // And permitted on everything else, which is 2,368 files this checkout wrote at 0664.
    expect(offence(file(0o664, false))).toBeNull();
    expect(offence(file(0o664, null))).toBeNull();
  });

  test("to setuid, setgid and sticky", () => {
    expect(offence(file(0o4755, true))).not.toBeNull();
    expect(offence(file(0o2755, true))).not.toBeNull();
    expect(offence(file(0o1644, false))).not.toBeNull();
  });

  test("to an exec bit git does not record, and to a missing one it does", () => {
    expect(offence(file(0o755, false))).toContain("100644");
    expect(offence(file(0o644, true))).toContain("100755");
    // Any of the three is enough to make a file runnable by somebody.
    expect(offence(file(0o645, false))).not.toBeNull();
    expect(offence(file(0o654, false))).not.toBeNull();
  });

  test("and yes to what a checkout actually writes for an ordinary file, under either umask", () => {
    // 0002 and 0022 are the two this repository has seen. A gate red on the modes git itself writes for
    // 2,368 files is a gate muted within a day, and a muted gate is the defect it was built to catch,
    // shipping. The three it records executable are few enough to hold to 0755 instead.
    expect(offence(file(0o664, false))).toBeNull();
    expect(offence(file(0o644, false))).toBeNull();
    expect(offence(file(0o600, false))).toBeNull();
    // And an untracked file, which git records nothing about, is judged on width alone.
    expect(offence(file(0o755, null))).toBeNull();
    expect(offence(file(0o775, null))).toBeNull();
    expect(offence(file(0o777, null))).toContain("world-writable");
  });

  test("and a path it cannot stat is not a finding", () => {
    expect(offence(file(0, null))).toBeNull();
    expect(offence({ path: "gone", recorded: false, mode: null })).toBeNull();
  });
});

describe("the repair only ever narrows", () => {
  test("0777 becomes 0755 when git records the file executable, and 0664 when it does not", () => {
    // Acceptance criterion 1 of #345, as a unit: no write bit for group or for other.
    expect(repairedMode(true, 0o777)).toBe(0o755);
    expect(repairedMode(false, 0o777)).toBe(0o664);
  });

  test("it puts an execute bit only where a read bit already is", () => {
    // For an ordinary file the repair is not `chmod 644`. An absolute mode fights the umask of whoever
    // runs it and then disagrees with what `git checkout` writes on the next branch switch.
    expect(repairedMode(true, 0o600)).toBe(0o700);
    expect(repairedMode(true, 0o640)).toBe(0o750);
    // Except the owner's, which is unconditional — a file git records executable that nobody can read
    // would otherwise come back still not executable, which is the one thing the repair was asked for.
    expect(repairedMode(true, 0o000)).toBe(0o100);
    expect(repairedMode(true, 0o060)).toBe(0o150);
  });

  test("it clears setuid, setgid and sticky", () => {
    expect(repairedMode(true, 0o4777)).toBe(0o755);
    expect(repairedMode(false, 0o6666)).toBe(0o664);
  });

  test("it changes nothing that was already right, and running it twice changes nothing more", () => {
    for (const mode of [0o664, 0o644, 0o600, 0o400]) expect(repairedMode(false, mode)).toBe(mode);
    for (const mode of [0o755, 0o700, 0o500]) expect(repairedMode(true, mode)).toBe(mode);
    expect(repairedMode(true, repairedMode(true, 0o777))).toBe(0o755);
    expect(repairedMode(false, repairedMode(false, 0o777))).toBe(0o664);
  });

  test("and never widens: no bit is set that was not set before, apart from an execute bit git asked for", () => {
    for (let mode = 0; mode <= 0o777; mode += 1) {
      for (const executable of [true, false]) {
        const repaired = repairedMode(executable, mode);
        expect(repaired & ~mode & ~(executable ? 0o111 : 0), `0${mode.toString(8)}`).toBe(0);
        expect(offence({ path: "probe", recorded: executable, mode: repaired }), `0${mode.toString(8)}`).toBeNull();
      }
    }
  });
});

describe("and it repairs a real tree", () => {
  /**
   * A scratch repository, not this one.
   *
   * `repair(REPO_ROOT)` inside a test would fix the very file the gate above asserts about, which makes
   * the gate green on the second run whatever happened on the first — a test that cannot fail twice.
   */
  const scratch = mkdtempSync(join(tmpdir(), "pithy-file-modes-"));

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("the file bun would have left at 0777 comes back narrow, and the tree with it", () => {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: scratch, encoding: "utf8" });
    run("init", "-q");
    writeFileSync(join(scratch, "plain.ts"), "export const a = 1;\n", { mode: 0o644 });
    writeFileSync(join(scratch, "bin.ts"), "#!/usr/bin/env bun\n", { mode: 0o755 });
    run("add", "plain.ts", "bin.ts");

    // Exactly what the install does to the entrypoint, and what it would do to a neighbour.
    chmodSync(join(scratch, "bin.ts"), 0o777);
    chmodSync(join(scratch, "plain.ts"), 0o777);
    expect(Object.keys(violations(trackedFiles(scratch)))).toEqual(["bin.ts", "plain.ts"]);

    expect(repair(scratch)).toEqual(["bin.ts", "plain.ts"]);
    expect(lstatSync(join(scratch, "bin.ts")).mode & 0o7777).toBe(0o755);
    expect(lstatSync(join(scratch, "plain.ts")).mode & 0o7777).toBe(0o664);
    expect(violations(trackedFiles(scratch))).toEqual({});

    // Idempotent: a second install has nothing left to do.
    expect(repair(scratch)).toEqual([]);
  });
});

describe("a mode nobody has written a rule for is a question, not a skip", () => {
  test("git's regular and executable modes are read, and every other one throws", () => {
    expect(recordedExecutable("100644", "a.ts")).toBe(false);
    expect(recordedExecutable("100755", "a.ts")).toBe(true);
    // A symlink and a submodule are both things git can record and this repository has neither. Skipping
    // them silently is how a sweep shrinks as the tree grows; the throw asks whoever adds the first one.
    expect(() => recordedExecutable("120000", "link.ts")).toThrow(/120000/);
    expect(() => recordedExecutable("160000", "sub")).toThrow(/160000/);
    expect(() => recordedExecutable("100664", "odd.ts")).toThrow(/no rule for it/);
  });
});
