// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
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
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { discoverWorkers } from "../project/workers";
import { openSeedDriver, type SeedDriver } from "../seed/drivers";

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
 */

/**
 * Refuse a key write while something live could have signed for it at the seam.
 *
 * The gate the invariant above is stated as. It reads the connection as stored — never as offered — so
 * a caller cannot talk its way past by describing the keys it wishes were there.
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
): ConnectionRegistry {
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
      return updated;
    },

    async remove() {
      const existing = await read();
      if (!existing) return false;
      await db.deleteFrom(CONTROL_PLANE_CONNECTIONS_TABLE).where("environment", "=", env).execute();
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
      return connectionRegistry(controlPlaneDatabase(d1), options.env, () => driver.dispose());
    } catch (error) {
      // This Worker cannot answer "where does the app database live" — usually because it declares no
      // `DB` at all (a UI-only Worker in `apps/` is normal), sometimes because this env's stanza has no
      // id. Both are collected rather than thrown: another Worker may still resolve it, and if none
      // does, the reasons are what makes the final error debuggable.
      refusals.push(`${candidate.name}: ${messageOf(error)}`);
      await driver.dispose();
    }
  }

  throw new ValidationError({
    message: "No worker resolves the DB binding for this environment.",
    action: "Add the DB d1_databases binding to a worker's wrangler.jsonc, or pass --worker to name one.",
    detail: `env ${options.env}; ${refusals.length === 0 ? "no workers under apps/" : refusals.join("; ")}`,
  });
}
