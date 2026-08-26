// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { parse } from "comment-json";
import { loadProject, requireProjectName } from "../project/config";
import { type CapabilitySet, isUnknown, projectCapabilitySet, type UnknownSet } from "../project/workerScope";
import { discoverWorkers } from "../project/workers";
import { AUDIT_DESTINATION_ENV } from "../provision/resources";
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
 * Where a CLI-recorded event came from. Referenced **type-only**, like {@link CliAuditEvent} above and
 * for the same reason: the shape stays the single one the audit package defines, while the CLI keeps
 * its guarded dynamic import for the runtime path and gains no hard dependency on an optional package.
 */
type AuditOrigin = import("@pithy-sh/audit/src/recorder").AuditOrigin;

/** Who a CLI-recorded event is attributed to. Type-only for the same reason as the two above. */
type ResolvedActor = import("@pithy-sh/audit/src/cli/resolveActor").ResolvedActor;

/**
 * The actor recorded when no Cloudflare token is at hand to name one.
 *
 * `system`, with a note — deliberately the same shape `resolveActor` falls back to when a token cannot
 * be attributed, so one filter finds every unattributed row rather than two. A person at a terminal is
 * not a system job, and this does not claim otherwise: it says the writer could not be named, which is
 * the true and useful thing. A command reaching a real Cloudflare resource always has a token, so this
 * is the local-only case — `pithy dashboard connect --env dev` against a Miniflare store touches no
 * account, and demanding an account credential to record it would be the wrong dependency.
 */
const UNATTRIBUTED: ResolvedActor = {
  actorType: "system",
  actorId: null,
  metadata: {
    actorResolutionFailed: true,
    note: "No Cloudflare API token in this environment, so the operator at the terminal could not be named.",
  },
};

/**
 * Records an audit event. Always safe to call: a no-op when auditing is unavailable, never throws.
 * The CLI counterpart of core's in-Worker {@link import("@pithy-sh/core/src/audit/recorder").AuditEmit}
 * seam, and deliberately the same shape — an always-callable function rather than an optional one — so a
 * call site never guards. The two differ only in their event type: the in-Worker emitter supplies the
 * actor, while the CLI resolves it from the token.
 */
export type CliAuditEmit = (event: CliAuditEvent) => Promise<void>;

/**
 * The emitter returned whenever auditing is unavailable: accept the event and drop it. The CLI analog of
 * core's {@link noopEmit}, which cannot be reused directly only because the two seams carry different event
 * types — the intent, and the guarantee that calling it is always safe, are identical.
 */
const NO_OP: CliAuditEmit = async () => {};

/**
 * The emitter returned when the project's capability set is **unknowable** — a Worker's `pithy.config.ts`
 * would not load, so whether this project composes `audit` cannot be answered from here (#455).
 *
 * It is deliberately *not* {@link NO_OP}. Eight commands built their emitter from a capability list
 * flattened by `.catch(() => [])`, which made "cannot tell" indistinguishable from "this project never
 * composed audit" — so one uninstalled capability package in a CI checkout let `pithy deploy --env prod`
 * ship every Worker, print `Done.`, exit 0, and write no row for a project that audits. This module's own
 * standard settles it: **an audit trail you cannot tell is broken is worse than none.** So every event
 * that would have been recorded names itself on the way past, on the same logger a dropped write uses.
 *
 * It still never throws. Auditing must not break the command it records — it just stops being silent.
 */
function unrecordable(reason: string): CliAuditEmit {
  const log = createCliLogger().child("audit");
  return async (event) => {
    log.error("audit event not recorded", {
      action: event.action,
      // The set's own diagnosis, which names the worker. Inventing one here is how the absent-config case
      // came to be reported as "a config will not load", pointing at a file that does not exist (#454).
      reason,
      action_required: "Fix it — pithy doctor names the fault — and re-run to record this event.",
    });
  };
}

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
 * Control-plane commands (`deploy`, `provision`, `feature destroy`) are remote *whatever* env
 * is named — the env only picks which database the record lands in — so they call {@link createCliAudit}
 * directly and are always audited.
 */
export async function createRemoteCliAudit(options: CreateCliAuditOptions): Promise<CliAuditEmit> {
  if (!isRemoteEnv(options.env)) return NO_OP;
  return createCliAudit(options);
}

/** Options for {@link createCliAudit}. */
/**
 * The origin a CLI-recorded event carries.
 *
 * `worker` and `version` are **always null**, and that is the accurate answer rather than a gap: a
 * `pithy` command runs in Node, not in a Worker, so no Worker recorded it and there is no Cloudflare
 * build id to name. (`pithy deploy` does learn the version of the Worker it *ships*, but that is a fact
 * about the deployed resource, not about the process writing the row, so it stays in the event's
 * metadata where it belongs.) `options.worker` is not the origin either — it is
 * a *lookup filter* for finding the audit database, so writing it here would attribute
 * `pithy migrate --worker api` to the `api` Worker, which did nothing.
 *
 * The project is resolved the same way every other name-composing command resolves it, and a failure to
 * resolve is reported as `null` rather than thrown: auditing must never break the command it records,
 * and a project with no `name` is exactly the broken state a `pithy doctor` run needs to survive.
 */
async function cliOrigin(projectDir: string, environment: string | null): Promise<AuditOrigin> {
  try {
    return { project: requireProjectName(await loadProject(projectDir)), environment, worker: null, version: null };
  } catch {
    return { project: null, environment, worker: null, version: null };
  }
}

/**
 * How a CLI audit reaches a database, and who it can name as the actor. Two shapes, because the second
 * one is what a caller holding an open handle actually has.
 *
 * **Resolved** is the ordinary case: `clients` and `apiToken` are both required, the audit database id
 * is read from a Worker's `wrangler.jsonc`, and the row is written over REST.
 *
 * **Injected** is for a command that already has the adopter's database open and must write *into that
 * one*. `pithy dashboard` is the case (#294): its lifecycle events record a row it just wrote through
 * the connection registry, and an event that landed in a separately-resolved database would be a record
 * of a write that did not happen there. On `dev` those are not even the same store — the registry's
 * handle is the local Miniflare one and a resolved id names the real remote database — so resolving
 * again would put the event somewhere the action never touched.
 *
 * With a handle injected the Cloudflare pair becomes optional, because it is no longer what finds the
 * database — it only names the actor, and a purely local action legitimately has neither. Absent, the
 * row is attributed to {@link UNATTRIBUTED}. The union is what keeps that from loosening the ordinary
 * case: drop `clients` without injecting a database and it does not compile.
 */
export type CliAuditTarget =
  | {
      /** Write into this already-open database rather than resolving one from `wrangler.jsonc`. */
      database: D1Database;
      /** Cloudflare clients, used only to name the actor here. Optional: a local action has none. */
      clients?: CloudflareClients;
      /** The active CF API token — the actor's identity. Optional for the same reason. */
      apiToken?: string;
    }
  | {
      /** Not injected, so the database is resolved from the project's `wrangler.jsonc`. */
      database?: undefined;
      /** The configured Cloudflare clients, used for the D1 write and to resolve the actor behind the token. */
      clients: CloudflareClients;
      /** The active CF API token — the actor's identity (a person locally, the CI token in automation). */
      apiToken: string;
    };

/** Everything a CLI audit needs beyond {@link CliAuditTarget}: what is being recorded, and where it belongs. */
export interface CliAuditContext {
  /** The project root — the parent of `apps/`, whose Workers' `wrangler.jsonc` resolve the audit database. */
  projectDir: string;
  /**
   * Which database audit rows are **written to** — a routing choice, not a statement about the action.
   *
   * These are two different things and conflating them put a false value in the trail. Eight commands
   * hardcode this to `dev` precisely *because* they span environments: a provisioning run touches every
   * managed environment at once, and `pithy feature` deliberately writes to the project's durable
   * database rather than the feature's, which does not exist yet at `provision` and is deleted by
   * `destroy`. Recording that routing choice as the environment acted on would claim every production
   * credential write happened in dev.
   */
  env: string;
  /**
   * The environment the command acts on, recorded in each row's `environment` column.
   *
   * Omit it when one invocation spans several environments — `null` reads as "not recorded", which is
   * true, where naming one of them is not. Such a command should instead set `environment` on each
   * event it emits, which is where the real answer is known.
   */
  actedOn?: string | null;
  /**
   * The capabilities in play — auditing is wired only when `audit` is among them.
   *
   * An {@link UnknownSet} is the third state and is not `[]`: it says the project's capability set could
   * not be determined, and it produces a loud emitter carrying that set's own diagnosis rather than a
   * silent one. See {@link unrecordable}.
   */
  capabilities: CapabilitySet;
  /** Restrict the audit-database lookup to this Worker (a command's `--worker`). Optional. */
  worker?: string;
}

/** Everything {@link createCliAudit} takes: what is being recorded, and how it reaches a database. */
export type CreateCliAuditOptions = CliAuditContext & CliAuditTarget;

/**
 * Build the audit emitter for a command. Returns a no-op emitter — never null — so call sites stay free
 * of `if (audit)` branching; that unconditional shape is what keeps auditing from being quietly dropped
 * as commands are added. The actor is resolved once and cached, so a command emitting several events
 * costs one identity lookup.
 */
export async function createCliAudit(options: CreateCliAuditOptions): Promise<CliAuditEmit> {
  const capabilities = options.capabilities;
  if (isUnknown(capabilities)) return unrecordable(capabilities.unknown);
  if (!capabilities.some((capability) => capability.name === "audit")) return NO_OP;

  // An injected handle skips the lookup entirely — it is already the database the action wrote to, and
  // resolving a second one is how an event ends up recorded against a store nothing touched.
  const database =
    options.database ??
    (await (async () => {
      const databaseId = await resolveAuditDatabaseId(options.projectDir, options.env, options.worker);
      return databaseId === undefined ? undefined : (options.clients?.d1(databaseId) as unknown as D1Database);
    })());
  if (!database) return NO_OP;

  let emitFromCLI: typeof import("@pithy-sh/audit/src/cli/emitFromCLI").emitFromCLI;
  let createCachedActorResolver: typeof import("@pithy-sh/audit/src/cli/resolveActor").createCachedActorResolver;
  try {
    ({ emitFromCLI } = await import("@pithy-sh/audit/src/cli/emitFromCLI"));
    ({ createCachedActorResolver } = await import("@pithy-sh/audit/src/cli/resolveActor"));
  } catch {
    return NO_OP; // audit isn't installed in this project — nothing to record through.
  }

  const origin = await cliOrigin(options.projectDir, options.actedOn ?? null);
  // Both scopes, because the token decides which one is valid: a `cfut_*` token reads `/user/*`, a
  // `cfat_*` token reads `/accounts/{id}/tokens/*` and is rejected by every user endpoint.
  //
  // No token means nothing to read either scope with, and the event is written unattributed rather than
  // dropped: an unnamed record of a real change beats no record of it.
  const clients = options.clients;
  const apiToken = options.apiToken;
  const resolveActor =
    clients && apiToken
      ? createCachedActorResolver(apiToken, { user: clients.user(), accountTokens: clients.accountTokens() })
      : async () => UNATTRIBUTED;
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
          // A per-event environment beats the emitter-wide one, for the commands that span several in
          // one run. Passed as a first-class origin field, never back into `metadata` — that bag is
          // where this information used to hide, unqueryable and set by only some emitters.
          ...(event.environment !== undefined ? { environment: event.environment } : {}),
          metadata: { ...(event.metadata ?? {}) },
        },
        await resolveActor(),
        { origin, onError: (error: unknown) => log.error("audit event dropped", { error }) },
      );
    } catch (error) {
      // Resolving the actor can fail too (a revoked token, a network blip). Auditing must never break
      // the command it records, so this is the outer belt to emitFromCLI's own braces.
      log.error("audit event dropped", { error });
    }
  };
}

/** Everything {@link createProjectCliAudit} needs: where the project is, and who is acting. */
export interface ProjectCliAuditOptions {
  /** The project root — the parent of `apps/`. */
  projectDir: string;
  /** The Cloudflare account id. Absent or empty leaves the emitter inert — there is nowhere to write. */
  accountId: string | undefined;
  /** The active CF API token — the actor's identity. Absent or empty leaves the emitter inert. */
  apiToken: string | undefined;
  /**
   * Which database rows land in — a routing choice, not a statement about the action. Defaults to `"dev"`,
   * the convention for a command that spans every managed environment in one run and so has no single
   * environment to key on. See {@link CliAuditContext.env}.
   */
  env?: string;
  /** The environment acted on, when one invocation names exactly one. See {@link CliAuditContext.actedOn}. */
  actedOn?: string | null;
  /** Restrict the audit-database lookup to this Worker (a command's `--worker`). */
  worker?: string;
}

/**
 * The audit emitter for a command that records against the **project as a whole** — `deploy`, and the
 * provisioning commands (`email`, `media`, `payments`, `storage`, `support`, `testers`, `turnstile`).
 *
 * One helper rather than eight copies, which is the point (#455). Each of those commands carried its own
 * three-line `buildAudit` ending in `.catch(() => [])`, and every copy folded "a Worker config will not
 * load" into "this project composed nothing" — so a project that audits shipped unaudited, exited 0, and
 * said nothing. Threading the third state is a property of the *set* of call sites, exactly like a
 * migration order or a table prefix: it is only true if no copy is left behind, so there is one copy.
 *
 * Capabilities come from {@link projectCapabilitySet} — `audit` composed by any Worker means the project
 * has a trail, and an unknowable set reaches {@link createCliAudit} carrying the reason it is unknowable.
 */
export async function createProjectCliAudit(options: ProjectCliAuditOptions): Promise<CliAuditEmit> {
  const { accountId, apiToken } = options;
  // No credentials is not the same fact and is not this module's to shout about: there is no REST client
  // to write a row with, and every one of these commands refuses on the same absence a moment later.
  if (!accountId || !apiToken) return NO_OP;
  return createCliAudit({
    projectDir: options.projectDir,
    env: options.env ?? AUDIT_DESTINATION_ENV,
    ...(options.actedOn !== undefined ? { actedOn: options.actedOn } : {}),
    capabilities: await projectCapabilitySet(options.projectDir),
    ...(options.worker !== undefined ? { worker: options.worker } : {}),
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}
