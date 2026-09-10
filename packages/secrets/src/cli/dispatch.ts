// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import type { RotationTrigger } from "../data/secretRotations";
import type { SecretBackend, SecretScope, SecretValueType } from "../registry";
import type { RotationClosure } from "../rotation/rotationLedger";
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
  /**
   * **Where the value is held, and therefore which writer performs this request** (#517).
   *
   * It was absent, and its absence is the whole of the defect: every request reached
   * `WorkflowSecretDispatcher`, which reaches one environment's manager Workflow, which runs
   * `runWriteSecret` against `SystemSecretsStore` — D1, unconditionally. So `pithy secrets create` on a
   * `cf-secrets-store` secret wrote an encrypted D1 row nothing reads, exited 0, and left the store entry
   * absent; `pithy secrets rm` deleted that same shadow row and reported a revocation while the live entry
   * stayed bound in `wrangler.jsonc`. `secretWriteTargets` had the backend all along and read it only to
   * decide *how many* environments a write reaches — never *what* performs it.
   *
   * A request therefore states it, and {@link backendRoutedDispatcher} is what turns it into a
   * destination. Required rather than optional: an omitted backend would default to whichever branch was
   * written first, which is exactly the silence this replaces.
   */
  backend: SecretBackend;
  /**
   * The secret's declared scope — carried for the same reason as {@link backend}, one step further on.
   *
   * A Secrets Store entry's name is `scope.secretEntry(binding, scope)`, and a `global` secret resolves to
   * one account-level `<project>-global-<secret>` rather than to a per-environment name. So the writer
   * cannot compose the address it is about to write without this, and a writer that guessed would put an
   * operator's value at a name provisioning never looks at. `d1` ignores it: a row is addressed by the
   * bare registry name inside an already-per-environment database.
   */
  scope: SecretScope;
  /**
   * **Whether this secret is read straight from its binding, and therefore carries no envelope.**
   *
   * The third routing fact, and the one whose absence wrote an unreadable value. Every other secret is
   * stored as an encoded `{ currentVersion, versions }` envelope and read back through
   * `decodeVersionedValue`; a `bootstrap` secret is read *before* the store that decoder needs is open,
   * so its destination carries the value itself. `resolveEncryptionConfig` is that reader for the master
   * key — it takes the binding's plaintext, `JSON.parse`s it and parses an `EncryptionConfig` — and
   * `#323` settled the same rule for the dev secrets file in the same words: **the file states the
   * payload the destination receives.** A store entry is a destination.
   *
   * So a writer that enveloped unconditionally landed, for exactly the `bootstrap` shapes, a value the
   * boot reader cannot parse: the Worker fails at `SECRETS_ENCRYPTION_KEYS is not a valid
   * EncryptionConfig` over a value the command reported as written. `storeEntryText` is the one place
   * the decision is taken, and this is the fact it takes it from.
   *
   * Required rather than optional, for {@link backend}'s reason one axis over: an omitted flag defaults
   * to the envelope, which is the shape that is wrong for the one secret that cannot say so.
   */
  bootstrap: boolean;
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

/**
 * **A writer that answers a pre-flight: raise now whatever {@link SecretDispatcher.dispatch} would raise
 * before it writes anything — and answer nothing.**
 *
 * `refuseUnrotatable`'s shape, one seam out: *refuse everything refusable before anything is called.*
 * A rotation calls a third party's API and then stores what comes back, so a refusal that arrives at
 * the store is a refusal that arrives **after the irreversible line** — the credential is dead at its
 * issuer and its successor exists only in this process. Each backend's writer has the same two refusals,
 * over its own destination: it cannot be reached at all (no `SECRETS_STORE_ID`; no manager Workflow), and
 * an `update` of a secret that is not there. Both are knowable before a rotator is called.
 *
 * **It is required, and that requirement is the fix rather than the tidying** (#517). It arrived optional,
 * `storeSecretWriter` implemented it, `WorkflowSecretDispatcher` did not, and nothing said so: the router
 * called it with `?.`, the `d1` half passed silently, and the identical ordering fault stayed live on the
 * more common backend — the rotator rolled, the manager answered `Secret does not exist`, and the
 * successor was lost. So the type carries it now. A backend that genuinely has nothing to refuse in
 * advance says so out loud through {@link withoutPreflight}; there is no longer a way to say it by
 * omission.
 *
 * It answers `void` on purpose — a preflight that returned a bit would be a check somebody gates a write
 * on, and a check that gates a write is the write's own race. It is a *cheap pre-flight and never a
 * second authority*: `dispatch` asks the same questions itself regardless, and the late ask is the one
 * that decides.
 */
export interface PreflightSecretDispatcher extends SecretDispatcher {
  preflight(request: SecretWriteRequest): Promise<void>;
}

/**
 * **The one way to route a backend that refuses nothing in advance, and it has to be said in words.**
 *
 * Every backend the kit ships has a pre-flight, so nothing here calls this today. It exists because the
 * alternative to an escape hatch is not "no escape hatch" — it is the escape hatch that already existed,
 * an omitted method nobody could see. A waiver written like this is greppable, is attached to the backend
 * it waives, and carries the reason the next reader needs; an absent method carried none of that, and cost
 * a live credential.
 *
 * The reason is demanded rather than defaulted, and an empty one is refused at composition time — where a
 * refusal costs a startup, not a rotation.
 */
export function withoutPreflight(dispatcher: SecretDispatcher, because: string): PreflightSecretDispatcher {
  if (because.trim() === "") {
    throw new InternalError({
      message: "A secret writer that skips its pre-flight must say why.",
      detail: "withoutPreflight was composed with an empty reason",
    });
  }
  return {
    dispatch: (request) => dispatcher.dispatch(request),
    // Nothing to refuse in advance, stated rather than omitted. See `because`.
    preflight: async () => {},
  };
}

/**
 * **One dispatcher per backend, chosen by the request rather than by the caller.**
 *
 * The seam stays one seam — `dispatchSecretWrite` still takes a {@link SecretDispatcher}, and
 * `secretWriteTargets` still owns which environments a write reaches — and this is the object that reads
 * {@link SecretWriteRequest.backend} and hands the request to the writer that can perform it. Composed
 * once, in `pithy secrets`, so no command picks a destination and none can pick a different one.
 *
 * A total record over `SecretBackend`, deliberately: a third backend fails the build here rather than
 * inheriting whichever branch happened to come first, which is precisely how every write came to be a D1
 * write.
 *
 * **And every route is a {@link PreflightSecretDispatcher}, which is the second half of the same idea.**
 * The ordering a rotation depends on is a property of *this* object rather than of whichever writer
 * happened to be written carefully: a backend with no pre-flight is a compile error here, not a silent
 * `?.` that resolves. One backend having the guard and the other not is exactly how #517's remaining half
 * survived a fix aimed at it.
 */
export function backendRoutedDispatcher(
  routes: Record<SecretBackend, PreflightSecretDispatcher>,
): PreflightSecretDispatcher {
  return {
    dispatch: (request) => routes[request.backend].dispatch(request),
    // The same route, so a preflight cannot ask a different writer than the one that will perform the
    // write — and every route has one to ask.
    preflight: (request) => routes[request.backend].preflight(request),
  };
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

/** Open one rotation row, in one environment's manager, before anything is rolled. */
export interface SecretRotationOpenRequest {
  /** Which environment's ledger. The rotation table is per-environment, like the store it describes. */
  env: ManagedEnvironment;
  /** The secret being rotated, by registry name. */
  name: string;
  /** What caused it. `manual` from a command, `cron` from a schedule — never `baseline`, which is a first write. */
  trigger: RotationTrigger;
  /** Who asked. See `./rotationLedger.ts` for what the CLI can honestly put here. */
  rotatedBy: string;
}

/** Close a row opened by {@link SecretRotationRecorder.openRotation}, with what the run did in that environment. */
export interface SecretRotationCloseRequest {
  /** The environment whose row this is. */
  env: ManagedEnvironment;
  /** The row id that environment's manager handed back when it opened. */
  rotationId: number;
  /** How it closes there. A code and never free text — a value cannot be pasted into an enum. */
  closure: RotationClosure;
}

/**
 * **The rotation-ledger seam, and it is deliberately its own.**
 *
 * `pithy_secrets_rotations` lives in the per-environment secrets D1, which the CLI cannot reach — the same
 * reason {@link SecretProbe} exists. So a rotation records the way it writes: one dispatch to that
 * environment's manager Workflow, which holds the database.
 *
 * Separate from {@link SecretDispatcher} because the contracts differ in the way that matters: a write
 * returns nothing, and opening a row returns the id the close needs. Folding an id-returning call into a
 * `Promise<void>` writer is how the id gets dropped and the row never closes.
 */
export interface SecretRotationRecorder {
  /** Open an `in_progress` row and return its id. */
  openRotation(request: SecretRotationOpenRequest): Promise<number>;
  /** Close a row previously opened in the same environment. */
  closeRotation(request: SecretRotationCloseRequest): Promise<void>;
}

/** A value-touching command before routing — the CLI resolves backend/scope from the registry. */
export interface SecretWrite {
  mode: "create" | "update" | "delete";
  name: string;
  backend: SecretBackend;
  scope: SecretScope;
  /** The third routing fact — see {@link SecretWriteRequest.bootstrap}. Forwarded, never re-derived. */
  bootstrap: boolean;
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
        // The registry's two routing facts, forwarded rather than re-derived. `secretWriteTargets` above
        // read them to decide how many environments this reaches; the dispatcher reads them to decide
        // what performs it. One resolution, two questions — and no second lookup to disagree with.
        backend: write.backend,
        scope: write.scope,
        // The third, and the one that decides what the value is wrapped in rather than where it goes.
        bootstrap: write.bootstrap,
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
