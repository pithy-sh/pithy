// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { describePlan, generatedChangelogs, type PreflightInputs, preflight } from "./localRelease";
import type { ReleaseRecord } from "./records";

const READY: PreflightInputs = {
  branch: "main",
  dirty: [],
  fetched: true,
  behind: 0,
  npmUser: "kingmesal",
  githubToken: "gho_x",
  changesets: 381,
};

function record(over: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    package: "@pithy-sh/auth",
    version: "0.1.0",
    major: 0,
    minor: 1,
    patch: 0,
    prerelease: null,
    bump: "minor",
    published: "2026-09-01T00:00:00.000Z",
    note: "A note.",
    security: false,
    exposure: null,
    ...over,
  };
}

describe("preflight", () => {
  it("passes on a clean, current checkout of main with someone logged in", () => {
    expect(preflight(READY)).toEqual([]);
  });

  it("refuses a branch that is not main", () => {
    expect(preflight({ ...READY, branch: "feature/92-release" })).toEqual([
      expect.stringContaining("feature/92-release"),
    ]);
  });

  // The dry run restores the tree with `git restore -- .`, which discards every uncommitted change in
  // it. That is only safe because nothing uncommitted is allowed to be there in the first place.
  it("refuses a dirty tree, because the dry run's restore would discard it", () => {
    const problems = preflight({ ...READY, dirty: [" M packages/core/src/index.ts", "?? scratch.ts"] });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/uncommitted/i);
    expect(problems[0]).toMatch(/2 files/);
  });

  // The one input that used to fail open, guarding the one irreversible operation. `capture()` returns
  // null on any git failure, and reading that as an empty tree would restore over uncommitted work.
  it("refuses when it could not read the working tree at all", () => {
    expect(preflight({ ...READY, dirty: null })).toEqual([expect.stringContaining("working tree")]);
  });

  it("refuses an unreadable working tree on a dry run too, where the restore actually happens", () => {
    expect(preflight({ ...READY, dirty: null }, { publishing: false })).toHaveLength(1);
  });

  it("refuses a checkout behind the remote", () => {
    expect(preflight({ ...READY, behind: 3 })).toEqual([expect.stringContaining("3 commits behind")]);
  });

  // Offline is not current. Reading a failed fetch as "0 behind" publishes a stale tree in silence.
  it("refuses when it could not reach the remote at all", () => {
    expect(preflight({ ...READY, fetched: false })).toEqual([expect.stringContaining("origin")]);
  });

  it("does not also complain about a commit count it could not read", () => {
    expect(preflight({ ...READY, fetched: false, behind: 0 })).toHaveLength(1);
  });

  it("refuses when nobody is logged in to npm", () => {
    expect(preflight({ ...READY, npmUser: null })).toEqual([expect.stringContaining("npm login")]);
  });

  it("refuses without a GitHub token, which changeset version needs to attribute changesets", () => {
    expect(preflight({ ...READY, githubToken: null })).toEqual([expect.stringContaining("GITHUB_TOKEN")]);
  });

  it("refuses a release with nothing to release", () => {
    expect(preflight({ ...READY, changesets: 0 })).toEqual([expect.stringContaining("no changesets")]);
  });

  it("reports every problem at once rather than one per run", () => {
    expect(
      preflight({
        branch: "wip",
        dirty: ["?? x"],
        fetched: true,
        behind: 1,
        npmUser: null,
        githubToken: null,
        changesets: 0,
      }),
    ).toHaveLength(6);
  });
});

describe("preflight for a dry run", () => {
  const DRY = { publishing: false };

  // A dry run publishes nothing and pushes nothing. Holding it to a branch, a remote and an npm
  // session would block the one command whose whole purpose is finding out what would ship.
  it("does not ask for a branch, a remote or an npm session", () => {
    const problems = preflight(
      { ...READY, branch: "feature/92-release", fetched: false, behind: 9, npmUser: null },
      DRY,
    );

    expect(problems).toEqual([]);
  });

  // It restores the tree, so this is the one it needs more than a real release does.
  it("still refuses a dirty tree", () => {
    expect(preflight({ ...READY, dirty: ["?? scratch.ts"] }, DRY)).toHaveLength(1);
  });

  it("still needs a token, because changeset version will not run without one", () => {
    expect(preflight({ ...READY, githubToken: null }, DRY)).toEqual([expect.stringContaining("GITHUB_TOKEN")]);
  });

  it("still needs something to release", () => {
    expect(preflight({ ...READY, changesets: 0 }, DRY)).toEqual([expect.stringContaining("no changesets")]);
  });
});

describe("describePlan", () => {
  it("names each package, its version and its bump", () => {
    const plan = describePlan([record(), record({ package: "@pithy-sh/core", version: "0.2.0", minor: 2 })]);

    expect(plan).toContain("@pithy-sh/auth");
    expect(plan).toContain("0.1.0");
    expect(plan).toContain("minor");
    expect(plan).toContain("@pithy-sh/core");
    expect(plan).toContain("2 packages");
  });

  it("marks a security-relevant release so it cannot be skimmed past", () => {
    const plan = describePlan([record({ security: true, exposure: "The exposure." })]);

    expect(plan).toContain("security");
  });

  it("says so when a release would ship a major", () => {
    const plan = describePlan([record({ package: "@pithy-sh/payments", version: "1.0.0", major: 1, bump: "major" })]);

    expect(plan).toContain("1.0.0");
    expect(plan).toContain("major");
  });

  it("says plainly when nothing would ship", () => {
    expect(describePlan([])).toMatch(/nothing/i);
  });
});

describe("generatedChangelogs", () => {
  // The dry run deletes exactly the changelogs it created. A set difference rather than a glob,
  // because deleting a CHANGELOG that was already committed is not recoverable from the tree.
  it("names only the files that were not there before", () => {
    const before = ["packages/auth/CHANGELOG.md"];
    const after = ["packages/auth/CHANGELOG.md", "packages/core/CHANGELOG.md", "packages/cli/CHANGELOG.md"];

    expect(generatedChangelogs(before, after)).toEqual(["packages/core/CHANGELOG.md", "packages/cli/CHANGELOG.md"]);
  });

  it("names nothing when every changelog already existed", () => {
    const both = ["packages/auth/CHANGELOG.md"];

    expect(generatedChangelogs(both, both)).toEqual([]);
  });

  it("never names a file that disappeared", () => {
    expect(generatedChangelogs(["packages/auth/CHANGELOG.md"], [])).toEqual([]);
  });
});
