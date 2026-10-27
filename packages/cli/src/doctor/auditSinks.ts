// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { buildSecretDispatcher } from "../capabilities/secretsDispatcher";
import { type CloudflareAccountSelection, cloudflareCredentials } from "../cloudflare/config";
import type { RemoteSkip } from "./environmentMigrations";

/**
 * **Where the audit trail is shipped, and whether each sink can be (#824).**
 *
 * `@pithy-sh/audit` ships the trail to sinks declared in `pithy.config.ts`, and a sink is only as good as the token
 * it reads. So doctor lists every sink each Worker declares — its profile, where it posts, what it filters on, and
 * whether it ships personal values — and asks each deployed environment's secrets manager whether the sink's token
 * is set. A token that is not set is a sink that retries every event until it dead-letters it.
 *
 * **It reports and never gates**, on the standard `failures.ts` states for an unbound secret: a project brought up
 * one environment at a time has staging's tokens before prod's, and that is not a fault this project's files
 * establish. `dev` is never asked: its secrets are local, and no manager answers for them.
 *
 * Structural, like the payments check: the CLI reads `auditSinks` off the composed capability and imports nothing
 * of `@pithy-sh/audit`.
 */

/** One declared sink, as a Worker composes it. */
export interface SinkLine {
  /** The Worker that composes audit with this sink. */
  worker: string;
  /** The sink's declared name. */
  sink: string;
  /** Its profile: `splunk-hec`, `datadog-logs` or `webhook`. */
  profile: string;
  /** Where it posts. The host only — a path or query may carry a key. */
  host: string;
  /** The action prefixes it takes, or empty for every action. */
  actions: string[];
  /** Whether it ships IP, user-agent and metadata values. */
  detail: boolean;
  /** The `@pithy-sh/secrets` name its token is read through. */
  secret: string;
}

/** Whether one deployed environment holds one sink's token. */
export type SinkSecretAnswer =
  | { env: string; secret: string; state: "set" | "unset" | "unreadable" }
  | { env: string; secret: string; state: "skipped"; reason: RemoteSkip };

/** What doctor learned about this project's sinks. */
export interface AuditSinksCheck {
  /** `not-applicable` with no sink, `ok` when every token is set, `findings` when one is not, `could-not-check` otherwise. */
  state: "ok" | "not-applicable" | "findings" | "could-not-check";
  /** Every sink every Worker declares. */
  sinks: SinkLine[];
  /** One answer per deployed environment per distinct token. */
  secrets: SinkSecretAnswer[];
}

/** One Worker, as this check addresses it. */
export interface AuditSinksWorker {
  name: string;
  dir: string;
}

/** Options for {@link checkAuditSinks}. */
export interface AuditSinksOptions {
  /** The project's name — the manager Workflow a token question is asked of. */
  project: string;
  /** The declared environments. `dev` is never asked. */
  environments: readonly string[];
  /** The Workers to look at, in report order. */
  workers: readonly AuditSinksWorker[];
  /** The Cloudflare account this project belongs to, or `null`. */
  account: CloudflareAccountSelection | null;
  /** Why a deployed read will not be attempted this run, or `null`. */
  remoteSkip: RemoteSkip | null;
  /** The composition seam — the compositions the report already took. */
  composeWorker: (worker: AuditSinksWorker, env: string) => Promise<{ capabilities: readonly Capability[] }>;
  /** Whether one environment's secrets manager holds a value under this name. Defaults to asking it. */
  secretSet?: (name: string, env: string) => Promise<boolean>;
}

/** The slice of the audit capability this reads. Structural, so the CLI imports nothing of the package. */
interface SinkSlice {
  profile: string;
  url: string;
  secret: string;
  actions?: string[];
  detail: boolean;
}

/** The composed audit capability's sinks, or an empty map. */
function sinksOf(capabilities: readonly Capability[]): Record<string, SinkSlice> {
  const audit = capabilities.find((capability) => capability.name === "audit");
  return (audit as { auditSinks?: Record<string, SinkSlice> } | undefined)?.auditSinks ?? {};
}

/** A URL's host, or the whole string when it does not parse. Never the path, which may carry a key. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The default question: the environment's secrets manager, asked through one dispatcher for the whole run. */
function askManager(account: CloudflareAccountSelection | null, project: string) {
  let dispatcher: ReturnType<typeof buildSecretDispatcher> | undefined;
  return async (name: string, env: string) => {
    if (dispatcher === undefined) {
      const credentials = cloudflareCredentials({ account });
      dispatcher = buildSecretDispatcher(credentials.accountId, credentials.apiToken, project);
    }
    return (await dispatcher).probe({ env: env as "staging" | "prod", name });
  };
}

/**
 * Every sink every Worker declares, and every deployed environment's answer for each distinct token. **Never
 * throws** — every failure is one of the states above.
 */
export async function checkAuditSinks(options: AuditSinksOptions): Promise<AuditSinksCheck> {
  const sinks: SinkLine[] = [];
  const seen = new Set<string>();
  let composedEverywhere = true;
  for (const worker of options.workers) {
    // The sinks are config, and config may differ per environment: every environment's composition is read, and a
    // sink is listed once per Worker by name.
    for (const env of options.environments) {
      let capabilities: readonly Capability[];
      try {
        ({ capabilities } = await options.composeWorker(worker, env));
      } catch {
        composedEverywhere = false;
        continue;
      }
      for (const [name, sink] of Object.entries(sinksOf(capabilities))) {
        const key = `${worker.name}\u0000${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sinks.push({
          worker: worker.name,
          sink: name,
          profile: sink.profile,
          host: hostOf(sink.url),
          actions: [...(sink.actions ?? [])],
          detail: sink.detail === true,
          secret: sink.secret,
        });
      }
    }
  }
  // No composition that loaded declares a sink. One that did not load is the environment configs block's finding,
  // reported there; it is not a reason to print an empty block here or to keep the report verbose.
  if (sinks.length === 0) return { state: "not-applicable", sinks: [], secrets: [] };

  const ask = options.secretSet ?? askManager(options.account, options.project);
  const secrets: SinkSecretAnswer[] = [];
  const names = [...new Set(sinks.map((line) => line.secret))];
  for (const env of options.environments) {
    if (env === LOCAL_ENVIRONMENT) continue;
    for (const secret of names) {
      if (options.remoteSkip !== null) {
        secrets.push({ env, secret, state: "skipped", reason: options.remoteSkip });
        continue;
      }
      try {
        secrets.push({ env, secret, state: (await ask(secret, env)) ? "set" : "unset" });
      } catch {
        secrets.push({ env, secret, state: "unreadable" });
      }
    }
  }
  if (secrets.some((answer) => answer.state === "unset")) return { state: "findings", sinks, secrets };
  const answered = composedEverywhere && secrets.every((answer) => answer.state === "set");
  return { state: answered ? "ok" : "could-not-check", sinks, secrets };
}

/** One line per sink, then one per environment and token that has something to say. */
export function describeAuditSinks(check: AuditSinksCheck): string[] {
  const lines: string[] = [];
  for (const line of check.sinks) {
    const filter = line.actions.length === 0 ? "every action" : `actions ${line.actions.join(", ")}`;
    const detail = line.detail ? "ships IP, user-agent and metadata" : "redacted";
    lines.push(
      `${line.worker}: ${line.sink} — ${line.profile} to ${line.host}; ${filter}; ${detail}; token ${line.secret}.`,
    );
  }
  for (const answer of check.secrets) {
    switch (answer.state) {
      case "set":
        lines.push(`${answer.env}: ${answer.secret} is set.`);
        break;
      case "unset":
        lines.push(
          `${answer.env}: ${answer.secret} is not set, so its sinks retry every event until it is dead-lettered. Run ${pithyCommand("secrets create", { args: [answer.secret], flags: { "--env": answer.env } })}.`,
        );
        break;
      case "skipped":
        lines.push(
          answer.reason === "offline"
            ? `${answer.env}: skipped — offline, so ${answer.secret} was not asked about.`
            : `${answer.env}: skipped — no Cloudflare credentials, so ${answer.secret} was not asked about.`,
        );
        break;
      case "unreadable":
        lines.push(`${answer.env}: could not ask whether ${answer.secret} is set.`);
        break;
    }
  }
  return lines;
}
