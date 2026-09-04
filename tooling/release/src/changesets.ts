// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read `.changeset/*.md` the way a release record needs it, which is not the way Changesets reads it.
 *
 * `@changesets/parse` answers "which packages, which bumps, what summary" — everything `changeset
 * version` needs to write a CHANGELOG, and nothing more. What a release record needs on top of that is
 * the one judgment a changeset carries in prose: **is this release security-relevant, and what was the
 * exposure.**
 *
 * ## Why the marker is in the body and never the frontmatter
 *
 * `@changesets/parse` treats every frontmatter key as a package name. A `security: true` key there does
 * not add a field — it declares a package called `security` and breaks `changeset version` outright. So
 * the marker is a line in the body: `Security: <what the exposure was>`.
 *
 * That placement is a feature rather than a workaround. The body flows into `CHANGELOG.md` through
 * `@changesets/changelog-github`, so the marker reaches everyone reading the changelog, and **the git
 * history becomes the durable record** once the changeset files are consumed. That is what makes
 * {@link ../changelog} able to rebuild a missed record months later: the judgment was never hidden in
 * a comment this tool alone could see.
 *
 * ## The exposure is not the note
 *
 * The first paragraph says what changed — "refresh-token reuse now revokes the whole family". The
 * `Security:` line says what was wrong before — "a revoked refresh token stayed valid until its natural
 * expiry". A customer deciding whether to upgrade urgently is reading the second sentence, so the two
 * are separate fields and neither is derived from the other.
 *
 * ## Strictness, and where it is deliberately absent
 *
 * Every refusal here is a malformed file failing the release loudly rather than a record shipping with a
 * hole in it. The one place this reader is generous is emphasis: `**Security:**` is read exactly like
 * `Security:`. A strict reader's failure mode is the very thing the convention exists to prevent — a
 * security fix shipping unmarked because the author bolded the word — and no correct changeset is
 * harmed by tolerating it.
 */

/** The semver levels Changesets understands. A changeset declaring anything else is malformed. */
const BUMPS = ["major", "minor", "patch"] as const;

/** One package's bump, as declared in a changeset's frontmatter. */
export type Bump = (typeof BUMPS)[number];

/** One `"<package>": <bump>` line from a changeset's frontmatter. */
export interface ChangesetBump {
  /** The npm package name, e.g. `@pithy-sh/auth`. */
  name: string;
  /** The semver level this changeset asks for on that package. */
  bump: Bump;
}

/** One changeset, read for what a release record needs. */
export interface ParsedChangeset {
  /** Every package this changeset bumps, in the order the frontmatter lists them. */
  bumps: ChangesetBump[];
  /** The first paragraph of the body — the release note, as it will read in the changelog. */
  note: string;
  /** Whether the body carries a `Security:` line. */
  security: boolean;
  /** What the exposure was, from the `Security:` line, or `null` when there is none. */
  exposure: string | null;
}

/** A parsed changeset with the file it came from. */
export interface SnapshotEntry extends ParsedChangeset {
  /** The changeset's filename without its extension — stable, and what a failure names. */
  id: string;
}

/** A capitalized, period-terminated sentence, so a record reads the same whoever wrote the changeset. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Split the frontmatter from the body.
 *
 * The closing delimiter is the **next** line that is exactly `---`, not the last one in the file: a
 * changeset body may contain a horizontal rule, and searching from the end would swallow the note.
 */
function splitFrontmatter(text: string): { frontmatter: string[]; body: string[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error("no frontmatter: a changeset starts with a --- delimited block of package bumps");
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) {
    throw new Error("unterminated frontmatter: no closing --- delimiter");
  }
  return { frontmatter: lines.slice(1, close), body: lines.slice(close + 1) };
}

/** Read the `"<package>": <bump>` lines, quoted or not. */
function readBumps(frontmatter: string[]): ChangesetBump[] {
  const bumps: ChangesetBump[] = [];
  for (const line of frontmatter) {
    if (line.trim() === "") continue;
    const match = /^\s*["']?(?<name>[^"':]+?)["']?\s*:\s*(?<bump>\S+)\s*$/.exec(line);
    if (!match?.groups) {
      throw new Error(`unreadable frontmatter line: ${line.trim()}`);
    }
    const { name, bump } = match.groups;
    if (!BUMPS.includes(bump as Bump)) {
      throw new Error(`unknown bump "${bump}" for ${name}: expected one of ${BUMPS.join(", ")}`);
    }
    bumps.push({ name: name as string, bump: bump as Bump });
  }
  return bumps;
}

/**
 * The `Security:` line, with its emphasis stripped.
 *
 * Matched at the start of a line only. "Security" is an ordinary English word, and a note reading "the
 * Security: header is now emitted" is not a marker.
 */
const SECURITY_LINE = /^\s*(?:\*{1,2}|_{1,2})?Security(?:\*{1,2}|_{1,2})?\s*:(?:\*{1,2}|_{1,2})?\s*(?<exposure>.*)$/;

/** The first paragraph of the body, with a wrapped one joined back into a single sentence. */
function readNote(body: string[]): string {
  const paragraph: string[] = [];
  for (const line of body) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    // A body that opens with the marker has a marker and no note. Stopping here rather than
    // absorbing it keeps the refusal below honest.
    if (SECURITY_LINE.test(line)) break;
    paragraph.push(trimmed);
  }
  return paragraph.join(" ");
}

/** Read one changeset. Throws on anything malformed — a release is not the moment to guess. */
export function parseChangeset(text: string): ParsedChangeset {
  const { frontmatter, body } = splitFrontmatter(text);
  const bumps = readBumps(frontmatter);
  const note = readNote(body);

  // `changeset add --empty` writes a changeset with no bumps at all — a deliberate "this pull request
  // releases nothing", which several in this repo are. It contributes no record, so it needs no note,
  // and refusing it would fail a release over a file Changesets itself creates. A changeset that *does*
  // bump something and says nothing is the real defect: its release would reach the changelog blank.
  if (bumps.length > 0 && note === "") {
    throw new Error("no release note: the first paragraph of the body is the note");
  }

  const marked = body.map((line) => SECURITY_LINE.exec(line)).find((match) => match !== null);
  if (!marked?.groups) {
    return { bumps, note, security: false, exposure: null };
  }
  const exposure = sentence(marked.groups.exposure ?? "");
  if (exposure === "") {
    throw new Error("a Security: line states the exposure — what was wrong before this release");
  }
  return { bumps, note, security: true, exposure };
}

/**
 * Every changeset in a directory, parsed, ordered by filename.
 *
 * **Call this before `changeset version`.** That command consumes and deletes these files, and the
 * summaries live nowhere else until the CHANGELOGs are written.
 */
export function snapshotChangesets(dir: string): SnapshotEntry[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .sort();

  return files.map((file) => {
    try {
      return { id: file.replace(/\.md$/, ""), ...parseChangeset(readFileSync(join(dir, file), "utf8")) };
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
