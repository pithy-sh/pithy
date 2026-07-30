// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { parse } from "comment-json";
import { discoverWorkers } from "../project/workers";
import { createCliLogger } from "../terminal/logger";

/**
 * The one way a CLI command records an audit event.
 *
 * Auditing is a **first-class deliverable, not an optional extra** (CLAUDE.md §Security): every
 * security-relevant action a command takes — minting a credential, changing a schema, deploying,
 * creating or destroying infrastructure — should leave a record of what happened and who did it. But
 * `@pithy-sh/audit` is an optional capability an adopter may not have composed, and the CLI must never
 * hard-depend on it. This module reconciles the two: commands call `emit` unconditionally, and the
 * helper decides whether there is anywhere to write.
 *
 * Three things must all hold for an event to land: the project composes the `audit` capability, the
 * package resolves from the project's own install (loaded by guarded dynamic import), and the target
 * environment's app database is resolvable. When any is missing the returned emitter is a no-op, so a
 * call site never needs a conditional. Writes are **non-fatal** — a failed audit write is logged and
 * swallowed, never allowed to break the command it was recording.
 */

/**
 * The audit event a CLI command describes: every field except the actor, which is resolved from the CF
 * token rather than passed. This is `@pithy-sh/audit`'s own `CliAuditEvent`, referenced by a **type-only**
 * import so it is erased at runtime — the CLI keeps its guarded dynamic import for the *runtime* path and
 * gains no hard dependency, while the event shape stays the single one defined in the audit package. A
 * parallel interface here would silently drift from `AuditEventInput` the first time a field is added.
 */
export type CliAuditEvent = import("@pithy-sh/audit/src/cli/emitFromCLI").CliAuditEvent;

/**
 * Records an audit event. Always safe to call: a no-op when auditing is unavailable, never throws.
 * The CLI counterpart of core's in-Worker {@link import("@pithy-sh/core/src/audit/recorder").AuditEmit}
 * seam, and deliberately the same shape — an always-callable function rather than an optional one — so a
 * call site never guards. The two differ only in their event type: the in-Worker emitter supplies the
 * actor, while the CLI resolves it from the token.
 */
export type CliAuditEmit = (event: CliAuditEvent) => Promise<void>;

/**
 * The emitter returned whenever auditing is unavailable: accept the event and drop it. The CLI analogue of
 * core's {@link noopEmit}, which cannot be reused directly only because the two seams carry different event
 * types — the intent, and the guarantee that calling it is always safe, are identical.
 */
const NO_OP: CliAuditEmit = async () => {};

/** The `wrangler.jsonc` slice the audit target is resolved from: the app database, per environment. */
interface WranglerAppConfig {
  d1_databases?: { binding: string; database_id?: string }[];
  env?: Record<string, { d1_databases?: { binding: string; database_id?: string }[] } | undefined>;
}

/** One Worker's `DB` database id for an environment, or undefined when the file or the id is absent. */
async function databaseIdIn(workerDir: string, env: string): Promise<string | undefined> {
  try {
    const config = parse(await readFile(join(workerDir, "wrangler.jsonc"), "utf8")) as unknown as WranglerAppConfig;
    const stanza = env === "dev" ? config : config.env?.[env];
    return stanza?.d1_databases?.find((database) => database.binding === "DB")?.database_id;
  } catch {
    return undefined;
  }
}

/**
 * The app database's id for an environment — where audit rows live. Every Worker lives in `apps/<name>/`
 * with its own `wrangler.jsonc`, so the id comes from a Worker's file: `dev` reads its top-level bindings,
 * every other environment its `env.<name>` stanza.
 *
 * **Which Worker?** `worker` names one when the caller has an explicit `--worker`. Otherwise this takes the
 * first discovered Worker that declares a `DB` id for the environment — deliberately *not* an
 * ambiguity error. Workers share a resource by declaring the same binding name, so every Worker with a `DB`
 * binding points at the one app database; and auditing must never break the command it is recording, which
 * an "ambiguous, pass --worker" throw would do the moment a project grew a second Worker. Undefined when no
 * Worker resolves one, which leaves the emitter inert.
 */
export async function resolveAuditDatabaseId(
  projectDir: string,
  env: string,
  worker?: string,
): Promise<string | undefined> {
  const workers = await discoverWorkers(projectDir).catch(() => []);
  const targets =
    worker === undefined
      ? workers
      : workers.filter((candidate) => candidate.name === worker || candidate.dir.endsWith(`/${worker}`));
  for (const target of targets) {
    const id = await databaseIdIn(target.dir, env);
    if (id) return id;
  }
  return undefined;
}

/**
 * Whether an env-scoped operation reaches a **remote** system. `dev` is the local Miniflare store under
 * `.wrangler/`; every other environment resolves to a real Cloudflare resource over REST.
 *
 * This is the line auditing is drawn on: an action is recorded when it changes something outside the
 * developer's machine — from their own environment, from CI, or in production — and not otherwise. A local
 * `dev` run changes nothing shared, so there is nothing to record; and it must not *try*, because `dev`
 * resolves to the top-level `database_id`, which is a real remote database (wrangler requires one and only
 * emulates it locally). Auditing a local action would mean a credentialed network write into a database the
 * action never touched.
 */
export function isRemoteEnv(env: string): boolean {
  return env !== "dev";
}

/**
 * {@link createCliAudit}, but only for operations whose target environment decides whether they are remote
 * — the **data-plane** commands (`seed`, `migrate`, a `--drop`), which run against local Miniflare for `dev`
 * and against real Cloudflare otherwise. A local run gets an inert emitter.
 *
 * Control-plane commands (`deploy`, provisioning, `feature provision`/`destroy`) are remote *whatever* env
 * is named — the env only picks which database the record lands in — so they call {@link createCliAudit}
 * directly and are always audited.
 */
export async function createRemoteCliAudit(options: CreateCliAuditOptions): Promise<CliAuditEmit> {
  if (!isRemoteEnv(options.env)) return NO_OP;
  return createCliAudit(options);
}

/** Options for {@link createCliAudit}. */
export interface CreateCliAuditOptions {
  /** The project root — the parent of `apps/`, whose Workers' `wrangler.jsonc` resolve the audit database. */
  projectDir: string;
  /** The environment being acted on, which selects the database audit rows are written to. */
  env: string;
  /** The capabilities in play — auditing is wired only when `audit` is among them. */
  capabilities: readonly Capability[];
  /** Restrict the audit-database lookup to this Worker (a command's `--worker`). Optional. */
  worker?: string;
  /** The configured Cloudflare clients, used for the D1 write and to resolve the actor behind the token. */
  clients: CloudflareClients;
  /** The active CF API token — the actor's identity (a person locally, the CI token in automation). */
  apiToken: string;
}

/**
 * Build the audit emitter for a command. Returns a no-op emitter — never null — so call sites stay free
 * of `if (audit)` branching; that unconditional shape is what keeps auditing from being quietly dropped
 * as commands are added. The actor is resolved once and cached, so a command emitting several events
 * costs one identity lookup.
 */
export async function createCliAudit(options: CreateCliAuditOptions): Promise<CliAuditEmit> {
  if (!options.capabilities.some((capability) => capability.name === "audit")) return NO_OP;

  const databaseId = await resolveAuditDatabaseId(options.projectDir, options.env, options.worker);
  if (!databaseId) return NO_OP;

  let emitFromCLI: typeof import("@pithy-sh/audit/src/cli/emitFromCLI").emitFromCLI;
  let createCachedActorResolver: typeof import("@pithy-sh/audit/src/cli/resolveActor").createCachedActorResolver;
  try {
    ({ emitFromCLI } = await import("@pithy-sh/audit/src/cli/emitFromCLI"));
    ({ createCachedActorResolver } = await import("@pithy-sh/audit/src/cli/resolveActor"));
  } catch {
    return NO_OP; // audit isn't installed in this project — nothing to record through.
  }

  const database = options.clients.d1(databaseId) as unknown as D1Database;
  const resolveActor = createCachedActorResolver(options.apiToken, options.clients.user());
  // Surface a dropped audit write through the CLI logger. Without this a lost record is invisible —
  // and an audit trail you cannot tell is broken is worse than none.
  const log = createCliLogger().child("audit");

  return async (event) => {
    try {
      await emitFromCLI(
        database,
        {
          action: event.action,
          outcome: event.outcome,
          severity: event.severity ?? "info",
          ...(event.resourceType !== undefined ? { resourceType: event.resourceType } : {}),
          ...(event.resourceId !== undefined ? { resourceId: event.resourceId } : {}),
          metadata: { env: options.env, ...(event.metadata ?? {}) },
        },
        await resolveActor(),
        { onError: (error: unknown) => log.error("audit event dropped", { error }) },
      );
    } catch (error) {
      // Resolving the actor can fail too (a revoked token, a network blip). Auditing must never break
      // the command it records, so this is the outer belt to emitFromCLI's own braces.
      log.error("audit event dropped", { error });
    }
  };
}
