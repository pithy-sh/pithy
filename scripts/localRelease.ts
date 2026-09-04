/**
 * The bootstrap release, run from a laptop. The one release that cannot run in CI.
 *
 *   GITHUB_TOKEN=$(gh auth token) bun run release:local -- --dry-run   # see it, change nothing
 *   GITHUB_TOKEN=$(gh auth token) bun run release:local                # publish it
 *
 * npm configures trusted publishing per package, on a package that already exists, so the very first
 * version of each package has to be published some other way. `.github/workflows/release.yml` takes
 * over permanently afterwards — see `docs/RELEASING.md`.
 *
 * The sequence is the workflow's, exactly: snapshot, version, build the records, publish, tag, push.
 * The reasoning for each step lives in `@pithy-sh/release/src/localRelease` and in the workflow.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { describePlan, generatedChangelogs, preflight } from "@pithy-sh/release/src/localRelease";
import type { ReleaseRecord } from "@pithy-sh/release/src/records";
import { publishedPackages } from "@pithy-sh/release/src/workspace";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const assumeYes = args.includes("--yes");

/** Run a command and fail the release on a non-zero exit. Output goes straight to the terminal. */
function run(command: string, commandArgs: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    fail(`\`${command} ${commandArgs.join(" ")}\` exited ${result.status ?? "on a signal"}.`);
  }
}

/** Read a command's output, or null when it fails. For the preflight questions, which may all fail. */
function capture(command: string, commandArgs: string[]): string | null {
  try {
    return execFileSync(command, commandArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function fail(message: string): never {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

/** Every `CHANGELOG.md` that exists right now, so a dry run can delete exactly the ones it adds. */
function changelogs(): string[] {
  return publishedPackages(root)
    .map((pkg) => join(pkg.dir, "CHANGELOG.md"))
    .filter((path) => existsSync(join(root, path)));
}

async function confirm(question: string): Promise<boolean> {
  if (assumeYes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

// ---- preflight ----

/** How many changesets are waiting — the same rule `snapshotChangesets` reads the directory by. */
function countChangesets(): number {
  const dir = join(root, ".changeset");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md").length;
}

/** The working tree's uncommitted paths, or `null` when git could not be asked. */
function workingTree(): string[] | null {
  const status = capture("git", ["status", "--porcelain"]);
  return status === null ? null : status.split("\n").filter(Boolean);
}

/** Whether the remote answered, and how far behind it this checkout is. */
function remoteState(): { fetched: boolean; behind: number } {
  if (capture("git", ["fetch", "--quiet", "origin", "main"]) === null) return { fetched: false, behind: 0 };
  return { fetched: true, behind: Number(capture("git", ["rev-list", "--count", "HEAD..origin/main"]) ?? "0") };
}

const problems = preflight(
  {
    branch: capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown",
    // `null` rather than `[]` when git could not answer — the preflight refuses on it. Reading a
    // failed `git status` as a clean tree is how the dry run's restore destroys uncommitted work.
    dirty: workingTree(),
    ...remoteState(),
    npmUser: capture("npm", ["whoami"]),
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: never a turbo task — this is the operator's entry point and spawns turbo itself, so no cache key is derived from it.
    githubToken: process.env.GITHUB_TOKEN?.trim() || null,
    changesets: countChangesets(),
  },
  { publishing: !dryRun },
);

if (problems.length > 0) {
  process.stderr.write(`\nThis checkout is not ready to cut a release.\n\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

// ---- the release ----

const changelogsBefore = changelogs();

process.stdout.write("\nReading the changesets.\n");
run("bun", ["scripts/releaseRecords.ts", "snapshot"]);

process.stdout.write("\nVersioning the packages.\n");
run("bun", ["run", "version"]);

process.stdout.write("\nBuilding the release records.\n");
run("bun", ["scripts/releaseRecords.ts", "build"]);

const records = JSON.parse(readFileSync(join(root, ".release", "records.json"), "utf8")) as ReleaseRecord[];
process.stdout.write(`\nThis release would publish:\n\n${describePlan(records)}\n`);

if (dryRun) {
  // Put the tree back exactly as it was. Safe because preflight refused to start on a dirty one, so
  // everything `git restore` discards is something this run wrote.
  const created = generatedChangelogs(changelogsBefore, changelogs());
  run("git", ["restore", "--source=HEAD", "--worktree", "--", "."]);
  if (created.length > 0) run("rm", ["-f", ...created]);
  run("rm", ["-rf", ".release"]);
  process.stdout.write("\nDry run. Nothing published, nothing tagged, and the tree is back as it was.\n");
  process.exit(0);
}

process.stdout.write(
  "\nA published version is permanent. npm allows unpublishing for 72 hours, and the name and version can never be reused.\n",
);
if (!(await confirm("\nPublish these to npm? Type yes to continue: "))) {
  // The exact files this run created, never a glob. `rm -f packages/*/CHANGELOG.md` would delete the
  // changelogs of every package already released, which no `git restore` brings back.
  const created = generatedChangelogs(changelogsBefore, changelogs());
  const remove = created.length === 0 ? "" : ` && rm -f ${created.join(" ")}`;
  process.stdout.write(
    `\nStopped. The tree still holds the version bump — undo it with \`git restore -- .${remove}\`, or re-run to publish it.\n`,
  );
  process.exit(1);
}

process.stdout.write("\nPublishing.\n");
// Provenance is generated from a CI build's OIDC identity. Off explicitly, because npm fails the
// publish rather than skipping the attestation when it is asked for and cannot be produced.
run("bun", ["run", "release"], { NPM_CONFIG_PROVENANCE: "false" });

process.stdout.write("\nCommitting the version bump.\n");
run("git", ["add", "-A"]);
run("git", ["commit", "-m", "chore(release): version packages"]);
run("git", ["push", "--follow-tags", "origin", "HEAD:main"]);

process.stdout.write(
  "\nDone. Next: attach a trusted publisher to each package so CI can take over — docs/RELEASING.md §5.\n",
);
