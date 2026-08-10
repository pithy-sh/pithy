// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { isSecretsCapability } from "@pithy-sh/secrets/src/capability";
import { type AuditResult, auditSecrets, passesPromoteGate } from "@pithy-sh/secrets/src/cli/audit";
import { dispatchSecretWrite, type SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { validateSecretValue } from "@pithy-sh/secrets/src/cli/validate";
import { parseKeyedSecretName } from "@pithy-sh/secrets/src/keyspace";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { CliAuditEmit } from "../audit/cliAudit";
import { allCapabilities, type WorkerConfig } from "../project/config";

/** The audit action for a value-touching secret command, by mode. Never carries the secret's value. */
const SECRET_WRITE_ACTION: Record<SecretWriteCommand["mode"], string> = {
  create: "secrets/set",
  update: "secrets/rotated",
  delete: "secrets/removed",
};

/**
 * Discover a Worker's secret registry by finding the secrets capability in its loaded
 * `apps/<name>/pithy.config.ts` (#25's config model). The capability carries its own registry, so there
 * is no separate loading convention — the CLI reads what the Worker reads. Capabilities are per-Worker,
 * so the registry is too: a caller spanning several Workers resolves each and merges by secret name
 * (the name is the join key).
 */
export function resolveSecretRegistry(config: WorkerConfig): SecretRegistry {
  const capability = allCapabilities(config).find(isSecretsCapability);
  if (!capability) {
    throw new NotFoundError({
      message: "The secrets capability isn't enabled in this worker.",
      action: "Add secrets({ registry }) to the worker's pithy.config.ts capabilities, or pass --worker.",
    });
  }
  return capability.secretRegistry;
}

/**
 * The brains of `pithy secrets` — pure wiring over the `@pithy-sh/secrets` cores, with the registry
 * and dispatcher injected so it is fully testable. The citty command (`commands/secrets.ts`) handles
 * I/O — value capture, registry discovery, building the live dispatcher — and calls these.
 */

export interface SecretWriteCommand {
  mode: "create" | "update" | "delete";
  name: string;
  /** The raw value for create/update (omitted for delete) — validated client-side here. */
  value?: string;
  /** The operator-requested environment (used for an `environment`-scoped secret). */
  env: ManagedEnvironment;
  /**
   * Every environment the project declares, from the root `pithy.config.ts` (#241) — the set a `global`
   * secret fans out across, and the one the canonical CF-Secrets-Store write is chosen from.
   *
   * Beside `env` rather than defaulted, because a default would be the silence this replaced: a project
   * declaring `live` would have its shared secrets written to staging and prod and not to `live`, and
   * nothing would say so.
   */
  environments: DeclaredEnvironments | readonly string[];
}

/**
 * Validate a value client-side (the authoritative A2 check) and dispatch the write to the manager
 * Workflow(s). The registry lookup gives the routing facts (backend, scope) and the schema; an
 * undeclared secret is rejected before anything is sent. Returns the environments written.
 *
 * Audited on success and on failure — `secrets/set` (create), `secrets/rotated` (update), or
 * `secrets/removed` (delete) — recording only the secret's **name** and the environments it reached.
 * The value itself, and anything derived from it, never appears in an audit event: that is the one
 * hard rule of a secrets trail.
 */
export async function runSecretWrite(
  registry: SecretRegistry,
  dispatcher: SecretDispatcher,
  command: SecretWriteCommand,
  audit: CliAuditEmit = async () => {},
): Promise<ManagedEnvironment[]> {
  const entry = registry[command.name];
  if (!entry) {
    throw new NotFoundError({
      message: `Secret '${command.name}' is not declared in the registry.`,
      action: "Add it to your secret registry, then run this again.",
    });
  }

  // A keyspace has no single value to write, and a write under its bare name would land somewhere no
  // member read ever looks. Its members belong to the app that mints them, which writes them in-worker.
  if (entry.keyed) {
    throw new ValidationError({
      message: `Secret '${command.name}' is a keyspace, not a secret.`,
      action: "Its members are written by the application that owns them, one key at a time.",
    });
  }

  let value: string | undefined;
  if (command.mode !== "delete") {
    if (command.value === undefined || command.value === "") {
      throw new ValidationError({ message: `A value is required to ${command.mode} '${command.name}'.` });
    }
    value = validateSecretValue(entry, command.name, command.value);
  }

  const action = SECRET_WRITE_ACTION[command.mode];
  try {
    const targets = await dispatchSecretWrite(
      dispatcher,
      {
        mode: command.mode,
        name: command.name,
        backend: entry.backend,
        scope: entry.scope,
        rotatable: entry.rotatable,
        valueType: entry.valueType,
        value,
        requested: command.env,
      },
      command.environments,
    );
    await audit({
      action,
      outcome: "success",
      severity: "warning",
      resourceType: "secret",
      resourceId: command.name,
      metadata: { name: command.name, environments: targets },
    });
    return targets;
  } catch (error) {
    await audit({
      action,
      outcome: "failure",
      severity: "warning",
      resourceType: "secret",
      resourceId: command.name,
      metadata: { name: command.name },
    });
    throw error;
  }
}

/** The `ls` / `ls --check` view: the declared names (keyspaces included), the audit, and the gate. */
export interface SecretsListView {
  names: string[];
  audit: AuditResult;
  promotable: boolean;
}

export function runSecretsList(registry: SecretRegistry, presentNames: string[]): SecretsListView {
  const names = Object.keys(registry).sort();
  // A keyspace is expected to have no value of its own, and its stored members are expected to have no
  // registry entry of their own. Counting either would make the promote gate unpassable the day an
  // adopter declares their first per-tenant credential, and would report every tenant as junk.
  const expected = names.filter((name) => !registry[name]?.keyed);
  const present = presentNames.filter((stored) => {
    const member = parseKeyedSecretName(stored);
    return !(member && registry[member.name]?.keyed);
  });
  const audit = auditSecrets(expected, present);
  return { names, audit, promotable: passesPromoteGate(audit) };
}
