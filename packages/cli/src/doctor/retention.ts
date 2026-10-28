// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { effectiveRetention } from "@pithy-sh/core/src/retention/composed";
import type { EffectiveRetention } from "@pithy-sh/core/src/retention/policy";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareCredentials } from "../cloudflare/config";
import type { RemoteSkip } from "./environmentMigrations";
import { appDatabaseIdFromWrangler } from "./supportSearchTriggers";

/**
 * **How long each Worker keeps what it keeps, and every legal hold standing.**
 *
 * A Worker's `retention` block is resolved over what it composes by the same function `createBackend` calls, so
 * doctor reports the windows the Worker will run, or the refusal it will deploy with: a block that does not parse,
 * or keeps a floored audit action under the floor, throws at assembly, and doctor says so first.
 *
 * Holds are asked of each deployed environment's app database, for every Worker that composes the control plane,
 * which is where they are placed. A standing hold keeps the report verbose and never fails the exit: a hold is a
 * decision counsel made, not a fault in the project.
 */

/** One Worker's retention, as it takes effect, or why it would not deploy. */
export interface RetentionLine {
  /** The Worker. */
  worker: string;
  /** The policy as it takes effect, or null when the block was refused. */
  retention: EffectiveRetention | null;
  /** Why the block was refused, or null. */
  refused: string | null;
}

/** One deployed environment's count of standing holds, for one Worker that composes the control plane. */
export type HoldAnswer =
  | { env: string; worker: string; state: "counted"; standing: number }
  | { env: string; worker: string; state: "not-provisioned" }
  | { env: string; worker: string; state: "skipped"; reason: RemoteSkip }
  | { env: string; worker: string; state: "unreadable" };

/** What doctor learned about this project's retention. */
export interface RetentionCheck {
  /**
   * `not-applicable` when no Worker declares a block or composes the control plane; `findings` when a block is
   * refused; `held` when a hold stands; `could-not-check` when a read did not land; `ok` otherwise.
   */
  state: "ok" | "not-applicable" | "findings" | "held" | "could-not-check";
  /** Every Worker's effective retention. */
  workers: RetentionLine[];
  /** Every deployed environment's standing holds. */
  holds: HoldAnswer[];
}

/** One Worker, as this check addresses it. */
export interface RetentionWorker {
  name: string;
  dir: string;
}

/** Options for {@link checkRetention}. */
export interface RetentionOptions {
  /** The declared environments. `dev` is never asked. */
  environments: readonly string[];
  /** The Workers to look at, in report order. */
  workers: readonly RetentionWorker[];
  /** The Cloudflare account this project belongs to, or `null`. */
  account: CloudflareAccountSelection | null;
  /** Why a deployed read will not be attempted this run, or `null`. */
  remoteSkip: RemoteSkip | null;
  /** The composition seam: what the Worker composes in an environment, and its `retention` block. */
  composeWorker: (
    worker: RetentionWorker,
    env: string,
  ) => Promise<{ capabilities: readonly Capability[]; retention?: unknown }>;
  /** The app `DB` id for one Worker in one environment, or `null`. */
  appDatabaseId?: (workerDir: string, env: string) => Promise<string | null>;
  /** How many holds stand in one database. */
  countHolds?: (databaseId: string) => Promise<number>;
}

/** The default remote read: one `SELECT` over the D1 REST API. */
function countThroughRest(account: CloudflareAccountSelection | null): (databaseId: string) => Promise<number> {
  return async (databaseId) => {
    const clients = await cloudflareClients(cloudflareCredentials({ account }));
    const counted = await clients
      .d1(databaseId)
      .prepare("SELECT count(*) AS n FROM pithy_controlplane_holds WHERE state = 'active'")
      .all<{ n: number }>();
    return Number(counted.results?.[0]?.n ?? 0);
  };
}

/** The message a refusal carries, or its string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every Worker's effective retention, from its first composing environment, and every deployed environment's
 * standing holds. **Never throws** — every failure is one of the states above.
 */
export async function checkRetention(options: RetentionOptions): Promise<RetentionCheck> {
  const appDatabaseId = options.appDatabaseId ?? appDatabaseIdFromWrangler;
  const countHolds = options.countHolds ?? countThroughRest(options.account);
  const workers: RetentionLine[] = [];
  const holds: HoldAnswer[] = [];
  let composedEverywhere = true;
  const reported = new Set<string>();

  for (const env of options.environments) {
    for (const worker of options.workers) {
      let composed: { capabilities: readonly Capability[]; retention?: unknown };
      try {
        composed = await options.composeWorker(worker, env);
      } catch {
        composedEverywhere = false;
        continue;
      }
      const controlPlane = composed.capabilities.some((capability) => capability.name === "controlplane");
      if (composed.retention === undefined && !controlPlane) continue;
      if (!reported.has(worker.name)) {
        reported.add(worker.name);
        try {
          workers.push({
            worker: worker.name,
            retention: effectiveRetention(composed.retention, composed.capabilities),
            refused: null,
          });
        } catch (error) {
          workers.push({ worker: worker.name, retention: null, refused: messageOf(error) });
        }
      }
      if (!controlPlane || env === LOCAL_ENVIRONMENT) continue;
      const here = { env, worker: worker.name };
      const databaseId = await appDatabaseId(worker.dir, env).catch(() => null);
      if (databaseId === null) {
        holds.push({ ...here, state: "not-provisioned" });
        continue;
      }
      if (options.remoteSkip !== null) {
        holds.push({ ...here, state: "skipped", reason: options.remoteSkip });
        continue;
      }
      try {
        holds.push({ ...here, state: "counted", standing: await countHolds(databaseId) });
      } catch {
        holds.push({ ...here, state: "unreadable" });
      }
    }
  }

  if (workers.length === 0) return { state: "not-applicable", workers: [], holds: [] };
  if (workers.some((line) => line.refused !== null)) return { state: "findings", workers, holds };
  if (holds.some((answer) => answer.state === "counted" && answer.standing > 0)) {
    return { state: "held", workers, holds };
  }
  const read = holds.every((answer) => answer.state === "counted" || answer.state === "not-provisioned");
  return { state: composedEverywhere && read ? "ok" : "could-not-check", workers, holds };
}

/** Days as an operator reads them: whole years where they are, else days. */
function days(value: number): string {
  return value % 365 === 0 ? `${value / 365}y` : `${value}d`;
}

/** One Worker's retention, in one line. */
function describeLine(line: RetentionLine): string {
  if (line.retention === null)
    return `${line.worker}: the retention block is refused, so it will not deploy. ${line.refused}`;
  const { purgeWindows, audit, classAges } = line.retention;
  const windows =
    purgeWindows.length === 0
      ? "no purge window"
      : purgeWindows.map((each) => `${each.subject} purge ${days(each.days)} (${each.source})`).join(", ");
  const trail =
    audit.defaultDays === null && !audit.rules.some((rule) => rule.source === "policy")
      ? "audit kept forever"
      : `audit ${audit.defaultDays === null ? "forever" : days(audit.defaultDays)} by default${
          audit.rules.length === 0
            ? ""
            : `, ${audit.rules.map((rule) => `${rule.prefix} ${days(rule.days)}${rule.source === "floor" ? " (floor)" : ""}`).join(", ")}`
        }`;
  const ages =
    classAges.length === 0
      ? "no class ages"
      : `inactive past ${classAges.map((age) => `${age.class} ${days(age.days)}`).join(", ")}`;
  return `${line.worker}: ${windows}; ${trail}; ${ages}.`;
}

/** One line per Worker, then one per environment that has something to say. */
export function describeRetention(check: RetentionCheck): string[] {
  const lines = check.workers.map(describeLine);
  for (const answer of check.holds) {
    switch (answer.state) {
      case "counted":
        if (answer.standing > 0) {
          lines.push(
            `${answer.env}: ${answer.worker} has ${answer.standing === 1 ? "1 legal hold" : `${answer.standing} legal holds`} standing. No purge, prune or inactivity deletion touches a held subject.`,
          );
        }
        break;
      case "skipped":
        lines.push(
          answer.reason === "offline"
            ? `${answer.env}: skipped — offline, so ${answer.worker}'s holds were not counted.`
            : `${answer.env}: skipped — no Cloudflare credentials, so ${answer.worker}'s holds were not counted.`,
        );
        break;
      case "unreadable":
        lines.push(`${answer.env}: could not count ${answer.worker}'s legal holds.`);
        break;
      case "not-provisioned":
        break;
    }
  }
  return lines;
}
