// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog";

// What `@changesets/changelog-github` actually writes: an attribution prefix on each bullet, the body
// of the changeset indented under it, and a dependency roll-up with no note of its own.
const REAL = `# @pithy-sh/auth

## 1.4.2

### Patch Changes

- [#471](https://github.com/pithy-sh/pithy/pull/471) [\`abc1234\`](https://github.com/pithy-sh/pithy/commit/abc1234) Thanks [@kingmesal](https://github.com/kingmesal)! - Refresh-token reuse now revokes the whole family.

  A longer paragraph nobody reads as the note.

  Security: a revoked refresh token stayed valid until its natural expiry.

- Updated dependencies [[\`def5678\`](https://github.com/pithy-sh/pithy/commit/def5678)]:
  - @pithy-sh/core@1.5.0

## 1.4.1

### Patch Changes

- A note with no attribution prefix at all.
`;

describe("parseChangelog", () => {
  it("reads the package name from the title", () => {
    expect(parseChangelog(REAL).every((entry) => entry.package === "@pithy-sh/auth")).toBe(true);
  });

  it("reads one entry per released version, newest first", () => {
    expect(parseChangelog(REAL).map((entry) => entry.version)).toEqual(["1.4.2", "1.4.1"]);
  });

  it("strips the attribution prefix off a note", () => {
    expect(parseChangelog(REAL)[0]?.note).toBe("Refresh-token reuse now revokes the whole family.");
  });

  it("reads a note that carries no attribution prefix", () => {
    expect(parseChangelog(REAL)[1]?.note).toBe("A note with no attribution prefix at all.");
  });

  // The whole reason the marker is visible prose rather than a hidden field: once the changeset files
  // are consumed, the CHANGELOG in git is the durable record, and a missed write is recoverable.
  it("recovers the security flag and the exposure from the indented body", () => {
    expect(parseChangelog(REAL)[0]?.security).toBe(true);
    expect(parseChangelog(REAL)[0]?.exposure).toBe("A revoked refresh token stayed valid until its natural expiry.");
  });

  it("reads the bump from the changes heading", () => {
    expect(parseChangelog(REAL).map((entry) => entry.bump)).toEqual(["patch", "patch"]);
  });

  it("takes the highest bump when a version has more than one heading", () => {
    const text = [
      "# @pithy-sh/core",
      "",
      "## 1.5.0",
      "",
      "### Minor Changes",
      "",
      "- A feature.",
      "",
      "### Patch Changes",
      "",
      "- A fix.",
    ].join("\n");

    expect(parseChangelog(text)[0]?.bump).toBe("minor");
  });

  it("gathers every note in one version into one entry", () => {
    const text = ["# @pithy-sh/core", "", "## 1.5.0", "", "### Patch Changes", "", "- First.", "", "- Second."].join(
      "\n",
    );

    expect(parseChangelog(text)[0]?.note).toBe("First.\n\nSecond.");
  });

  // A version that only moved with its dependencies has a changelog section and no note of its own —
  // the same fact `joinRecords` records as `note: null`, so a replayed record matches a live one.
  it("leaves a dependency-only release with no note", () => {
    const text = [
      "# @pithy-sh/cli",
      "",
      "## 1.4.2",
      "",
      "### Patch Changes",
      "",
      "- Updated dependencies [[`abc`](url)]:",
      "  - @pithy-sh/core@1.5.0",
    ].join("\n");

    const [entry] = parseChangelog(text);
    expect(entry?.note).toBeNull();
    expect(entry?.security).toBe(false);
  });

  it("is empty for a changelog with no releases in it", () => {
    expect(parseChangelog("# @pithy-sh/core\n")).toEqual([]);
  });

  it("refuses a changelog with no package title", () => {
    expect(() => parseChangelog("## 1.0.0\n\n### Patch Changes\n\n- A note.\n")).toThrow(/package/i);
  });

  it("ignores a version heading that is not a version", () => {
    const text = ["# @pithy-sh/core", "", "## Unreleased", "", "- Nothing.", "", "## 1.0.0", "", "- A note."].join(
      "\n",
    );

    expect(parseChangelog(text).map((entry) => entry.version)).toEqual(["1.0.0"]);
  });

  // `@changesets/changelog-github` rewrites a bare `#338` in a changeset body into a markdown link on
  // its way into the CHANGELOG. The changeset the live path read said `#338`, so the replay undoes it.
  it("unlinks an issue reference the changelog generator autolinked", () => {
    const text = [
      "# @pithy-sh/core",
      "",
      "## 1.0.0",
      "",
      "### Minor Changes",
      "",
      "- Empty the backlog [#338](https://github.com/pithy-sh/pithy/issues/338) left behind.",
    ].join("\n");

    expect(parseChangelog(text)[0]?.note).toBe("Empty the backlog #338 left behind.");
  });

  it("leaves a link that is not an autolinked reference alone", () => {
    const text = [
      "# @pithy-sh/core",
      "",
      "## 1.0.0",
      "",
      "### Minor Changes",
      "",
      "- See [the docs](https://pithy.sh/docs) for more.",
    ].join("\n");

    expect(parseChangelog(text)[0]?.note).toBe("See [the docs](https://pithy.sh/docs) for more.");
  });

  // A changeset whose note is hard-wrapped puts its second line in the bullet's indented continuation.
  // Reading only the head truncated the note at the wrap, and the replayed record stopped matching the
  // live one it was meant to recover.
  it("joins a note that was hard-wrapped across the bullet's continuation", () => {
    const text = [
      "# @pithy-sh/core",
      "",
      "## 1.0.0",
      "",
      "### Minor Changes",
      "",
      "- A note that someone",
      "  wrapped over two lines.",
      "",
      "  A second paragraph, which is not the note.",
    ].join("\n");

    expect(parseChangelog(text)[0]?.note).toBe("A note that someone wrapped over two lines.");
  });

  it("still finds the marker below a wrapped note", () => {
    const text = [
      "# @pithy-sh/core",
      "",
      "## 1.0.0",
      "",
      "### Patch Changes",
      "",
      "- A note that someone",
      "  wrapped over two lines.",
      "",
      "  Security: the exposure.",
    ].join("\n");

    expect(parseChangelog(text)[0]?.note).toBe("A note that someone wrapped over two lines.");
    expect(parseChangelog(text)[0]?.exposure).toBe("The exposure.");
  });

  // The live reader (`changesets.ts` readNote) stops the note at a `Security:` line as well as at a
  // blank one. This one stopped only at a blank line, so a changeset that put the marker directly under
  // its note replayed with the exposure sentence glued onto the end of the note — which breaks the
  // byte-identical replay the design rests on, and leaks the exposure into the wrong field.
  it("stops the note at a Security line with no blank line above it", () => {
    const text = [
      "# @pithy-sh/auth",
      "",
      "## 1.4.2",
      "",
      "### Patch Changes",
      "",
      "- Refresh-token reuse now revokes the whole family.",
      "  Security: a revoked refresh token stayed valid until its natural expiry.",
    ].join("\n");

    const [entry] = parseChangelog(text);
    expect(entry?.note).toBe("Refresh-token reuse now revokes the whole family.");
    expect(entry?.exposure).toBe("A revoked refresh token stayed valid until its natural expiry.");
  });

  it("defaults to patch when a version names no changes heading", () => {
    expect(parseChangelog("# @pithy-sh/core\n\n## 1.0.1\n\n- A note.\n")[0]?.bump).toBe("patch");
  });
});
