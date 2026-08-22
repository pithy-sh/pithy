// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { type ControlPlaneAuditAction, ControlPlaneAuditActions } from "@pithy-sh/core/src/controlPlane/audit/actions";
import { ControlPlaneConnection, type RegisteredKey } from "@pithy-sh/core/src/controlPlane/data/connection";
import { activeKeys, appendKey as appendRegisteredKey } from "@pithy-sh/core/src/controlPlane/data/keyLifecycle";
import {
  CONTROL_PLANE_CONNECTIONS_TABLE,
  type ControlPlaneDatabase,
  controlPlaneDatabase,
} from "@pithy-sh/core/src/controlPlane/data/tables";
import {
  ControlPlaneKeyConflictError,
  ControlPlaneNotConnectedError,
} from "@pithy-sh/core/src/controlPlane/error/errors";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { CliAuditEmit, CliAuditEvent } from "../audit/cliAudit";
import { type CloudflareAccountSelection, cloudflareCredentials } from "../cloudflare/config";
import { discoverWorkers } from "../project/workers";
import { openSeedDriver, type SeedDriver } from "../seed/drivers";
import { createCliLogger } from "../terminal/logger";

/**
 * The adopter's side of the control-plane registration: the `pithy_controlplane_connections` row, read
 * and written from the CLI.
 *
 * **Connection is project-wide, per environment — never per Worker** (docs/CONTROL-PLANE.md §15).
 * Workers share a resource by declaring the same binding name, so one user record lives in one D1 that
 * several Workers touch; a per-Worker credential would produce a dashboard where a user is visible in
 * one pane and absent from another. So the row is keyed on `environment`, and a Worker is only how the
 * CLI *finds* the database.
 *
 * Two rules this module does not get to bend. Every read is `ControlPlaneConnection.parse` and every
 * write is `.encode` — the row holds dates as ms-epoch and scopes and keys as JSON, and the codecs are
 * the only thing that knows that. And a key is appended through core's `appendKey`, never by touching
 * the array here: the ordering that keeps a failed rotation from locking the adopter out is a property
 * of that function, and a second implementation of it is a second thing to get wrong.
 *
 * ## The invariant (#287)
 *
 * **The CLI adds a key to a connection only when no live key exists to sign for one through the seam.**
 *
 * `POST {basePath}/keys` is the adopter's own boundary for registering a key: it checks the connection's
 * `keys:rotate` grant, it records the registration in their audit trail, and it is signed with the key
 * being replaced. A CLI writing the same column direct to D1 is a second authority over it — not a
 * second implementation, since both paths call core's `appendKey`, but a second *place the decision is
 * made*, which means the safety property holds for callers who remember and for nobody else.
 *
 * So the direct write is narrowed to the one case the seam cannot serve: a connection with nothing live
 * to sign with. That is first connect — no key exists, and the Worker may not even be deployed, so
 * requiring a running Worker to register the key that lets anyone talk to it would be a chicken-and-egg
 * with no exit. It is also the recovery case, a connection whose every key was revoked, and the same
 * sentence covers both because it is the same fact: nothing can sign.
 *
 * Stated as a property rather than a list of blessed callers, and enforced here rather than upstream,
 * because a rule kept at the call sites regrows the moment someone adds one. {@link connectionRegistry}
 * is the CLI's only door to that column, and `registry.test.ts` asserts both halves — that nothing else
 * in the CLI opens the table, and that neither write gets through while a key is live.
 *
 * **Revocation is deliberately outside it.** {@link ConnectionRegistry.revokeKey} changes the key set of
 * a connection with live keys, on purpose: it *removes* trust, and revocation that needed the Worker's
 * cooperation would not be revocation (docs/CONTROL-PLANE.md §7). The invariant is about granting.
 *
 * ## The second invariant (#294)
 *
 * **A write to this table records itself in the adopter's own audit trail.**
 *
 * `ControlPlaneAuditActions` declared `connectionRegistered`, `connectionUpdated` and
 * `connectionRemoved` from the day the seam shipped, and nothing emitted any of them. Not an oversight
 * in a handler: those are the writes the CLI performs by opening the adopter's D1 directly, so no
 * request reaches their Worker and no route is in a position to record one. An adopter could read a
 * *key* rotation in their trail but not the connection being created or destroyed — the larger event
 * was the invisible one.
 *
 * The recording is here, in the same functions as the writes, rather than at the call sites, for the
 * same reason the key invariant is: a rule kept at the call sites regrows the moment someone adds one.
 * Together with the tripwire asserting nothing else in the CLI opens this table, "every CLI write to an
 * adopter's connection row is recorded" holds by construction rather than by discipline.
 *
 * Three things this settles, each of which is a way to get it wrong.
 *
 * **Where.** The event goes to the emitter this registry was built with, which
 * {@link openConnectionRegistry} builds over the *same* `DB` handle the row is written through. Not a
 * separately resolved one: on `dev` the registry's handle is a local Miniflare store and a resolved
 * database id names the real remote database, so a second lookup would record the change in a database
 * that never saw it.
 *
 * **When.** The row is written first and the event follows. A write that throws records nothing, and a
 * record that fails cannot unwind the write and does not try — the emitter is non-fatal by contract, so
 * a connect never fails because the trail was unavailable. The record is evidence of the change, never
 * part of making it. The reverse order would let a `connect` announce a registration that did not land.
 *
 * **Whether.** An adopter need not compose `audit`. The emitter is then a no-op and every write here is
 * unchanged, which is why this takes an always-callable function rather than an optional one: a call
 * site that cannot tell whether auditing is on cannot forget to check.
 */

/**
 * One connection-lifecycle event, in the fields the seam's own routes already use.
 *
 * `resourceType`, `resourceId` and the two metadata keys match `keyRegistered` and `keyExpired` exactly,
 * so an adopter filtering their trail to one connection gets the CLI-side and Worker-side halves of its
 * history together rather than having to know that two writers named the same thing two ways.
 *
 * `severity` is `warning` for the same reason those are: a management client gaining, moving, or losing
 * reach into an environment is the notable kind of event, not the routine kind.
 *
 * The actor is deliberately absent — {@link CliAuditEvent} has no `actorType`, because the CLI does not
 * get to claim one. A route records `control-plane`, meaning the management client called in and proved
 * it; the CLI is the adopter's own operator at a terminal, named from their Cloudflare token where there
 * is one and unattributed where there is not. Letting this file set it would let a CLI-side write
 * present itself as a verified caller.
 */
function lifecycleEvent(
  action: ControlPlaneAuditAction,
  connection: ControlPlaneConnection,
  metadata: Record<string, unknown>,
): CliAuditEvent {
  return {
    action,
    outcome: "success",
    severity: "warning",
    resourceType: "controlplane_connection",
    resourceId: connection.id,
    environment: connection.environment,
    metadata: { connectionId: connection.id, connectionEnvironment: connection.environment, ...metadata },
  };
}

/** Key **ids**, never key material — the trail is queryable and long-lived. */
function keyIds(connection: ControlPlaneConnection): string[] {
  return connection.keys.map((registered) => registered.keyId);
}

/**
 * What a re-point moved, field by field, so the trail answers "what changed" without a diff of two rows.
 *
 * Scopes are compared as a set rendered in order: a grant is what it contains, and reporting a
 * reordering as a change would bury the one that matters.
 */
function addressAndGrantChanges(
  stored: ControlPlaneConnection,
  connection: ControlPlaneConnection,
): Record<string, unknown> {
  const before = [...stored.scopes].sort();
  const after = [...connection.scopes].sort();
  return {
    ...(stored.workerUrl === connection.workerUrl
      ? {}
      : { workerUrl: { from: stored.workerUrl, to: connection.workerUrl } }),
    ...(stored.basePath === connection.basePath
      ? {}
      : { basePath: { from: stored.basePath, to: connection.basePath } }),
    ...(before.join(" ") === after.join(" ") ? {} : { scopes: { from: before, to: after } }),
  };
}

/**
 * Refuse a key write while something live could have signed for it at the seam.
 *
 * The gate #287's invariant is stated as. It reads the connection as stored — never as offered — so a
 * caller cannot talk its way past by describing the keys it wishes were there.
 */
function refuseWhileSomethingCanSign(connection: ControlPlaneConnection, now: Date, detail: string): void {
  const live = activeKeys(connection.keys, now);
  if (live.length === 0) return;
  throw new ControlPlaneKeyConflictError({
    message: "That connection already has a live key.",
    action: `Register the successor through the worker: POST ${connection.workerUrl}${connection.basePath}/keys, signed with ${live[0]?.keyId}. That is what pithy dashboard rotate does.`,
    detail,
  });
}

/** Read, write, and revoke one environment's registration. */
export interface ConnectionRegistry {
  /** The environment's connection, or null when nothing is registered — the default, denying state. */
  read(): Promise<ControlPlaneConnection | null>;
  /** Write the environment's connection, replacing whatever was registered for it. */
  save(connection: ControlPlaneConnection): Promise<void>;
  /**
   * Append a public key through core's lifecycle rules, and return the updated connection.
   *
   * **Refused while the connection has a live key** — see the invariant above. This is the bootstrap
   * path only: nothing live means nothing can sign a registration at the seam, so the CLI is the only
   * thing that can put a key there.
   */
  appendKey(key: RegisteredKey, now: Date): Promise<ControlPlaneConnection>;
  /**
   * Revoke one registered key, immediately. Returns the updated connection, or null when no key answers
   * to that id.
   *
   * This is the adopter's side of revocation at key granularity: pulling one leaked key without tearing
   * down the connection and re-running `connect`. It is a write to their own D1, needs no route, and
   * needs nothing from the management client — which is what "immediate and unilateral" has to mean.
   */
  revokeKey(keyId: string, now: Date): Promise<ControlPlaneConnection | null>;
  /** Delete the registration. `false` when there was nothing to delete — re-running is not an error. */
  remove(): Promise<boolean>;
  /** Release whatever the registry opened (the local Miniflare instance; nothing remotely). */
  dispose(): Promise<void>;
}

/**
 * The registry over an already-open database. Pure enough to test against a real D1 with no project on
 * disk, which is the whole reason it is separate from {@link openConnectionRegistry}.
 */
export function connectionRegistry(
  db: ControlPlaneDatabase,
  env: string,
  dispose: () => Promise<void> = async () => {},
  /**
   * Where a write records itself (#294). Defaults to dropping the event, which is what a project not
   * composing `audit` gets — and what a test constructing a bare registry gets, so the recording is
   * opt-in for a caller that has a trail to write to and invisible to every caller that has not.
   */
  emit: CliAuditEmit = async () => {},
): ConnectionRegistry {
  /**
   * Record an event, and let no failure of it reach the write it was recording.
   *
   * {@link createCliAudit}'s emitter is non-fatal by contract and logs its own drops, so this is belt
   * and braces — but the writes below are the adopter's security boundary and do not get to assume
   * their collaborators behave. The same argument core's `safeEmit` makes, for the same reason: a
   * `disconnect` that failed because the trail was unreachable would leave a credential live on the
   * strength of an audit problem, which is precisely backwards. It is not silent, though; a broken
   * collaborator is worse hidden than seen.
   */
  async function record(event: CliAuditEvent): Promise<void> {
    try {
      await emit(event);
    } catch (error) {
      createCliLogger().child("dashboard").warn("connection lifecycle event dropped", { action: event.action, error });
    }
  }

  async function read(): Promise<ControlPlaneConnection | null> {
    const row = await db
      .selectFrom(CONTROL_PLANE_CONNECTIONS_TABLE)
      .selectAll()
      .where("environment", "=", env)
      .executeTakeFirst();
    return row ? ControlPlaneConnection.parse(row) : null;
  }

  return {
    read,

    async save(connection) {
      // `save` creates or replaces a whole connection, and replacing one is how an adopter starts over:
      // a new id, a new keypair, nothing carried forward. Nothing live can sign for a key on a
      // connection that does not exist yet, so a replacement is first connect and passes.
      //
      // Keeping the same connection and rewriting its keys is the other thing entirely — that is a
      // rotation wearing a create's clothes, and it goes through the seam like every other one.
      const stored = await read();
      if (stored && stored.id === connection.id) {
        const before = ControlPlaneConnection.shape.keys.encode([...stored.keys]);
        const after = ControlPlaneConnection.shape.keys.encode([...connection.keys]);
        if (before !== after) {
          refuseWhileSomethingCanSign(stored, connection.updatedAt, `save rewrote the keys of connection ${stored.id}`);
        }
      }

      // One connection per environment. SQLite carries no unique index on `environment` — the column is
      // indexed for reads, not constrained — so the invariant is enforced here, by replacing.
      await db.deleteFrom(CONTROL_PLANE_CONNECTIONS_TABLE).where("environment", "=", env).execute();
      await db.insertInto(CONTROL_PLANE_CONNECTIONS_TABLE).values(ControlPlaneConnection.encode(connection)).execute();

      // The row landed, so the event can be written. A new id — or none stored at all — is a management
      // client that did not have reach into this environment a moment ago and now does; the same id is
      // the same client re-pointed. Those are different facts to an adopter reading their trail, and the
      // id is the only thing that tells them apart, so it is what decides the code.
      if (stored !== null && stored.id === connection.id) {
        const changes = addressAndGrantChanges(stored, connection);
        await record(
          lifecycleEvent(ControlPlaneAuditActions.connectionUpdated, connection, {
            changed: Object.keys(changes),
            ...changes,
          }),
        );
        return;
      }
      await record(
        lifecycleEvent(ControlPlaneAuditActions.connectionRegistered, connection, {
          issuer: connection.issuer,
          workerUrl: connection.workerUrl,
          basePath: connection.basePath,
          scopes: [...connection.scopes],
          registeredKeyIds: keyIds(connection),
          // Starting over replaces a connection rather than editing one, and the id that stopped
          // working is what an adopter needs to recognize their own older rows by.
          ...(stored === null ? {} : { replacedConnectionId: stored.id }),
        }),
      );
    },

    async appendKey(key, now) {
      const connection = await read();
      if (!connection) {
        throw new ControlPlaneNotConnectedError({
          detail: `no connection registered for environment ${env}`,
        });
      }
      refuseWhileSomethingCanSign(connection, now, `appendKey ${key.keyId} on connection ${connection.id}`);
      // Core owns the rule. It refuses a duplicate id and a key that is already retired, and it never
      // moves an existing key's window — which is what leaves the old credential working until the new
      // one has been proven.
      const keys = appendRegisteredKey(connection.keys, key, now);
      const updated: ControlPlaneConnection = { ...connection, keys, updatedAt: now };
      await db
        .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
        .set(ControlPlaneConnection.encode(updated))
        .where("id", "=", connection.id)
        .execute();
      // The connection existed and now trusts a key it did not, so this is a change to it rather than a
      // registration of one. The seam's own `keyRegistered` is not the code for it: that one means the
      // Worker accepted a signed registration through the route, and nothing here went near the Worker.
      await record(
        lifecycleEvent(ControlPlaneAuditActions.connectionUpdated, updated, {
          changed: ["keys"],
          registeredKeyId: key.keyId,
          keyIds: keyIds(updated),
        }),
      );
      return updated;
    },

    async revokeKey(keyId, now) {
      const connection = await read();
      if (!connection) {
        throw new ControlPlaneNotConnectedError({
          detail: `no connection registered for environment ${env}`,
        });
      }
      if (!connection.keys.some((key) => key.keyId === keyId)) return null;

      // `revokedAt`, not `validUntil`. Expiry is the orderly end of a rotation and core refuses it while
      // it would leave no live key; revocation is the disorderly one, and it must not be refusable on
      // those grounds — a leaked key has to come out even if it is the only one. That leaves the
      // connection denying every call, which is the correct state for a credential you no longer trust,
      // and `pithy dashboard connect` is the way back.
      const keys = connection.keys.map((key) => (key.keyId === keyId ? { ...key, revokedAt: now } : key));
      const updated: ControlPlaneConnection = { ...connection, keys, updatedAt: now };
      await db
        .updateTable(CONTROL_PLANE_CONNECTIONS_TABLE)
        .set(ControlPlaneConnection.encode(updated))
        .where("id", "=", connection.id)
        .execute();
      // Recorded after the revocation, never before it, and it cannot fail one. Revocation is immediate
      // and unilateral (§7); a leaked key that stayed live because the trail was unreachable would be the
      // audit tail wagging the security dog. The count of what is still live is on the row because
      // revoking the last one leaves the connection denying everything, and that is the fact a reader
      // asking "when did this stop working" is looking for.
      await record(
        lifecycleEvent(ControlPlaneAuditActions.connectionUpdated, updated, {
          changed: ["keys"],
          revokedKeyId: keyId,
          liveKeyIdsAfter: activeKeys(updated.keys, now).map((key) => key.keyId),
        }),
      );
      return updated;
    },

    async remove() {
      const existing = await read();
      if (!existing) return false;
      await db.deleteFrom(CONTROL_PLANE_CONNECTIONS_TABLE).where("environment", "=", env).execute();
      // The widest-blast-radius write there is: every credential for this environment stopped working at
      // once. Recorded from the connection as it was, because after the delete there is nothing left to
      // describe it — which is exactly why an adopter needs the row.
      await record(
        lifecycleEvent(ControlPlaneAuditActions.connectionRemoved, existing, {
          issuer: existing.issuer,
          workerUrl: existing.workerUrl,
          basePath: existing.basePath,
          scopes: [...existing.scopes],
          removedKeyIds: keyIds(existing),
        }),
      );
      return true;
    },

    dispose,
  };
}

/**
 * Test seam: open the backend driver for a Worker and environment.
 *
 * **It carries the account (#234).** The seam is shaped by what {@link openSeedDriver} needs, and that
 * function's `account` was optional until then — so this type could not name one, so `openConnectionRegistry`
 * could not pass one even once it wanted to. A registry lookup on a non-`dev` environment opens a real D1
 * over REST, and it was opening it against whichever account `<config>/cloudflare.json` held.
 */
export type OpenDriver = (options: {
  workerDir: string;
  persistRoot: string;
  env: string;
  account: CloudflareAccountSelection | null;
}) => Promise<SeedDriver>;

/** Options for {@link openConnectionRegistry}. */
export interface OpenConnectionRegistryOptions {
  /** The project root — the parent of `apps/`, and the owner of the local `.wrangler/state` stores. */
  projectDir: string;
  /** The environment whose registration is being read or written. */
  env: string;
  /**
   * The Cloudflare account this project belongs to, from `projectCloudflareAccount(projectDir)`, or
   * `null` when it names none. Required (#234): every non-`dev` environment resolves the app database
   * over REST, and the credentials that reads it with belong to exactly one account.
   */
  account: CloudflareAccountSelection | null;
  /** Narrow the database lookup to one Worker (`--worker`). Optional; the first with a `DB` wins. */
  worker?: string;
  /** Driver seam (default: {@link openSeedDriver}), so a test needs no Miniflare of the CLI's making. */
  openDriver?: OpenDriver;
  /**
   * Build the recorder a write records itself through (#294), over **the database this registry resolved**
   * — which is why it is a factory taking that handle rather than an emitter passed in ready-made.
   *
   * The `DB` a connection row lives in is decided here, by walking the project's Workers, and on `dev` it
   * is a local Miniflare store that no database id names. An emitter built anywhere else would be writing
   * the record of a change into a database the change never reached. Passing the handle out is what makes
   * "the event goes where the row went" a property of the wiring instead of a thing two call sites have to
   * agree about.
   *
   * Omitted, nothing is recorded — the shape a test and a project without `audit` both get.
   */
  openAudit?: (database: D1Database) => Promise<CliAuditEmit>;
}

/**
 * Settle the account before a single Worker is considered (#236).
 *
 * **A per-item refusal collector will swallow a whole-run refusal**, because the whole-run failure arrives
 * wearing a per-item costume. The loop below gathers "why each Worker was skipped" so one unresolvable
 * Worker does not stop the rest — a summary that is exactly the wrong shape for a fact settled before the
 * loop began. An account mismatch went in as a per-Worker reason and came out as "No worker resolves the
 * DB binding for this environment", pointing an adopter at a `wrangler.jsonc` that was fine. #199 was the
 * same shape: a config that would not import, reported as "this Worker declares no secrets".
 *
 * So the two whole-project facts are asked here, once, and thrown rather than collected — the way
 * `migrate`, `deploy`, `env`, `seed` and `upgrade` already refuse. {@link cloudflareCredentials} owns both
 * sentences, so the mismatch reads exactly as `pithy doctor` reads it out.
 *
 * **`dev` is exempt because it consults no account.** The local driver resolves D1 from the project root's
 * Miniflare stores and never builds a client, so no credential decides anything; refusing there would
 * block work that never leaves the machine over a disagreement it cannot reach. Every other environment
 * resolves the database over REST, which means credentials, which means exactly one account.
 */
function requireAccountSettled(env: string, account: CloudflareAccountSelection | null): void {
  if (env === "dev") return;
  cloudflareCredentials({ account });
}

/**
 * Open the registry for a project and environment.
 *
 * The database comes from a Worker's `wrangler.jsonc`, because that is where bindings are declared —
 * but **the state it persists to is the project root's**, exactly as `pithy dev`, `migrate`, and `seed`
 * do. A per-Worker persist directory would give two Workers that both declare `DB` separate copies of
 * one database, and the registration would be visible to whichever Worker happened to write it.
 *
 * Which Worker? `--worker` names one; otherwise the first discovered Worker declaring a `DB` binding.
 * Deliberately not an ambiguity error, for the same reason the audit lookup is not: Workers share a
 * resource by declaring the same binding name, so every Worker with a `DB` points at the one app
 * database.
 */
export async function openConnectionRegistry(options: OpenConnectionRegistryOptions): Promise<ConnectionRegistry> {
  const open = options.openDriver ?? openSeedDriver;
  requireAccountSettled(options.env, options.account);
  const workers = await discoverWorkers(options.projectDir);
  const candidates =
    options.worker === undefined
      ? workers
      : workers.filter(
          (worker) =>
            worker.name === options.worker || worker.dir === join(options.projectDir, "apps", options.worker ?? ""),
        );

  const refusals: string[] = [];
  for (const candidate of candidates) {
    const driver = await open({
      workerDir: candidate.dir,
      persistRoot: options.projectDir,
      env: options.env,
      account: options.account,
    });
    try {
      const d1 = driver.d1("DB");
      // Resolved before the registry is built, so a registry never exists without the recorder that
      // belongs to its own database. The factory is not allowed to fail the command it is auditing: a
      // project whose audit wiring cannot be built still connects, silently, and records nothing.
      const record = await options.openAudit?.(d1).catch(() => undefined);
      return connectionRegistry(controlPlaneDatabase(d1), options.env, () => driver.dispose(), record);
    } catch (error) {
      // This Worker cannot answer "where does the app database live" — usually because it declares no
      // `DB` at all (a UI-only Worker in `apps/` is normal), sometimes because this env's stanza has no
      // id. Both are collected rather than thrown: another Worker may still resolve it, and if none
      // does, the reasons are what makes the final error debuggable.
      refusals.push(`${candidate.name}: ${messageOf(error)}`);
      await driver.dispose();
    }
  }

  // Every reason is per-Worker by now — the whole-project ones were refused before the loop — so the
  // summary is honest, and the reasons themselves belong on the `action` line rather than only in
  // `detail`. `detail` is stripped at the display boundary and always will be; an operator staring at
  // "add the DB binding" on a project that has one needs to be told which Worker said what.
  const why = refusals.length === 0 ? "No workers under apps/." : `Skipped: ${refusals.join("; ")}.`;
  throw new ValidationError({
    message: "No worker resolves the DB binding for this environment.",
    action: `${why} Add the DB d1_databases binding to a worker's wrangler.jsonc, or pass --worker to name one.`,
    detail: `env ${options.env}; ${refusals.length === 0 ? "no workers under apps/" : refusals.join("; ")}`,
  });
}
