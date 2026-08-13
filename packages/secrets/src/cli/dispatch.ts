// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import type { SecretBackend, SecretScope, SecretValueType } from "../registry";
import type { ManagedEnvironment } from "../scope";
import { partialWriteReport } from "./partialWrite";
import { secretWriteTargets } from "./writeTargets";

/**
 * One write/delete dispatched to a single environment's manager Workflow. The CLI never encrypts or
 * writes locally — the master key is worker-only — so every value-touching command becomes one of
 * these per target environment.
 */
export interface SecretWriteRequest {
  env: ManagedEnvironment;
  mode: "create" | "update" | "delete";
  name: string;
  /** Present for create/update; omitted for delete. Already validated + canonicalized by the CLI. */
  value?: string;
  valueType?: SecretValueType;
  rotatable?: boolean;
}

/**
 * The dispatch seam: send one request to an environment's manager Workflow and resolve once it
 * reaches a terminal state. Stubbed in tests; backed by the CF Workflows REST client (dispatch +
 * poll) in the manager-worker/provisioning slice.
 */
export interface SecretDispatcher {
  dispatch(request: SecretWriteRequest): Promise<void>;
}

/** One presence question, asked of one environment's manager. Carries a name and nothing else. */
export interface SecretProbeRequest {
  env: ManagedEnvironment;
  /** The secret to ask about. */
  name: string;
}

/**
 * **The read seam, and it is deliberately its own.** A `d1` secret's value is sealed under a master
 * key that never leaves the manager Worker, so whether one exists is a question only the manager can
 * answer — and provisioning has to ask it *before* deciding, because a per-environment decision taken
 * during a fan-out cannot preserve a cross-environment invariant.
 *
 * Separate from {@link SecretDispatcher} because the contracts are opposites: one mutates and returns
 * nothing, this returns and mutates nothing. Folding a read into a writer is how a "check" ends up
 * being the write it was meant to gate.
 *
 * It resolves to a bit. It never resolves to a value, and there is no shape of request that would make
 * it.
 */
export interface SecretProbe {
  probe(request: SecretProbeRequest): Promise<boolean>;
}

/** A value-touching command before routing — the CLI resolves backend/scope from the registry. */
export interface SecretWrite {
  mode: "create" | "update" | "delete";
  name: string;
  backend: SecretBackend;
  scope: SecretScope;
  rotatable: boolean;
  valueType: SecretValueType;
  /** The validated value for create/update; omitted for delete. */
  value?: string;
  /**
   * The environment the operator named, or `undefined` when they named none.
   *
   * Optional, and that is the point. A missing `--env` on a `global` secret used to be resolved to the
   * canonical environment before it got here, which erased the difference between *narrow this write*
   * and *say nothing* — and `secretWriteTargets` refuses on exactly that difference. An
   * `environment`-scoped write still requires one; the rule says so rather than a default hiding it.
   */
  requested?: ManagedEnvironment;
}

/** Every environment written before an interrupted fan-out threw. See {@link environmentsWrittenBeforeFailure}. */
const dispatched = partialWriteReport<ManagedEnvironment[]>(
  "pithy.secrets.dispatchedBeforeFailure",
  (value): value is ManagedEnvironment[] => Array.isArray(value) && value.every((env) => typeof env === "string"),
);

/**
 * The environments an interrupted {@link dispatchSecretWrite} actually reached, in order. Empty when the
 * thrown thing carries no report — which is the honest answer for a throw from anywhere else.
 *
 * **This is the whole of what the product can offer against a mid-fan-out fault.** There is no
 * transaction across environments and no rollback — each is a separate Workflow in a separate Worker,
 * and a compensating write is itself a Workflow that can fail. So a split that a fault created is not
 * prevented; it is *reported*, by name, to the operator who has to repair it. `runSecretWrite` puts these
 * environments in the failure audit and `pithy secrets` prints them before the error.
 */
export function environmentsWrittenBeforeFailure(error: unknown): ManagedEnvironment[] {
  return dispatched.read(error) ?? [];
}

/**
 * Decide where a write may land (`secretWriteTargets`), then dispatch it to each target environment's
 * manager, in order. A `global` write reaches every declared environment; an `environment` write reaches
 * exactly one. Returns the environments written, for the CLI to report.
 *
 * **The decision is taken before the first dispatch, and it is not taken here.** `secretWriteTargets`
 * owns it, `mintDeclaredSecrets` asks the same function, and a `global` write that names an environment
 * is refused with nothing sent. That is what keeps an operator from creating a split by asking for one.
 *
 * **What it cannot do is undo a fan-out that died in the middle**, so it does not pretend to. The
 * environments already written are attached to whatever ended the run and read back with
 * {@link environmentsWrittenBeforeFailure}. Grown one at a time and pushed only *after* the write it
 * describes lands, because an environment named before its dispatch resolved is a plan, and a plan
 * printed as a result is how a partial run reports work it never did (#324).
 *
 * `declared` is the project's environment set, from the root `pithy.config.ts`. It is what a `global`
 * write fans out across, so passing the wrong one writes a shared secret into some environments and not
 * others — which is why it is an argument here rather than a default anything can forget.
 */
export async function dispatchSecretWrite(
  dispatcher: SecretDispatcher,
  write: SecretWrite,
  declared: DeclaredEnvironments | readonly string[],
): Promise<ManagedEnvironment[]> {
  const targets = secretWriteTargets({
    name: write.name,
    backend: write.backend,
    scope: write.scope,
    mode: write.mode,
    requested: write.requested,
    declared,
  });
  const written: ManagedEnvironment[] = [];
  try {
    for (const env of targets) {
      await dispatcher.dispatch({
        env,
        mode: write.mode,
        name: write.name,
        value: write.value,
        valueType: write.valueType,
        rotatable: write.rotatable,
      });
      written.push(env);
    }
  } catch (error) {
    throw dispatched.carry(error, written);
  }
  // What landed, not what was planned. They agree on every run that finishes, and the one that does not
  // is the run whose answer matters.
  return written;
}
