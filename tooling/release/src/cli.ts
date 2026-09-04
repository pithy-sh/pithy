// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseChangelog } from "./changelog";
import { type SnapshotEntry, snapshotChangesets } from "./changesets";
import { postReleaseRecords, releaseRecordsConfig } from "./post";
import { joinRecords, type ReleaseRecord } from "./records";
import { splitVersion } from "./version";
import { publishedPackages, publishedVersions } from "./workspace";

/**
 * The four commands the release workflow runs, and the one a human runs to repair a missed write.
 *
 * ## The ordering, and why it is three commands rather than one
 *
 * `changeset version` **consumes and deletes** the changeset files. The summaries and the `Security:`
 * markers live nowhere else until it has written the CHANGELOGs, and the versions do not exist until it
 * has run. So the release job is:
 *
 *   1. `snapshot` — read `.changeset/*.md` and the current versions, to a file.
 *   2. `bun run version` — Changesets bumps the manifests and writes the CHANGELOGs.
 *   3. `build` — read the versions back, join them to the snapshot, write the records.
 *   4. `changeset publish`
 *   5. `post` — write the records to the dashboard, or say it is off.
 *
 * Steps 1 and 3 are separate processes because step 2 is, and nothing in a shell can hold a JavaScript
 * value across it. The snapshot file is that value.
 *
 * Parsing the CHANGELOG diff instead would collapse 1–3 into one command and be fragile — a parser of
 * generated markdown on the critical line of every release. That path exists as `replay`, deliberately
 * off to one side, for the case it is genuinely right for: recovering a write that failed.
 */

/** Where the snapshot and the records go — a build artifact, git-ignored, uploaded by the workflow. */
const RELEASE_DIR = ".release";

/** The commands, in the order the workflow runs them. */
const COMMANDS = ["snapshot", "build", "post", "replay"] as const;

/** What a command was given. */
export interface RunOptions {
  /** The repository root. */
  root: string;
  /** The environment the dashboard configuration is read from. */
  env: Record<string, string | undefined>;
  /** Transport seam for `post`, so a test needs no network. */
  fetch?: typeof fetch;
  /** Date seam for `replay`: the tag's commit date, or null when no such tag exists. */
  tagDate?: (tag: string) => Promise<string | null>;
}

/** A command's result, in the shape the entry script turns into an exit code and a line of output. */
export interface RunResult {
  /** The process exit code. */
  code: number;
  /** What to print. */
  output: string;
}

/** The snapshot file: the changesets as they were, and the versions before Changesets touched them. */
interface Snapshot {
  /** Every changeset, parsed. */
  changesets: SnapshotEntry[];
  /** Package name → version, before `changeset version`. */
  before: Record<string, string>;
}

function releasePath(root: string, file: string): string {
  return join(root, RELEASE_DIR, file);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read `.changeset/*.md` and the manifests, before Changesets consumes either.
 *
 * The one step whose input disappears. Everything after it reads this file.
 */
function snapshot(root: string): RunResult {
  const changesetsDir = join(root, ".changeset");
  const changesets = existsSync(changesetsDir) ? snapshotChangesets(changesetsDir) : [];
  const before = Object.fromEntries(publishedVersions(root));

  writeJson(releasePath(root, "snapshot.json"), { changesets, before } satisfies Snapshot);

  const flagged = changesets.filter((entry) => entry.security).length;
  return {
    code: 0,
    output: `Snapshot: ${changesets.length} changesets, ${flagged} security-relevant, ${Object.keys(before).length} packages.`,
  };
}

/** Join the snapshot to the versions Changesets just wrote. Runs immediately after `changeset version`. */
function build(root: string, now: Date): RunResult {
  const path = releasePath(root, "snapshot.json");
  if (!existsSync(path)) {
    return {
      code: 1,
      output: `No snapshot at ${RELEASE_DIR}/snapshot.json. Run \`snapshot\` before \`changeset version\`, not after — it deletes the changesets.`,
    };
  }

  const { changesets, before } = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  const records = joinRecords({
    snapshot: changesets,
    before: new Map(Object.entries(before)),
    after: publishedVersions(root),
    published: now,
  });

  writeJson(releasePath(root, "records.json"), records);

  const flagged = records.filter((record) => record.security).length;
  return {
    code: 0,
    output:
      records.length === 0
        ? "Nothing released. No records written."
        : `Records: ${records.length} packages, ${flagged} security-relevant.`,
  };
}

/**
 * Write the records to the dashboard.
 *
 * **Always exits 0.** An unreachable dashboard cannot fail a release; a failure is reported here and
 * recovered by `replay`.
 */
async function post(options: RunOptions): Promise<RunResult> {
  const path = releasePath(options.root, "records.json");
  if (!existsSync(path)) {
    return { code: 1, output: `No records at ${RELEASE_DIR}/records.json. Run \`build\` first.` };
  }
  const records = JSON.parse(readFileSync(path, "utf8")) as ReleaseRecord[];

  // A malformed endpoint throws — someone configured this and got it wrong, and that is worth a
  // failure. Being unconfigured does not, because that is the state this ships in.
  let config: ReturnType<typeof releaseRecordsConfig>;
  try {
    config = releaseRecordsConfig(options.env);
  } catch (error) {
    return { code: 1, output: error instanceof Error ? error.message : String(error) };
  }

  const outcome = await postReleaseRecords({ records, config, fetch: options.fetch });
  switch (outcome.status) {
    case "off":
      return { code: 0, output: `Dashboard reporting is off: ${outcome.reason}. Records kept as an artifact.` };
    case "empty":
      return { code: 0, output: "No records to report." };
    case "posted":
      return { code: 0, output: `Reported ${outcome.count} records to the dashboard.` };
    case "failed":
      return {
        code: 0,
        output: `Dashboard write failed: ${outcome.reason}. The release stands; recover it with \`replay\`.`,
      };
  }
}

/** The default tag date: what `changeset publish` tagged, read out of git. */
async function gitTagDate(root: string, tag: string): Promise<string | null> {
  try {
    const stdout = execFileSync("git", ["log", "-1", "--format=%aI", tag], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const date = stdout.trim();
    return date === "" ? null : new Date(date).toISOString();
  } catch {
    // No such tag. Reported by the caller, never guessed.
    return null;
  }
}

/**
 * Every package's `CHANGELOG.md` path, for the packages that have one.
 *
 * The directory comes off the manifest rather than off the package name — see `publishedPackages`. A
 * package with no changelog has simply never been released, and is skipped.
 */
function changelogPaths(root: string, only: string | null): string[] {
  const found: string[] = [];
  for (const pkg of publishedPackages(root)) {
    if (only !== null && pkg.name !== only) continue;
    const path = join(root, pkg.dir, "CHANGELOG.md");
    if (existsSync(path)) found.push(path);
  }
  return found;
}

/**
 * Rebuild records from the CHANGELOGs in git — the recovery path for a write that failed.
 *
 * Idempotent and keyed on package and version, so re-running it costs nothing. A release whose date
 * cannot be resolved is **skipped and named**, never dated by guess: the store is keyed on package and
 * version, so a wrong date written once could not be corrected by running this again.
 */
async function replay(options: RunOptions, only: string | null): Promise<RunResult> {
  const dateOf = options.tagDate ?? ((tag: string) => gitTagDate(options.root, tag));
  const records: ReleaseRecord[] = [];
  const undated: string[] = [];
  const unreadable: string[] = [];

  for (const path of changelogPaths(options.root, only)) {
    for (const entry of parseChangelog(readFileSync(path, "utf8"))) {
      const tag = `${entry.package}@${entry.version}`;
      // A changelog heading is looser than a published version: `VERSION_HEADING` takes `## 01.2.3`
      // and `splitVersion` refuses it. One hand-edited heading used to end the whole recovery run in
      // a raw stack, which is the wrong outcome for the command whose job is repairing things.
      let split: ReturnType<typeof splitVersion>;
      try {
        split = splitVersion(entry.version);
      } catch {
        unreadable.push(tag);
        continue;
      }
      const published = await dateOf(tag);
      if (published === null) {
        undated.push(tag);
        continue;
      }
      records.push({
        package: entry.package,
        ...split,
        bump: entry.bump,
        published,
        note: entry.note,
        // A release predating the convention carries no flag. That is *unknown*, not *safe*, and the
        // dashboard is required to render it as such — #92 does not backfill a judgment nobody made.
        security: entry.security,
        exposure: entry.exposure,
      });
    }
  }

  records.sort((a, b) => a.package.localeCompare(b.package) || a.version.localeCompare(b.version));
  writeJson(releasePath(options.root, "records.json"), records);

  const skipped = [
    undated.length === 0 ? "" : ` Skipped ${undated.length} with no tag to date them: ${undated.join(", ")}.`,
    unreadable.length === 0
      ? ""
      : ` Skipped ${unreadable.length} whose version could not be read: ${unreadable.join(", ")}.`,
  ].join("");
  return {
    code: 0,
    output: `Replayed ${records.length} records from the changelogs.${skipped} Post them with \`post\`.`,
  };
}

/** Read `--package <name>`, the one flag `replay` takes. */
function flagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

/** Run one command. Never throws for an expected condition — the entry script prints and exits. */
export async function run(argv: string[], options: RunOptions): Promise<RunResult> {
  const [command] = argv;
  switch (command) {
    case "snapshot":
      return snapshot(options.root);
    case "build":
      return build(options.root, new Date());
    case "post":
      return await post(options);
    case "replay":
      return await replay(options, flagValue(argv, "--package"));
    default:
      return {
        code: 1,
        output:
          command === undefined
            ? `Name a command: ${COMMANDS.join(", ")}.`
            : `No such command: ${command}. Expected one of ${COMMANDS.join(", ")}.`,
      };
  }
}
