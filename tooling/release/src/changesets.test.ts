// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseChangeset, snapshotChangesets } from "./changesets";

describe("parseChangeset", () => {
  it("reads the packages and their bumps from the frontmatter", () => {
    const parsed = parseChangeset(
      ["---", '"@pithy-sh/auth": patch', '"@pithy-sh/core": minor', "---", "", "A note."].join("\n"),
    );

    expect(parsed.bumps).toEqual([
      { name: "@pithy-sh/auth", bump: "patch" },
      { name: "@pithy-sh/core", bump: "minor" },
    ]);
  });

  it("takes the first paragraph as the release note", () => {
    const parsed = parseChangeset(
      [
        "---",
        '"@pithy-sh/auth": patch',
        "---",
        "",
        "Refresh-token reuse now revokes the whole family.",
        "",
        "A second paragraph explaining the mechanism at length, which is not the note.",
      ].join("\n"),
    );

    expect(parsed.note).toBe("Refresh-token reuse now revokes the whole family.");
  });

  it("joins a release note wrapped over several lines into one", () => {
    const parsed = parseChangeset(
      ["---", '"@pithy-sh/auth": patch', "---", "", "A note that someone", "wrapped over two lines.", ""].join("\n"),
    );

    expect(parsed.note).toBe("A note that someone wrapped over two lines.");
  });

  it("reads the exposure from a Security: line", () => {
    const parsed = parseChangeset(
      [
        "---",
        '"@pithy-sh/auth": patch',
        "---",
        "",
        "Refresh-token reuse now revokes the whole family.",
        "",
        "Security: a revoked refresh token stayed valid until its natural expiry.",
      ].join("\n"),
    );

    expect(parsed.security).toBe(true);
    expect(parsed.exposure).toBe("A revoked refresh token stayed valid until its natural expiry.");
  });

  // The marker is prose in a file people hand-write, and the failure mode of a strict reader is the
  // one this convention exists to prevent: a security fix that ships unmarked because the author
  // bolded the word. Emphasis is stripped, never rejected.
  it("reads the exposure through bold or italic emphasis", () => {
    for (const marker of ["**Security:**", "*Security:*", "__Security:__", "**Security**:"]) {
      const parsed = parseChangeset(
        ["---", '"@pithy-sh/auth": patch', "---", "", "A note.", "", `${marker} the exposure sentence.`].join("\n"),
      );
      expect(parsed.security, marker).toBe(true);
      expect(parsed.exposure, marker).toBe("The exposure sentence.");
    }
  });

  it("carries no flag when nothing declares one", () => {
    const parsed = parseChangeset(["---", '"@pithy-sh/auth": patch', "---", "", "A note."].join("\n"));

    expect(parsed.security).toBe(false);
    expect(parsed.exposure).toBeNull();
  });

  // "Security" is an ordinary English word. Only a line that *starts* with the marker is one.
  it("does not read a mention of security mid-sentence as a marker", () => {
    const parsed = parseChangeset(
      ["---", '"@pithy-sh/auth": patch', "---", "", "The Security: header is now emitted on every response."].join(
        "\n",
      ),
    );

    expect(parsed.security).toBe(false);
    expect(parsed.exposure).toBeNull();
  });

  // A `---` in the body is a horizontal rule, not the end of the frontmatter. Ending at the first
  // one found anywhere would truncate the note at the rule and lose everything under it.
  it("ends the frontmatter at its own delimiter, not at a horizontal rule in the body", () => {
    const parsed = parseChangeset(
      ["---", '"@pithy-sh/auth": patch', "---", "", "A note.", "", "---", "", "Security: the exposure."].join("\n"),
    );

    expect(parsed.note).toBe("A note.");
    expect(parsed.exposure).toBe("The exposure.");
  });

  it("accepts an unquoted package name", () => {
    const parsed = parseChangeset(["---", "@pithy-sh/auth: patch", "---", "", "A note."].join("\n"));

    expect(parsed.bumps).toEqual([{ name: "@pithy-sh/auth", bump: "patch" }]);
  });

  it("refuses a file with no frontmatter", () => {
    expect(() => parseChangeset("Just prose.")).toThrow(/frontmatter/i);
  });

  it("refuses a bump that is not a semver level", () => {
    expect(() => parseChangeset(["---", '"@pithy-sh/auth": huge', "---", "", "A note."].join("\n"))).toThrow(/huge/);
  });

  it("refuses a changeset that bumps something and says nothing", () => {
    expect(() => parseChangeset(["---", '"@pithy-sh/auth": patch', "---", "", ""].join("\n"))).toThrow(/note/i);
  });

  // `changeset add --empty` writes exactly this: a pull request that deliberately releases nothing.
  // Several are already in this repo, and refusing one would fail a release over a file Changesets
  // itself creates.
  it("accepts an empty changeset, with or without prose", () => {
    expect(parseChangeset("---\n---\n").bumps).toEqual([]);

    const withProse = parseChangeset(["---", "---", "", "A note about a release that never happens."].join("\n"));
    expect(withProse.bumps).toEqual([]);
    expect(withProse.note).toBe("A note about a release that never happens.");
  });

  // The half of the pair `changelog.ts` has to match: a marker directly under the note, no blank line.
  it("stops the note at a Security line with no blank line above it", () => {
    const parsed = parseChangeset(
      ["---", '"@pithy-sh/auth": patch', "---", "", "A note.", "Security: the exposure."].join("\n"),
    );

    expect(parsed.note).toBe("A note.");
    expect(parsed.exposure).toBe("The exposure.");
  });

  it("refuses a Security: line with nothing after it", () => {
    expect(() =>
      parseChangeset(["---", '"@pithy-sh/auth": patch', "---", "", "A note.", "", "Security:"].join("\n")),
    ).toThrow(/exposure/i);
  });
});

describe("snapshotChangesets", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pithy-changesets-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, body: string): void {
    writeFileSync(join(dir, name), body);
  }

  it("reads every changeset in the directory", () => {
    write("one.md", ["---", '"@pithy-sh/auth": patch', "---", "", "First."].join("\n"));
    write("two.md", ["---", '"@pithy-sh/core": minor', "---", "", "Second."].join("\n"));

    const snapshot = snapshotChangesets(dir);

    expect(snapshot.map((entry) => entry.note)).toEqual(["First.", "Second."]);
    expect(snapshot.map((entry) => entry.id)).toEqual(["one", "two"]);
  });

  // `README.md` and `config.json` live in `.changeset/` and are not changesets.
  it("skips the directory's own README and anything that is not markdown", () => {
    write("README.md", "# Changesets\n");
    write("config.json", "{}\n");
    write("real.md", ["---", '"@pithy-sh/auth": patch', "---", "", "Real."].join("\n"));

    expect(snapshotChangesets(dir).map((entry) => entry.id)).toEqual(["real"]);
  });

  it("names the file in the failure when one cannot be read", () => {
    write("broken.md", "no frontmatter here");

    expect(() => snapshotChangesets(dir)).toThrow(/broken\.md/);
  });

  it("is empty when there is nothing to release", () => {
    expect(snapshotChangesets(dir)).toEqual([]);
  });
});
