// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Bump } from "./changesets";

/**
 * Rebuild release records from a package's `CHANGELOG.md` — the recovery path.
 *
 * ## Why this exists at all
 *
 * The write to the dashboard **must not fail the release**. An unreachable dashboard cannot block
 * publishing an open-source package, so `post.ts` logs and continues. But then the dashboard is
 * silently missing a release and has no way to know it — it would under-report what is available,
 * which is precisely the failure the record exists to prevent.
 *
 * So a missed write has to be recoverable, and this is what makes it so. `changeset version` consumes
 * and deletes the changeset files, but the summaries — **and the `Security:` marker with them** — are
 * written into the CHANGELOG on the way through and committed. That is the whole reason the marker is
 * visible prose rather than a hidden field: once the changesets are gone, git is the durable record.
 *
 * ## Why it is not the primary path
 *
 * This parses generated markdown, and generated markdown is a format that changes when its generator
 * does. The release job reads the changeset files directly for exactly that reason. Replay is idempotent
 * and keyed on package and version, so re-running it costs nothing and fixes a gap; making it the only
 * path would put a fragile parser on the critical line of every release.
 *
 * ## What it cannot recover
 *
 * The publish **time**. A CHANGELOG records what shipped, never when. The caller supplies it — the
 * replay command reads the `<package>@<version>` git tag `changeset publish` wrote — and a record whose
 * date cannot be resolved is reported rather than guessed.
 */

/** `@changesets/changelog-github` prefixes each bullet with the PR, the commit, and a thank-you. */
const ATTRIBUTION =
  /^\s*(?:\[#\d+\]\([^)]*\)\s*)?(?:\[`[^`]*`\]\([^)]*\)\s*)?(?:Thanks\s+\[@[^\]]*\]\([^)]*\)!\s*-\s*)?/;

/**
 * The autolink `@changesets/changelog-github` writes over a bare `#338` in a changeset body.
 *
 * Undone here so a replayed note equals the live one rather than merely resembling it. The generator
 * rewrites the reference on its way into the CHANGELOG, so the CHANGELOG is the only place the link
 * exists — the changeset the live path read said `#338`, and nothing about the release changed it.
 * Matched narrowly: an issue or pull link whose text is the same number it points at, and nothing else.
 */
const AUTOLINKED_REFERENCE = /\[(#\d+)\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+\)/g;

/** The roll-up Changesets writes for a package that moved only because a dependency did. */
const DEPENDENCY_ROLLUP = /^updated dependencies\b/i;

/** `### Patch Changes`, and its two siblings. */
const CHANGES_HEADING = /^###\s+(?<level>major|minor|patch)\s+changes\s*$/i;

/** `## 1.4.2` — a released version, as opposed to `## Unreleased`. */
const VERSION_HEADING = /^##\s+(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*)\s*$/;

/** `# @pithy-sh/auth` — the changelog's own title. */
const PACKAGE_HEADING = /^#\s+(?<name>\S+)\s*$/;

/** The same marker `changesets.ts` reads, indented under its bullet. */
const SECURITY_LINE = /^\s*(?:\*{1,2}|_{1,2})?Security(?:\*{1,2}|_{1,2})?\s*:(?:\*{1,2}|_{1,2})?\s*(?<exposure>.*)$/;

/** How the levels rank, so a version carrying two headings reports the higher. */
const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

/** One released version, as its changelog section records it. */
export interface ChangelogEntry {
  /** The package the changelog belongs to. */
  package: string;
  /** The version this section documents. */
  version: string;
  /** The highest level named by the section's headings; `patch` when it names none. */
  bump: Bump;
  /** Every note in the section, or `null` when it holds only a dependency roll-up. */
  note: string | null;
  /** Whether any note in the section carries a `Security:` line. */
  security: boolean;
  /** Every exposure the section states, or `null` when it states none. */
  exposure: string | null;
}

/** One bullet, gathered from its first line and whatever is indented under it. */
interface Bullet {
  /** The bullet's own first line, with the attribution prefix removed. */
  head: string;
  /** Every line indented beneath it, unindented, **blank lines kept** as paragraph boundaries. */
  body: string[];
}

/** A capitalized, trimmed sentence — the same normalization `changesets.ts` applies. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed === "" ? trimmed : trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Split a section's lines into its bullets, keeping each bullet's indented continuation with it.
 *
 * **Blank lines are kept.** They are the only thing marking where a bullet's first paragraph ends, and
 * a release note is that first paragraph — the live path reads it straight out of the changeset. A
 * changeset whose note is hard-wrapped puts its second line in the continuation, so dropping blanks here
 * truncated the note at the wrap and the replayed record no longer matched the one it was recovering.
 */
function bullets(lines: string[]): Bullet[] {
  const found: Bullet[] = [];
  for (const line of lines) {
    if (/^\s*-\s+/.test(line) && !/^\s\s+-\s+/.test(line)) {
      found.push({ head: line.replace(/^\s*-\s+/, "").replace(ATTRIBUTION, ""), body: [] });
      continue;
    }
    // Anything indented under a bullet belongs to it — that is where the changeset body lands, and
    // the `Security:` line with it.
    found.at(-1)?.body.push(line.trim() === "" ? "" : line.replace(/^\s{1,4}/, ""));
  }
  return found;
}

/**
 * A bullet's release note: its head plus any continuation up to the first blank line, joined.
 *
 * The same rule `changesets.ts` applies to a changeset body, so both paths read one wrapped paragraph
 * as one sentence — **including where it stops.** `readNote` there ends the note at a `Security:` line
 * as well as at a blank one, and this stopped only at a blank one, so a changeset that put the marker
 * directly under its note replayed with the exposure glued onto the end of the note. Two readers of one
 * convention have to agree on all of it, not most of it.
 */
function firstParagraph(bullet: Bullet): string {
  const lines = [bullet.head];
  for (const line of bullet.body) {
    if (line.trim() === "" || SECURITY_LINE.test(line)) break;
    lines.push(line);
  }
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}

/** Everything one version's section says, read off its bullets. */
function readSection(name: string, version: string, headings: Bump[], lines: string[]): ChangelogEntry {
  const notes: string[] = [];
  const exposures: string[] = [];

  for (const bullet of bullets(lines)) {
    // A dependency roll-up is not a note. It is the same fact `joinRecords` records as `note: null`,
    // so a replayed record and a live one agree on a package that moved only with its deps.
    if (DEPENDENCY_ROLLUP.test(bullet.head)) continue;
    const note = firstParagraph(bullet).replace(AUTOLINKED_REFERENCE, "$1");
    if (note !== "") notes.push(note);
    for (const line of bullet.body) {
      const match = SECURITY_LINE.exec(line);
      const exposure = sentence(match?.groups?.exposure ?? "");
      if (exposure !== "") exposures.push(exposure);
    }
  }

  const bump = headings.reduce<Bump>((highest, level) => (RANK[level] > RANK[highest] ? level : highest), "patch");
  return {
    package: name,
    version,
    bump,
    // Sorted, to match `records.ts`. See the note on `paragraphs` there: it is what makes a replayed
    // record equal the live one rather than merely equivalent to it.
    note: notes.length === 0 ? null : [...notes].sort().join("\n\n"),
    security: exposures.length > 0,
    exposure: exposures.length === 0 ? null : [...exposures].sort().join("\n\n"),
  };
}

/** Read one package's `CHANGELOG.md`. Entries come back newest first, as the file orders them. */
export function parseChangelog(text: string): ChangelogEntry[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const title = lines.map((line) => PACKAGE_HEADING.exec(line)).find((match) => match !== null);
  const name = title?.groups?.name;
  if (name === undefined) {
    throw new Error("no package title: a changelog opens with `# <package name>`");
  }

  const entries: ChangelogEntry[] = [];
  let version: string | null = null;
  let headings: Bump[] = [];
  let section: string[] = [];

  const flush = (): void => {
    if (version !== null) entries.push(readSection(name, version, headings, section));
  };

  for (const line of lines) {
    const heading = VERSION_HEADING.exec(line);
    if (heading?.groups) {
      flush();
      version = heading.groups.version as string;
      headings = [];
      section = [];
      continue;
    }
    // A `## Unreleased` (or any other non-version h2) closes the section before it and opens nothing,
    // so its bullets are never attributed to the release above.
    if (/^##\s+/.test(line)) {
      flush();
      version = null;
      continue;
    }
    if (version === null) continue;

    const changes = CHANGES_HEADING.exec(line);
    if (changes?.groups) {
      headings.push(changes.groups.level?.toLowerCase() as Bump);
      continue;
    }
    section.push(line);
  }
  flush();

  return entries;
}
