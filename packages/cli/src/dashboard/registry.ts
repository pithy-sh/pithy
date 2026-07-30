// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { ControlPlaneConnection, type RegisteredKey } from "@pithy-sh/core/src/controlPlane/data/connection";
import { appendKey as appendRegisteredKey } from "@pithy-sh/core/src/controlPlane/data/keyLifecycle";
import {
  CONTROL_PLANE_CONNECTIONS_TABLE,
  type ControlPlaneDatabase,
  controlPlaneDatabase,
} from "@pithy-sh/core/src/controlPlane/data/tables";
import { ControlPlaneNotConnectedError } from "@pithy-sh/core/src/controlPlane/error/errors";
import { messageOf, ValidationError } from "@pithy-sh/core/src/error/pithyError";
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
 */

/** Read, write, and revoke one environment's registration. */
export interface ConnectionRegistry {
  /** The environment's connection, or null when nothing is registered — the default, denying state. */
  read(): Promise<ControlPlaneConnection | null>;
  /** Write the environment's connection, replacing whatever was registered for it. */
  save(connection: ControlPlaneConnection): Promise<void>;
  /** Append a public key through core's lifecycle rules, and return the updated connection. */
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

/** Test seam: open the backend driver for a Worker and environment. */
export type OpenDriver = (options: { workerDir: string; persistRoot: string; env: string }) => Promise<SeedDriver>;

/** Options for {@link openConnectionRegistry}. */
export interface OpenConnectionRegistryOptions {
  /** The project root — the parent of `apps/`, and the owner of the local `.wrangler/state` stores. */
  projectDir: string;
  /** The environment whose registration is being read or written. */
  env: string;
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
    const driver = await open({ workerDir: candidate.dir, persistRoot: options.projectDir, env: options.env });
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
