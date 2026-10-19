// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { type Command, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { VaultTableStats } from "@pithy-sh/secrets/src/tables/stats";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { unprovisionedDatabases, type WorkerScope } from "../migrations/run";
import { type DeclaredTable, declaredTablesOf, readVaultTables, secretTablesReport } from "../secretTables/report";
import type { RemoteSkip } from "./environmentMigrations";

/**
 * **The `Secret tables:` line — which tables the project declares, and whether every row in each
 * environment is on the newest key (#524).**
 *
 * A declared secret table (`defineSecretTable`) holds customers' credentials, re-encrypted row by row by the
 * at-rest rotation. A pass that stopped partway across a large table leaves rows on the previous key, and
 * nothing fails: they still open. So the spread is said here, per environment, from the same read
 * `pithy secrets tables` prints — counts and key versions, never a value and never an owner.
 *
 * **It reports and never fails the exit.** A rotation can be mid-pass while doctor runs, and the remedy is the
 * next scheduled pass rather than a command anybody types, so a red CI over it would be a surprise rather than
 * a diagnosis. A row behind keeps the report verbose; a skipped read says so, because a skip that printed
 * nothing would read like a vault that is fine.
 */

/** One environment's answer. */
export type EnvironmentSecretTables =
  | {
      /** The environment this answer is about, and the only one it was taken from. */
      env: string;
      /** The vault answered. */
      state: "read";
      /** The newest key version any row is sealed under, or `null` for an empty vault. */
      newestKeyVersion: number | null;
      /** Rows in declared tables below that version. */
      behind: number;
      /** Declared tables whose migration has not run in this environment. */
      notMigrated: string[];
    }
  | {
      env: string;
      /** The environment's stanza names no `SECRETS` database, so there is nothing to read. */
      state: "not-provisioned";
    }
  | {
      env: string;
      /** A deployed read that was not attempted. */
      state: "skipped";
      /** Why it was not. */
      reason: RemoteSkip;
    }
  | {
      env: string;
      /** The read threw. Nothing of what it threw is kept: a D1 read throws with ids and queries in it (#350). */
      state: "unreadable";
    }
  | {
      env: string;
      /** A Worker's `pithy.config.ts` threw when evaluated for this environment. */
      state: "not-composed";
    };

/** What the check established. */
export type SecretTablesState = "ok" | "not-applicable" | "could-not-check" | "findings";

/** What `doctor` learned about the project's declared secret tables. */
export interface SecretTablesCheck {
  state: SecretTablesState;
  /** Every table the project declares, from `dev`'s composition. */
  declared: DeclaredTable[];
  /** One answer per environment, `dev` first. */
  environments: EnvironmentSecretTables[];
}

/** One Worker as this check addresses it. */
export interface SecretTablesWorker {
  name: string;
  dir: string;
}

/** Options for {@link checkSecretTables}. */
export interface SecretTablesOptions {
  /** The project root. */
  projectDir: string;
  /** Every environment to answer for: `dev`, then each declared one. */
  environments: readonly string[];
  /** The project's Workers. */
  workers: readonly SecretTablesWorker[];
  /** The Cloudflare account this project belongs to, or `null` when it names none (#234). */
  account: CloudflareAccountSelection | null;
  /** Why a deployed read will not be attempted this run, or `null` when it will. Never consulted for `dev`. */
  remoteSkip: RemoteSkip | null;
  /** Composition seam — `pithy doctor` hands in the compositions its report already took (#595). */
  composeWorker: (worker: SecretTablesWorker, env: string) => Promise<{ capabilities: readonly Capability[] }>;
  /** Vault seam. Defaults to {@link readVaultTables}. */
  readVault?: (env: string, workers: WorkerScope[]) => Promise<VaultTableStats>;
}

/**
 * Answer every environment. **Never throws**: it is a report's contributor, and every way it can fail is one of
 * the states above. Composition first, because it decides whether there is anything to ask; provisioning from
 * files second, so an unprovisioned environment answers offline; the skip third; the read last.
 */
export async function checkSecretTables(options: SecretTablesOptions): Promise<SecretTablesCheck> {
  const readVault =
    options.readVault ??
    ((env: string, workers: WorkerScope[]) =>
      readVaultTables({ projectDir: options.projectDir, env, account: options.account, workers }));

  let declared: DeclaredTable[] | null = null;
  const environments: EnvironmentSecretTables[] = [];
  for (const env of options.environments) {
    let workers: WorkerScope[];
    try {
      workers = await Promise.all(
        options.workers.map(async (worker) => ({
          name: worker.name,
          dir: worker.dir,
          capabilities: [...(await options.composeWorker(worker, env)).capabilities],
        })),
      );
    } catch {
      environments.push({ env, state: "not-composed" });
      continue;
    }
    const here = declaredTablesOf(workers);
    if (declared === null) declared = here;
    if (here.length === 0) continue;

    const unprovisioned = await unprovisionedDatabases(env, workers).catch(() => []);
    if (unprovisioned.some((database) => database.binding === "SECRETS")) {
      environments.push({ env, state: "not-provisioned" });
      continue;
    }
    if (env !== LOCAL_ENVIRONMENT && options.remoteSkip !== null) {
      environments.push({ env, state: "skipped", reason: options.remoteSkip });
      continue;
    }
    let report: ReturnType<typeof secretTablesReport>;
    try {
      report = secretTablesReport(here, await readVault(env, workers));
    } catch {
      environments.push({ env, state: "unreadable" });
      continue;
    }
    environments.push({
      env,
      state: "read",
      newestKeyVersion: report.newestKeyVersion,
      behind: report.behind,
      notMigrated: report.tables.filter((table) => table.state === "not-migrated").map((table) => table.table),
    });
  }

  const tables = declared ?? [];
  if (tables.length === 0 && environments.every((answer) => answer.state !== "not-composed")) {
    return { state: "not-applicable", declared: [], environments: [] };
  }
  const state: SecretTablesState = environments.some((answer) => answer.state === "read" && answer.behind > 0)
    ? "findings"
    : environments.every((answer) => answer.state === "read")
      ? "ok"
      : "could-not-check";
  return { state, declared: tables, environments };
}

/**
 * The command that rights one environment's answer, or `null` — `pithy doctor --json`'s `fix` (#697). A table
 * declared and not migrated is what `pithy migrate` closes. A row behind the newest key has no command: the next
 * scheduled at-rest pass is what moves it.
 */
export function secretTablesFix(answer: EnvironmentSecretTables): Command | null {
  if (answer.state !== "read" || answer.notMigrated.length === 0) return null;
  return pithyCommand("migrate", { flags: { "--env": answer.env } });
}

/** `1 row`, `12 rows`. */
function rows(count: number): string {
  return `${count} ${count === 1 ? "row" : "rows"}`;
}

/**
 * The block's lines: the declared tables, then one line per environment. A row behind is flagged with the
 * count and the key it is not on; a table not migrated names the command that migrates it.
 */
export function describeSecretTables(check: SecretTablesCheck): string[] {
  const lines = [
    check.declared.length === 0
      ? "none declared"
      : `${check.declared.map((table) => `${table.table} (${table.keys.join(", ")})`).join(", ")}`,
  ];
  for (const answer of check.environments) {
    switch (answer.state) {
      case "read": {
        const parts: string[] = [];
        if (answer.behind > 0 && answer.newestKeyVersion !== null) {
          parts.push(
            `${rows(answer.behind)} not on key v${answer.newestKeyVersion} — the last at-rest rotation did not reach ${answer.behind === 1 ? "it" : "them"}.`,
          );
        } else if (answer.newestKeyVersion !== null) {
          parts.push(`every row on key v${answer.newestKeyVersion}.`);
        } else {
          parts.push("no rows yet.");
        }
        if (answer.notMigrated.length > 0) {
          parts.push(
            `${answer.notMigrated.join(", ")} not migrated. Run ${pithyCommand("migrate", { flags: { "--env": answer.env } })}.`,
          );
        }
        lines.push(`${answer.env}: ${parts.join(" ")}`);
        break;
      }
      case "not-provisioned":
        lines.push(
          `${answer.env}: not provisioned — env.${answer.env} has no SECRETS database_id, so there is nothing to read.`,
        );
        break;
      case "skipped":
        lines.push(
          answer.reason === "offline"
            ? `${answer.env}: skipped — offline, so no table was read.`
            : `${answer.env}: skipped — no Cloudflare credentials, so no table was read.`,
        );
        break;
      case "unreadable":
        lines.push(`${answer.env}: could not be read, so whether every row is on the newest key is unknown.`);
        break;
      case "not-composed":
        lines.push(`${answer.env}: pithy.config.ts did not compose for ${answer.env}, so no table was read.`);
        break;
    }
  }
  return lines;
}
