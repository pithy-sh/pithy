// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { personDecision, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { messageOf, PithyError, sentenceOf } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { type PreparedDev, prepareDevCheckout } from "../dev/prepare";
import { checkDevSecrets } from "../doctor/devSecrets";
import { devConfigPath } from "../feature/devConfig";
import { portsRegistryPath } from "../feature/ports";
import { migrateProject, planMigrateProject, type WorkerScope } from "../migrations/run";
import { emptyPlan, type Plan, type PlanFile, type PlanMigration } from "../plan/plan";
import { seedDryRunPlan } from "../seed/dryRunPlan";
import { type SeedRunReport, seedProject } from "../seed/run";
import { type CheckedProject, checkProject, ProjectCheckFailedError } from "./check";
import { devDataHeld, type HeldTable } from "./dataHeld";
import { type InstallPlan, installDependencies, planInstall } from "./install";
import { type MintReport, mintLocalSecrets } from "./mint";

/**
 * **`pithy setup`: make this checkout ready to develop, whatever state it is in. Dev only (#764).**
 *
 * In order, each step doing only what is missing:
 *
 * 1. **Install**, with the project's own package manager against its lockfile, which is never rewritten.
 * 2. **Check the project** — the root config, every Worker's, every composed peer. A failure ends the run
 *    here, before any later step writes, because nothing after it can work.
 * 3. **Mint the local secrets the kit can mint**, each only when absent, into the machine's one dev
 *    secrets file for this project. `pithy.config.ts` is never touched.
 * 4. **Migrate `dev`.**
 * 5. **Do what `pithy dev` does before it starts anything**: pin every member's port, generate each Worker's
 *    `.dev.vars`, seed the dev secrets into the local store. Nothing is started.
 * 6. **Seed `dev`, only into an empty database.** One that holds rows is left alone and the run says so —
 *    `pithy seed --redo` stays the way to reset, and it asks first.
 * 7. **End with what it cannot do**: every secret somebody else issues, and `pithy dev` as the next step.
 *
 * **Dev only, without exception.** Nothing here resolves Cloudflare credentials, nothing makes a call to an
 * account, and nothing reads or writes `staging` or `prod`: every step is handed `dev` by name, and there is
 * no option that names another environment. Staging and production stay with `provision`, `secrets
 * provision`, `migrate --env` and `deploy`, which are a person's decisions.
 *
 * **One implementation of ready.** `pithy feature sync` runs this for everything a clone needs and keeps
 * only what a feature adds — its port block — so a worktree and a clone cannot drift into two answers.
 */

/** How the seed step ended. */
export type SeedOutcome =
  /** The fixtures were written into an empty `dev`. */
  | { readonly state: "seeded" }
  /** Under `--dry-run`: an empty `dev` the fixtures would be written into. */
  | { readonly state: "planned" }
  /** `dev` already holds rows, so it was left alone. */
  | { readonly state: "held"; readonly held: readonly HeldTable[] }
  /** A fixture uploads media, which reaches an account, and this run reaches none. Nothing was seeded. */
  | { readonly state: "media" }
  /** Nothing was written: nothing composes a fixture for `dev`, or `dev` already holds everything one writes. */
  | { readonly state: "none" };

/** Everything one setup run did, or under `dryRun` would do. */
export interface SetupReport {
  /** Whether this was `--dry-run`. Nothing was written when it is. */
  dryRun: boolean;
  /** The project's name — what the dev secrets file and the port registry key on. */
  project: string;
  /** The install that ran, or would; `null` when it was skipped. */
  install: InstallPlan | null;
  /** The dev secrets file, and what was minted or carried into it. */
  secrets: MintReport;
  /** The `dev` migrations applied, or under `dryRun` pending, by name. */
  migrations: string[];
  /** Under `dryRun`, each pending migration as the shared plan states one. Empty on a real run. */
  plannedMigrations: PlanMigration[];
  /** The pinned ports and generated `.dev.vars`. */
  dev: PreparedDev;
  /** How the seed step ended. */
  seed: SeedOutcome;
  /** The seed run's own report, when one ran or was planned. */
  seedReport: SeedRunReport | null;
  /** Every secret somebody else issues that this machine has no value for. Setup names them, never supplies them. */
  external: string[];
  /** Lines for whoever is reading, from every step, in order. */
  notes: string[];
  /** Whether anything on this machine changed. `false` on a second run, and always under `dryRun`. */
  changed: boolean;
}

/**
 * A dry run that could plan only the install: the project's configs import its packages, so on a clone with
 * nothing installed yet every later step is unknowable until the install has run. Said, never guessed.
 */
export interface SetupBlockedPlan {
  dryRun: true;
  /** The install a real run would start with. */
  install: InstallPlan;
  /** Why nothing after the install could be planned: the check's own sentence. */
  blocked: string;
}

/** What one setup run returns. */
export type SetupResult = SetupReport | SetupBlockedPlan;

/** Whether a result is a dry run that stopped at the install. */
export function isBlockedPlan(result: SetupResult): result is SetupBlockedPlan {
  return "blocked" in result;
}

/** The steps, as seams. Every one defaults to the real implementation, all of them against `dev`. */
export interface SetupSteps {
  install?: (projectDir: string) => Promise<InstallPlan>;
  planInstall?: (projectDir: string) => Promise<InstallPlan>;
  check?: (projectDir: string) => Promise<CheckedProject>;
  mint?: (options: { projectDir: string; dryRun: boolean }) => Promise<MintReport>;
  migrate?: (options: MigrateStepOptions) => Promise<string[]>;
  planMigrate?: (options: MigrateStepOptions) => Promise<PlanMigration[]>;
  prepare?: (options: { projectDir: string; dryRun: boolean }) => Promise<PreparedDev>;
  held?: (options: { projectDir: string; workers: readonly WorkerScope[] }) => Promise<HeldTable[]>;
  seed?: (options: SeedStepOptions) => Promise<SeedRunReport>;
  external?: (projectDir: string) => Promise<string[]>;
}

/** What the migrate step is handed. */
export interface MigrateStepOptions {
  projectDir: string;
  project: string;
  workers: WorkerScope[];
  /** The run's account — see {@link SetupOptions.account}. A `dev` migration never uses one. */
  account: CloudflareAccountSelection | null;
}

/** What the seed step is handed. */
export interface SeedStepOptions extends MigrateStepOptions {
  dryRun: boolean;
}

/** What {@link setupCheckout} needs. */
export interface SetupOptions {
  /** The checkout root. */
  projectDir: string;
  /** Plan every step and write nothing. */
  dryRun?: boolean;
  /** Run the install step. `false` under `--skip-install`, and for `pithy feature sync`, whose worktree has one. */
  install?: boolean;
  /**
   * The account a media fixture uploads through, or `null` for none. **Required, so `null` is written down
   * (#234).** `pithy setup` passes `null`: it reaches no account by construction, so a project whose seed
   * uploads media is not seeded by it. `pithy feature sync` passes the project's own, as it always has.
   */
  account: CloudflareAccountSelection | null;
  /** Step seams. */
  steps?: SetupSteps;
}

/** The migrations a run applied: every result that succeeded going up, by name. */
async function migrateDev(options: MigrateStepOptions): Promise<string[]> {
  const runs = await migrateProject({ ...options, env: LOCAL_ENVIRONMENT });
  return runs.flatMap((run) =>
    run.databases.flatMap((database) =>
      database.results
        .filter((result) => result.status === "Success" && result.direction === "Up")
        .map((result) => result.migrationName),
    ),
  );
}

/** The migrations a run would apply. */
/**
 * Whether the install still to run could clear the check's failure. A config that will not load usually names
 * an uninstalled package, and on a fresh clone that is every config. The check's own refusal, a config that is
 * not there, and a root with no `name` are the project's: no install composes a peer or writes a file.
 */
function installMayFix(error: unknown): boolean {
  if (error instanceof ProjectCheckFailedError) return false;
  if (!(error instanceof PithyError)) return true;
  return error.payload.code !== "core/not_found" && error.payload.code !== "core/precondition_failed";
}

function planMigrateDev(options: MigrateStepOptions): Promise<PlanMigration[]> {
  return planMigrateProject({ ...options, env: LOCAL_ENVIRONMENT });
}

/** The seed, against `dev`. */
function seedDev(options: SeedStepOptions): Promise<SeedRunReport> {
  return seedProject({
    projectDir: options.projectDir,
    project: options.project,
    workers: options.workers,
    env: LOCAL_ENVIRONMENT,
    account: options.account,
    dryRun: options.dryRun,
    json: true,
  });
}

/** Secrets somebody else issues — `pithy doctor`'s own classification, so the two say the same names. */
async function externalSecrets(projectDir: string): Promise<string[]> {
  const check = await checkDevSecrets({ projectDir });
  if (check === null) return [];
  return [...new Set([...check.missing, ...check.bootstrapUnmintable])].sort();
}

/** Whether a seed plan writes anything that reaches an account. */
function uploadsMedia(report: SeedRunReport): boolean {
  return report.workers.some((worker) => worker.sets.some((set) => set.media.length > 0));
}

/**
 * Whether a seed run wrote a row, an entry, an object or an asset anywhere.
 *
 * Judged on what landed, never on what was planned: every seed write is non-destructive, so a run over
 * fixtures `dev` already holds plans the same rows and writes none of them. KV and R2, and rows in a
 * retained table, are outside what {@link devDataHeld} asks, so a second run reaches the seed — and must
 * still say it changed nothing (#764).
 */
function wroteAnything(report: SeedRunReport): boolean {
  return report.workers.some((worker) =>
    worker.sets.some(
      (set) =>
        set.d1.some((table) => (table.written ?? 0) > 0) ||
        set.kv.some((store) => (store.written ?? 0) > 0) ||
        set.r2.some((object) => object.written === true) ||
        set.media.some((asset) => asset.action !== "skip"),
    ),
  );
}

/** Whether a seed plan has any set at all. */
function hasSets(report: SeedRunReport): boolean {
  return report.workers.some((worker) => worker.sets.length > 0);
}

/** Make this checkout ready to develop. */
export async function setupCheckout(options: SetupOptions): Promise<SetupResult> {
  const { projectDir } = options;
  const dryRun = options.dryRun === true;
  const steps = options.steps ?? {};
  const { account } = options;
  const notes: string[] = [];

  // 1. Install. A dry run plans it; nothing after it can be checked until it has run, so a dry run whose
  //    project will not load yet stops planning here and says why.
  let install: InstallPlan | null = null;
  if (options.install !== false) {
    install = dryRun
      ? await (steps.planInstall ?? planInstall)(projectDir)
      : await (steps.install ?? ((dir: string) => installDependencies({ projectDir: dir })))(projectDir);
  }

  // 2. Check. Throws, naming every problem, before anything below writes.
  const check = steps.check ?? ((dir: string) => checkProject({ projectDir: dir }));
  let checked: CheckedProject;
  try {
    checked = await check(projectDir);
  } catch (error) {
    // Only a dry run with an install still to run is planned past a failure, and only past one the install
    // can fix: a config that will not load. A real run has installed by now, so its failure is the project's.
    if (dryRun && install !== null && installMayFix(error))
      return { dryRun: true, install, blocked: sentenceOf(error) };
    throw error;
  }
  const { project } = checked;
  const workers: WorkerScope[] = checked.workers.map(({ name, dir, capabilities }) => ({ name, dir, capabilities }));

  // 3. Mint.
  const secrets = await (steps.mint ?? ((o) => mintLocalSecrets(o)))({ projectDir, dryRun });
  notes.push(...secrets.refused);

  // 4. Migrate.
  const migrateOptions: MigrateStepOptions = { projectDir, project, workers, account };
  const plannedMigrations = dryRun ? await (steps.planMigrate ?? planMigrateDev)(migrateOptions) : [];
  const migrations = dryRun
    ? plannedMigrations.map((migration) => migration.name)
    : await (steps.migrate ?? migrateDev)(migrateOptions);

  // 5. What `pithy dev` does before it starts anything.
  const dev = await (steps.prepare ?? ((o) => prepareDevCheckout(o)))({ projectDir, dryRun });
  notes.push(...dev.notes);

  // 6. Seed, only into an empty `dev`. Asked after the migration, so the tables exist to be asked about,
  //    and after the dev secrets reached the store — which is a retained table, and never counted.
  const held = await (steps.held ?? devDataHeld)({ projectDir, workers });
  let seed: SeedOutcome;
  let seedReport: SeedRunReport | null = null;
  if (held.length > 0) {
    seed = { state: "held", held };
  } else {
    const seedStep = steps.seed ?? seedDev;
    const planned = await seedStep({ ...migrateOptions, dryRun: true });
    if (!hasSets(planned)) {
      seed = { state: "none" };
    } else if (account === null && uploadsMedia(planned)) {
      seed = { state: "media" };
    } else if (dryRun) {
      seed = { state: "planned" };
      seedReport = planned;
    } else {
      seedReport = await seedStep({ ...migrateOptions, dryRun: false });
      // A set can be composed and write nothing — a prepared set with no one to prepare for — and a run
      // that wrote nothing has not seeded anything, so it must not say it did, or count as a change.
      seed = wroteAnything(seedReport) ? { state: "seeded" } : { state: "none" };
    }
  }

  // 7. What it cannot do. Never fatal: a report the run could not finish is a line, not a failed setup.
  let external: string[] = [];
  try {
    external = await (steps.external ?? externalSecrets)(projectDir);
  } catch (error) {
    notes.push(`Could not list the secrets somebody else issues. ${messageOf(error)}`);
  }

  const changed =
    !dryRun &&
    (secrets.minted.length > 0 ||
      secrets.adopted.length > 0 ||
      migrations.length > 0 ||
      dev.allocated ||
      dev.devVars.length > 0 ||
      dev.seededSecrets.length > 0 ||
      seed.state === "seeded");

  return {
    dryRun,
    project,
    install,
    secrets,
    migrations,
    plannedMigrations,
    dev,
    seed,
    seedReport,
    external,
    notes,
    changed,
  };
}

/** A path as a plan states it: relative to the project root with `/` separators, absolute outside it. */
function planPath(projectDir: string, path: string): string {
  const inside = relative(projectDir, path);
  return inside.startsWith("..") || inside === "" ? path : inside.split(sep).join("/");
}

/** **The dry run as the one plan every dry run shares (#697).** Built from the report a dry run returned. */
export function setupPlan(projectDir: string, report: SetupReport): Plan {
  const plan = emptyPlan();
  const files: PlanFile[] = [];
  if (report.install !== null) {
    plan.notes.push(
      `Runs ${[report.install.command, ...report.install.args].join(" ")}${report.install.lockfile === null ? ", which writes the project's first lockfile" : `, which never rewrites ${report.install.lockfile}`}.`,
    );
  }
  for (const name of report.secrets.minted) {
    plan.secrets.push({ name, env: LOCAL_ENVIRONMENT, action: "mint", where: report.secrets.path });
  }
  for (const name of report.secrets.adopted) {
    plan.secrets.push({ name, env: LOCAL_ENVIRONMENT, action: "write", where: report.secrets.path });
  }
  plan.migrations.push(...report.plannedMigrations);
  if (report.dev.allocated) {
    const registry = portsRegistryPath();
    files.push({
      path: registry,
      action: existsSync(registry) ? "edit" : "create",
      changes: ["Reserves this checkout's port block."],
    });
    files.push({
      path: planPath(projectDir, devConfigPath(projectDir)),
      action: existsSync(devConfigPath(projectDir)) ? "edit" : "create",
      changes: ["Pins one port per Worker and capability host."],
    });
  }
  for (const dir of report.dev.devVarsDirs) {
    files.push({
      path: `${planPath(projectDir, dir)}/.dev.vars`,
      action: "edit",
      changes: ["Generated from this machine's dev secrets and .dev.vars.local. Rewritten only when its bytes change."],
    });
  }
  plan.files.push(...files);
  plan.notes.push("Seeds the project's dev secrets into the local SECRETS store.");
  if (report.seedReport !== null) {
    const seeded = seedDryRunPlan(report.seedReport);
    plan.data.push(...seeded.data);
  }
  plan.notes.push(...seedSentences(report.seed));
  return plan;
}

/** What the seed step says, in both a run and a plan. */
export function seedSentences(seed: SeedOutcome): string[] {
  switch (seed.state) {
    case "seeded":
      return ["Seeded dev."];
    case "planned":
      return ["Seeds dev, which holds no rows."];
    case "held": {
      const tables = seed.held.map((entry) => `${entry.table} (${entry.binding})`).join(", ");
      return [
        `dev holds rows in ${tables}, so it was not seeded.`,
        personDecision("seed", { flags: { "--env": LOCAL_ENVIRONMENT, "--redo": true } }),
      ];
    }
    case "media":
      return [
        `dev was not seeded: a fixture uploads media to Cloudflare, which setup never reaches. Run ${pithyCommand("seed", { flags: { "--env": LOCAL_ENVIRONMENT } })}.`,
      ];
    case "none":
      return [];
    default:
      seed satisfies never;
      return [];
  }
}
