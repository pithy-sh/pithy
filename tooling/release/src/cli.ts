// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseChangelog } from "./changelog";
import { type SnapshotEntry, snapshotChangesets } from "./changesets";
import { actionsTokenMinter, type MintToken } from "./oidc";
import { type Delivery, postReleaseRecords, releaseRecordsConfig } from "./post";
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
 *   5. `post` — write the records to every configured dashboard, or say it is off. `--dry-run` posts a
 *      zero-record delivery to staging instead, which proves the OIDC claims without a release.
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
  /** Token seam for `post`: what mints one OIDC token per audience. Defaults to the runner's endpoint. */
  mintToken?: MintToken;
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

/** How a `::warning::` carries a line break, a carriage return and a percent sign. GitHub's own encoding. */
function annotationSafe(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/**
 * Put one line where a person will actually see it.
 *
 * The step summary is the run's own page, so a failed delivery is legible without opening a log. A
 * summary that cannot be written is not worth a release — the same sentence is on stdout either way.
 */
function summarize(options: RunOptions, line: string): void {
  const path = options.env.GITHUB_STEP_SUMMARY?.trim() ?? "";
  if (path === "") return;
  try {
    appendFileSync(path, `${line}\n`);
  } catch {
    // Nothing to do about it, and nothing worth failing for.
  }
}

/**
 * Say what happened at each destination, in one sentence per destination.
 *
 * **Partial outcomes stay legible.** *Posted to prod, failed to staging* is a different thing from
 * *failed*, and the exit code cannot carry the difference — so it is spelled out rather than collapsed
 * into a verdict.
 */
function describeDeliveries(deliveries: readonly Delivery[], count: number): string {
  const posted = deliveries.filter((delivery) => delivery.status === "posted");
  const parts: string[] = [];
  if (posted.length > 0) {
    parts.push(`Posted ${count} records to ${posted.map((delivery) => delivery.destination).join(", ")}.`);
  }
  for (const delivery of deliveries) {
    if (delivery.status === "failed") parts.push(`Failed to ${delivery.destination}: ${delivery.reason}.`);
  }
  return parts.join(" ");
}

/**
 * Write the records to every configured dashboard.
 *
 * **The release still stands, and the failure is still visible.** Publishing is step 5 and is long over;
 * nothing here rolls it back, and a missed write is recovered by `replay`. But a failed delivery exits
 * **non-zero**, and the workflow step carries `continue-on-error: true` — so GitHub renders a failed
 * step under a green job, in the run list rather than only in a log. Returning 0 was the old behavior,
 * and it made a rejected delivery indistinguishable from a successful one.
 *
 * `--dry-run` posts a **zero-record delivery to staging**: a real token, a real answer, no rows. Without
 * it the first exercise of this path would be a real release.
 */
async function post(options: RunOptions, dryRun: boolean): Promise<RunResult> {
  const path = releasePath(options.root, "records.json");
  if (!existsSync(path)) {
    return { code: 1, output: `No records at ${RELEASE_DIR}/records.json. Run \`build\` first.` };
  }
  const built = JSON.parse(readFileSync(path, "utf8")) as ReleaseRecord[];

  // A malformed endpoint throws — someone configured this and got it wrong, and that is worth a
  // failure. Being unconfigured does not, because that is the state this ships in.
  let destinations: ReturnType<typeof releaseRecordsConfig>;
  try {
    destinations = releaseRecordsConfig(options.env);
  } catch (error) {
    return { code: 1, output: error instanceof Error ? error.message : String(error) };
  }

  // A dry run proves the claims agree with the verifier. It never writes rows: the versions it just
  // built were not published, and a staging pane holding releases that never happened is worse than an
  // empty one.
  const records = dryRun ? [] : built;
  if (dryRun) destinations = destinations.filter((destination) => destination.name === "staging");

  const outcome = await postReleaseRecords({
    records,
    destinations,
    mintToken: options.mintToken ?? actionsTokenMinter({ env: options.env, fetch: options.fetch }),
    fetch: options.fetch,
    sendEmpty: dryRun,
  });

  const prefix = dryRun ? "Dry run. " : "";
  switch (outcome.status) {
    case "off": {
      const reason = dryRun ? "no staging endpoint configured" : "no endpoint configured";
      return { code: 0, output: `${prefix}Dashboard reporting is off: ${reason}. Records kept as an artifact.` };
    }
    case "empty":
      return { code: 0, output: "No records to report." };
    case "delivered": {
      const sentence = describeDeliveries(outcome.deliveries, records.length);
      summarize(options, `Release reporting: ${prefix}${sentence}`);
      const failed = outcome.deliveries.filter((delivery) => delivery.status === "failed");
      if (failed.length === 0) return { code: 0, output: `${prefix}${sentence}` };
      const line = `${prefix}${sentence} The release stands; recover it with \`replay\`.`;
      return { code: 1, output: `::warning title=Release reporting::${annotationSafe(line)}\n${line}` };
    }
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

/** Read `--dry-run`, the one flag `post` takes. */
function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
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
      return await post(options, hasFlag(argv, "--dry-run"));
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
