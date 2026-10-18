// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { WorkerDir } from "@pithy-sh/core/src/cli/command";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareCredentials } from "../cloudflare/config";
import { workerDirName } from "../project/workerIdentity";
import type { RemoteSkip } from "./environmentMigrations";
import { appDatabaseIdFromWrangler } from "./supportSearchTriggers";

/**
 * **What does this project's payments enforce, and who holds the whole product?** (#561)
 *
 * Two questions, both about allowances.
 *
 * **The meters, from the composition.** `@pithy-sh/payments` counts three things the kit writes — emails,
 * stored bytes, media items — and each meter is advisory until the config turns it on. So doctor names each
 * one, whether it is enforced, and whether a quota of its name is declared: an enforced meter with nothing
 * declared would refuse everyone, and the config refuses that at parse, but a declared quota left advisory is
 * a number that reads as a limit and binds nothing — worth a line, never a fault.
 *
 * **The unrestricted subjects, from each deployed database.** `unrestricted` is the largest grant the kit
 * has, and the only one whose reach grows by itself as names are declared. A privilege that size must not be
 * inferable only from a row nobody opens, so every environment's subjects holding it are listed by name, read
 * from `pithy_payments_overrides` over the D1 REST API — one `SELECT` per environment, the way the support
 * index check reads `sqlite_master`. It is not a fault: an Enterprise contract and the operator's own account
 * are both legitimately unrestricted. It is a fact an operator should see on every run.
 *
 * A project composing no payments reaches nothing and prints nothing.
 */

/** The meters the kit counts, in report order. Mirrors `KIT_METERS` in `@pithy-sh/payments` — a CLI must not import it. */
const METERS = ["emails", "storageBytes", "mediaItems"] as const;

/** One meter, as a Worker's payments composition configures it. */
export interface MeterLine {
  /** The Worker that composes payments. */
  worker: string;
  /** The meter. */
  meter: (typeof METERS)[number];
  /** Whether the quota of the same name binds. */
  enforced: boolean;
  /** Whether any entitlement, or the floor, declares a quota of that name. */
  quotaDeclared: boolean;
}

/** One deployed environment's unrestricted subjects, or why they were not read. */
export type EnvironmentUnrestricted =
  | {
      env: string;
      worker: string;
      directory: WorkerDir;
      /** Read. `subjects` is every `kind:id` holding `unrestricted`, possibly none. */
      state: "listed";
      subjects: string[];
    }
  | { env: string; worker: string; directory: WorkerDir; state: "not-provisioned" }
  | { env: string; worker: string; directory: WorkerDir; state: "skipped"; reason: RemoteSkip }
  | { env: string; worker: string; directory: WorkerDir; state: "unreadable" }
  | { env: string; worker: string; directory: WorkerDir; state: "not-composed" };

/** What doctor learned about this project's allowances. Listed positively, so a skip never reads as a pass. */
export interface PaymentsAllowancesCheck {
  /** `not-applicable` with no payments, `ok` when every read landed, `could-not-check` otherwise. */
  state: "ok" | "not-applicable" | "could-not-check";
  /** Every meter of every Worker that composes payments. */
  meters: MeterLine[];
  /** One answer per deployed environment per Worker that composes payments. */
  environments: EnvironmentUnrestricted[];
}

/** One Worker, as this check addresses it. */
export interface AllowancesWorker {
  name: string;
  dir: string;
}

/** Options for {@link checkPaymentsAllowances}. */
export interface PaymentsAllowancesOptions {
  /** The deployed environments to answer for. */
  environments: readonly string[];
  /** The Workers to look at, in report order. */
  workers: readonly AllowancesWorker[];
  /** The Cloudflare account this project belongs to, or `null`. */
  account: CloudflareAccountSelection | null;
  /** Why a deployed read will not be attempted this run, or `null`. */
  remoteSkip: RemoteSkip | null;
  /** The composition seam — the compositions the report already took. */
  composeWorker: (worker: AllowancesWorker, env: string) => Promise<{ capabilities: readonly Capability[] }>;
  /** The app `DB` id for one Worker in one environment, or `null`. */
  appDatabaseId?: (workerDir: string, env: string) => Promise<string | null>;
  /** The unrestricted subjects in one database, as `kind:id`. */
  readUnrestricted?: (databaseId: string) => Promise<string[]>;
}

/** The slice of a payments capability this reads: its resolved config's meters and declarations. */
interface PaymentsSlice {
  meters?: Record<string, { enforce?: boolean } | undefined>;
  entitlements?: Record<string, { quotas?: Record<string, unknown> }>;
  defaults?: { quotas?: Record<string, unknown> };
}

/** The composed payments config, or undefined. Structural, so the CLI imports nothing of the package. */
function paymentsSlice(capabilities: readonly Capability[]): PaymentsSlice | undefined {
  const payments = capabilities.find((capability) => capability.name === "payments");
  return (payments as { paymentsConfig?: PaymentsSlice } | undefined)?.paymentsConfig;
}

/** Every meter line one Worker's payments config states. */
export function meterLines(worker: string, config: PaymentsSlice): MeterLine[] {
  const declared = new Set<string>(Object.keys(config.defaults?.quotas ?? {}));
  for (const declaration of Object.values(config.entitlements ?? {})) {
    for (const name of Object.keys(declaration.quotas ?? {})) declared.add(name);
  }
  return METERS.map((meter) => ({
    worker,
    meter,
    enforced: config.meters?.[meter]?.enforce === true,
    quotaDeclared: declared.has(meter),
  }));
}

/** The default remote read: one `SELECT` over the D1 REST API. */
function readThroughRest(account: CloudflareAccountSelection | null): (databaseId: string) => Promise<string[]> {
  return async (databaseId) => {
    const clients = await cloudflareClients(cloudflareCredentials({ account }));
    const listed = await clients
      .d1(databaseId)
      .prepare(
        "SELECT subject_type, subject_id FROM pithy_payments_overrides WHERE unrestricted = 1 ORDER BY subject_type, subject_id",
      )
      .all<{ subject_type: string; subject_id: string }>();
    return (listed.results ?? []).map((row) => `${row.subject_type}:${row.subject_id}`);
  };
}

/**
 * Walk every Worker that composes payments: its meters from the composition, and its unrestricted subjects
 * from each deployed environment's database. **Never throws** — every failure is one of the states above.
 */
export async function checkPaymentsAllowances(options: PaymentsAllowancesOptions): Promise<PaymentsAllowancesCheck> {
  const appDatabaseId = options.appDatabaseId ?? appDatabaseIdFromWrangler;
  const readUnrestricted = options.readUnrestricted ?? readThroughRest(options.account);
  const meters: MeterLine[] = [];
  const seen = new Set<string>();
  const environments: EnvironmentUnrestricted[] = [];

  for (const env of options.environments) {
    for (const worker of options.workers) {
      const here = { env, worker: worker.name, directory: workerDirName(worker) };
      let capabilities: readonly Capability[];
      try {
        ({ capabilities } = await options.composeWorker(worker, env));
      } catch {
        environments.push({ ...here, state: "not-composed" });
        continue;
      }
      const config = paymentsSlice(capabilities);
      if (config === undefined) continue;
      if (!seen.has(worker.name)) {
        seen.add(worker.name);
        meters.push(...meterLines(worker.name, config));
      }

      const databaseId = await appDatabaseId(worker.dir, env).catch(() => null);
      if (databaseId === null) {
        environments.push({ ...here, state: "not-provisioned" });
        continue;
      }
      if (options.remoteSkip !== null) {
        environments.push({ ...here, state: "skipped", reason: options.remoteSkip });
        continue;
      }
      try {
        environments.push({ ...here, state: "listed", subjects: await readUnrestricted(databaseId) });
      } catch {
        environments.push({ ...here, state: "unreadable" });
      }
    }
  }

  if (meters.length === 0) return { state: "not-applicable", meters: [], environments: [] };
  const read = environments.every((answer) => answer.state === "listed" || answer.state === "not-provisioned");
  return { state: read ? "ok" : "could-not-check", meters, environments };
}

/** Whether the check has a subject to name — what keeps the report verbose. Never a failing exit. */
export function namesUnrestricted(check: PaymentsAllowancesCheck): boolean {
  return check.environments.some((answer) => answer.state === "listed" && answer.subjects.length > 0);
}

/** One line per meter, then one per environment that has something to say. */
export function describePaymentsAllowances(check: PaymentsAllowancesCheck): string[] {
  const lines: string[] = [];
  for (const line of check.meters) {
    const state = line.enforced ? "enforced" : "advisory";
    const quota = line.quotaDeclared ? `a ${line.meter} quota is declared` : `no ${line.meter} quota is declared`;
    lines.push(`${line.worker}: ${line.meter} meter ${state}; ${quota}.`);
  }
  for (const answer of check.environments) {
    switch (answer.state) {
      case "listed":
        lines.push(
          answer.subjects.length === 0
            ? `${answer.env}: no subject is unrestricted.`
            : `${answer.env}: unrestricted — ${answer.subjects.join(", ")}. Every quota unlimited and every feature on, for every name declared now or later.`,
        );
        break;
      case "not-provisioned":
        lines.push(
          `${answer.env}: not provisioned — env.${answer.env} has no DB database_id, so no override was read.`,
        );
        break;
      case "skipped":
        lines.push(
          answer.reason === "offline"
            ? `${answer.env}: skipped — offline, so no override was read.`
            : `${answer.env}: skipped — no Cloudflare credentials, so no override was read.`,
        );
        break;
      case "unreadable":
        lines.push(`${answer.env}: could not be read, so who is unrestricted is unknown.`);
        break;
      case "not-composed":
        lines.push(`${answer.env}: pithy.config.ts did not compose for ${answer.env}, so no override was read.`);
        break;
    }
  }
  return lines;
}
