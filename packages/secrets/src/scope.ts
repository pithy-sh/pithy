// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { SecretBackend, SecretScope } from "./registry";

/**
 * The environments Pithy manages remotely. `dev` is local-only — it resolves from `.dev.vars`,
 * never a deployed store — so it is never a write target. A future managed env extends this set,
 * and global replication follows automatically.
 *
 * **The deployed subset of core's `ENVIRONMENTS`, spelled the same way.** Every name a manager is
 * deployed under goes through `resourceNames(project).env(environment)`, which refuses anything core
 * does not accept — so an environment named here that core rejects would provision nothing at all.
 * `scope.test.ts` pins the two lists together rather than deriving one from the other: a new
 * environment in core should reach this file as a failing test asking whether it gets a manager, not
 * as one it silently acquired.
 */
export const ManagedEnvironment = z
  .enum(["staging", "prod"])
  .describe("A deployed environment with its own secrets store and manager (everything except local dev).");
export type ManagedEnvironment = z.output<typeof ManagedEnvironment>;

/** The environment a `global` CF-Secrets-Store secret is canonically written to (both envs bind it). */
const CANONICAL_GLOBAL_ENV: ManagedEnvironment = "prod";

/** Every managed environment, in order. The set a `global` D1 secret fans out across. */
export function managedEnvironments(): ManagedEnvironment[] {
  return ManagedEnvironment.options;
}

/**
 * The environments a write must reach, given its backend and scope — the routing the CLI applies
 * before dispatching to each env's manager (issue #26's backend × scope table):
 *
 *   - `environment` scope → exactly the requested env (its value legitimately differs per env).
 *   - `global` + `d1` → **every** managed env: each env's store is separate and keyed by its own
 *     master key, so the same value is written into each (fan-out, kept in lockstep).
 *   - `global` + `cf-secrets-store` → **prod only**: a CF Secrets Store entry is one
 *     account-level secret both envs bind, so it is written once, canonically, via prod.
 *
 * A `global` write therefore reaches both environments by construction; an `environment` write
 * touches exactly one.
 */
export function resolveWriteTargets(
  backend: SecretBackend,
  scope: SecretScope,
  requested: ManagedEnvironment,
): ManagedEnvironment[] {
  if (scope === "environment") return [requested];
  if (backend === "cf-secrets-store") return [CANONICAL_GLOBAL_ENV];
  return managedEnvironments();
}
