// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { messageOf } from "@pithy-sh/core/src/error/pithyError";
import {
  type GenerateDevVarsOptions,
  type GenerateDevVarsResult,
  generateDevVars as generateDevVarsDefault,
} from "../devSecrets/generate";
import { renderDevSecretsNotes, renderDevVarsNotes } from "../devSecrets/report";
import { type DevSecretsSeedReport, seedProjectDevSecrets } from "../devSecrets/seed";
import { type DevConfig, devConfigPath, readDevConfig } from "../feature/devConfig";
import { type DevSet, resolveDevSet } from "./devSet";
import { type EnsureDevConfigDeps, ensureDevConfig } from "./orchestrator";

/**
 * **What `pithy dev` does before it starts anything, and nothing after (#764).**
 *
 * Three steps, each the one `startDev` takes, through the same functions: every member of the dev set — the
 * `apps/` Workers and every capability host they compose — gets a pinned port in `.dev.config.json`, assigned
 * from the machine's registry and never probed; every app Worker gets its generated `.dev.vars`; and the dev
 * secrets reach the local `SECRETS` store. Then it returns. Nothing is spawned, no port is bound, and no
 * process is left behind — which is what lets `pithy setup` run it and exit, and lets CI run setup at all.
 *
 * **Ports over the whole set, never a subset.** `buildDevConfig` rebuilds its map from the members it is
 * handed, so a narrower call would delete every other member's pin. `startDev` makes the same decision over
 * the same set, so a port setup assigns is the port the next `pithy dev` binds.
 *
 * **Every step is idempotent by content.** A pinned set allocates nothing, a `.dev.vars` already holding its
 * bytes is not rewritten, and a seeded secret is not seeded again — so a second run reports nothing moved.
 */

/** What preparing did, or under `dryRun` would do. */
export interface PreparedDev {
  /** The pinned ports, as written. `null` under `dryRun`, which writes none. */
  dev: DevConfig | null;
  /** Whether a member gained a port this run — a first run, or a Worker added since the last. */
  allocated: boolean;
  /** Worker directories whose `.dev.vars` this run wrote. Empty under `dryRun`. */
  devVars: string[];
  /** Every app Worker directory a `.dev.vars` is generated into — what a dry run plans. */
  devVarsDirs: string[];
  /** Dev secrets seeded into the local store this run. Empty under `dryRun`. */
  seededSecrets: string[];
  /** Lines for whoever is reading: a `.dev.vars` left alone, a store that would not open. */
  notes: string[];
}

/** What {@link prepareDevCheckout} needs. Every seam defaults to the real implementation. */
export interface PrepareDevOptions {
  /** The checkout root. */
  projectDir: string;
  /** Decide, and write nothing. */
  dryRun?: boolean;
  /** Dev-set seam (default: {@link resolveDevSet}). */
  resolveSet?: (projectDir: string) => Promise<DevSet>;
  /** Seams handed to {@link ensureDevConfig}: the registry path, the checkout root, the branch. */
  ensureDeps?: EnsureDevConfigDeps;
  /** `.dev.vars` generation seam (default: the real generator). */
  generateDevVars?: (options: GenerateDevVarsOptions) => Promise<GenerateDevVarsResult>;
  /** Dev-secrets seeding seam (default: {@link seedProjectDevSecrets}). */
  seedSecrets?: (projectDir: string) => Promise<DevSecretsSeedReport>;
}

/** Pin ports, generate `.dev.vars`, seed the dev secrets — or, under `dryRun`, say which would happen. */
export async function prepareDevCheckout(options: PrepareDevOptions): Promise<PreparedDev> {
  const { projectDir } = options;
  const set = await (options.resolveSet ?? ((dir: string) => resolveDevSet({ projectDir: dir })))(projectDir);
  const members = set.members.map((member) => member.worker);
  const appDirs = set.members.filter((member) => member.kind === "app").map((member) => member.worker.dir);
  const notes = [...set.notes];

  const existing = await readDevConfig(devConfigPath(projectDir));
  const allocated = existing === null || members.some((worker) => existing.workers[worker.name] === undefined);
  if (options.dryRun) {
    return { dev: null, allocated, devVars: [], devVarsDirs: appDirs, seededSecrets: [], notes };
  }

  // Ports first: a `.dev.vars` is generated against no address, but a prepared seed set reads this file.
  const dev = allocated
    ? await ensureDevConfig({ projectDir, workers: members, existing, ...(options.ensureDeps ?? {}) })
    : existing;

  const generated = await (options.generateDevVars ?? generateDevVarsDefault)({ projectDir, workerDirs: appDirs });
  notes.push(...renderDevVarsNotes(generated), ...generated.unresolvable);

  // Non-fatal, as it is in `pithy dev`: a store that cannot open is a sentence naming why, and the run that
  // follows still has every port and every `.dev.vars` it came for.
  let seededSecrets: string[] = [];
  try {
    const report = await (options.seedSecrets ?? ((dir: string) => seedProjectDevSecrets({ projectDir: dir })))(
      projectDir,
    );
    seededSecrets = report.seeded;
    // What was seeded is reported as data; every other line the seeder has is a note.
    notes.push(...renderDevSecretsNotes({ ...report, seeded: [] }));
  } catch (error) {
    notes.push(`Secrets not seeded. ${messageOf(error)}`);
  }

  return { dev, allocated, devVars: generated.generated, devVarsDirs: appDirs, seededSecrets, notes };
}
