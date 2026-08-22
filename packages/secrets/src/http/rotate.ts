// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Context } from "hono";
import type { SecretBinding, SecretsStoreEnv } from "../env/bindings";
import { MASTER_KEY_BINDING } from "../env/bindings";
import { SecretNotFoundError, SecretRotationUnsupportedError } from "../error/errors";
import { runWriteSecret } from "../management/writeSecret";
import type { SecretRegistryEntry } from "../registry";
import { refuseUnrotatable, rotateSecretValue, type SecretRotationOutcome } from "../rotation/rotateValue";
import { ManagedEnvironment } from "../scope";
import { RotationTracker, trackerRotationLedger } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";

/**
 * **What a Worker can rotate, and the honest refusal for everything else.**
 *
 * `#367` gave the CLI a rotation and `#372` asks for the same act from a browser, and the two are not the
 * same act performed by different callers. `pithy secrets rotate` runs in a process holding *the project*:
 * the registry from source, a Cloudflare API token, and a dispatcher to every environment's manager Worker.
 * A Worker holds **one environment's D1 and its own master key**. So the interesting question is not how to
 * call `rotateSecretValue` from a handler — that part is easy — it is which secrets the answer is true for.
 *
 * ## The two refusals, and why they are refusals rather than partial successes
 *
 * - **A `cf-secrets-store` backend.** The value is one account-level Secrets Store entry, written through
 *   Cloudflare's REST API with a token the secrets *manager* holds. An app Worker binds that store
 *   read-only and must never hold that token — `env/bindings.ts` and the capability's token profile both
 *   say so. There is no write to attempt.
 * - **`scope: "global"`.** A global secret is *defined* by being byte-identical in every environment;
 *   `resolveWriteTargets` fans a global `d1` write across all of them for exactly that reason. A Worker
 *   can reach one. Writing its own and reporting success would leave staging and prod holding different
 *   values for one name, which is the mixed state `#38` names as the shape to refuse — and, worse, it
 *   would arrive labeled `rotated`.
 *
 * Both are answered with `secrets/rotation_unsupported` **before anything is called**, naming the command
 * that can. A client renders the free path instead of a dead button, which is the same answer `#38` already
 * gives for a `manual` secret and for the same reason: an instruction that works beats a control that does
 * not.
 *
 * ## Three more things are refused before the irreversible step
 *
 * {@link refuseUnrotatable} is asked first — a keyspace, an undeclared rotation, a `provider` secret with
 * no rotator, the master key, a `local` secret with no recipe. Then the environment: a Worker that cannot
 * name which environment it is cannot report where a value landed, and an outcome that cannot name its
 * environments is the aggregate this design exists to refuse. Then presence: `runWriteSecret` in `update`
 * mode raises on a name the store does not hold, and discovering that *after* a provider roll would
 * manufacture the unrecorded incident out of a configuration gap that was knowable for free.
 *
 * ## The rotation row is opened before the roll, and closed after it
 *
 * Nothing else advances `lastRotatedAt`. A rotation that succeeded and recorded nothing leaves the secret
 * reported overdue forever, so the button would appear to do nothing — and the history an incident review
 * reads (`GET {base}/admin/status/:name/rotations`) would have no entry for the act it is reviewing. The row
 * opens `in_progress` with the **management client's own subject** as `rotatedBy`, which is what makes *who
 * rolled the production key on the twelfth* a question with an answer. It is opened before the roll so a
 * rotator that never returns still leaves a trace, and only after every refusal above, so a refused call
 * writes no history at all.
 *
 * The failure text written into the closing row is composed here from the outcome's own status — never from
 * `cause`. `admin/status.ts` refuses to publish `error_message` precisely because it is free text written at
 * a failure site, which is where a value gets pasted by accident; writing one from an exception message
 * would be that accident, arranged in advance.
 */

/** What one Worker-side rotation needs: this environment's store, and its rotation history. */
export interface WorkerRotationDeps {
  store: SystemSecretsStore;
  tracker: RotationTracker;
}

/** One Worker-side rotation request, already verified and already looked up. */
export interface WorkerRotationRequest {
  /** The secret's registry name, matched exactly against the composed registry by the caller. */
  name: string;
  /** Its registry entry — every refusal below is read off this declaration. */
  entry: SecretRegistryEntry;
  /** The environment this Worker is, verified. The one environment a write can reach. */
  environment: ManagedEnvironment;
  /** Who asked, for the rotation row. The verified control-plane subject, never a claim from a body. */
  actor: string;
  /** Store attempts per environment. Defaults to the core's 3. Never a re-roll. */
  attempts?: number;
}

/**
 * The environment this Worker is, from the **verified** control-plane context rather than from a raw
 * binding.
 *
 * `verifyControlPlaneCall` has already refused a credential bound to a different environment than the one
 * this Worker's `ENVIRONMENT` var names, so by the time a handler reads it the two agree — and reading the
 * checked value rather than the var means there is no second, unchecked source of the same fact.
 *
 * `dev` and an unstamped Worker are both refused. `ManagedEnvironment` excludes `dev` because local dev has
 * no manager and no deployed store; an unstamped Worker yields the empty string, which is not a legal
 * environment name. Either way the answer is the same: this deployment cannot say where a value would land,
 * so it does not roll one.
 */
export function workerRotationEnvironment(environment: string): ManagedEnvironment {
  const parsed = ManagedEnvironment.safeParse(environment);
  if (!parsed.success) {
    throw new SecretRotationUnsupportedError({
      message: "This deployment cannot say which environment it is, so it will not replace a credential.",
      action:
        "Stamp ENVIRONMENT on the Worker's vars (pithy provision does), or rotate from a machine that holds the project: pithy secrets rotate <NAME> --env <env>.",
      detail: `rotate refused: the verified control-plane environment '${environment}' is not a deployed environment`,
    });
  }
  return parsed.data;
}

/**
 * Refuse a secret **this Worker** cannot replace, whatever the declaration says about rotating in general.
 *
 * Separate from {@link refuseUnrotatable}, deliberately: that one answers *can this secret be rotated at
 * all*, and its answers are true everywhere. These two are true only of a Worker, and the same secret is
 * rotatable from the CLI — so the refusal names the command rather than suggesting the declaration is
 * wrong.
 */
export function refuseUnrotatableHere(name: string, entry: SecretRegistryEntry): void {
  if (entry.backend === "cf-secrets-store") {
    throw new SecretRotationUnsupportedError({
      message: `Secret '${name}' lives in Cloudflare's Secrets Store, which no application Worker writes to. Rotate it with pithy secrets rotate ${name}.`,
      action: `Run pithy secrets rotate ${name} --env <env>. The secrets manager holds the Cloudflare credential this write needs; an application Worker binds that store read-only and must not hold one.`,
      detail: `rotate refused: '${name}' is backend cf-secrets-store, which is written through the CF REST API and not from this Worker`,
    });
  }
  if (entry.scope === "global") {
    throw new SecretRotationUnsupportedError({
      message: `Secret '${name}' is the same in every environment, and this Worker can only write its own. Rotate it with pithy secrets rotate ${name}.`,
      action: `Run pithy secrets rotate ${name}. It writes every declared environment in one run, which is what keeps a global secret identical everywhere.`,
      detail: `rotate refused: '${name}' is scope global, and a Worker-side rotation would write one of its environments and strand the rest`,
    });
  }
}

/** The store and the tracker for this request, from the Worker's own bindings. Built per request. */
export async function workerRotationDeps(c: Context<PithyHonoEnv>): Promise<WorkerRotationDeps> {
  const bindings = c.env as Record<string, unknown>;
  const database = bindings.SECRETS as D1Database | undefined;
  const masterKey = bindings[MASTER_KEY_BINDING] as SecretBinding | string | undefined;
  if (!database || masterKey === undefined) {
    throw new InternalError({
      message: "The secrets store is not configured.",
      action: `Bind a D1 database named SECRETS and the ${MASTER_KEY_BINDING} secret in wrangler.jsonc.`,
      detail: `A Worker-side rotation requires the SECRETS D1 binding and ${MASTER_KEY_BINDING}; ${
        database ? MASTER_KEY_BINDING : "SECRETS"
      } was absent on env.`,
    });
  }
  const env: SecretsStoreEnv = { SECRETS: database, SECRETS_ENCRYPTION_KEYS: masterKey };
  return { store: await SystemSecretsStore.fromEnv(env), tracker: RotationTracker.fromD1(database) };
}

/**
 * Rotate one secret in this Worker's own environment, and record the attempt.
 *
 * Refuse, open the row, produce once, store with retries, close the row, hand back the outcome. It never
 * throws for a rotation that *happened* and went wrong — that is what the outcome is for, and a throw would
 * take `recorded` and `stranded` with it. It throws only for the refusals, every one of which lands before
 * anything is called.
 */
export async function runWorkerRotation(
  deps: WorkerRotationDeps,
  request: WorkerRotationRequest,
): Promise<SecretRotationOutcome> {
  const { name, entry } = request;
  refuseUnrotatable(name, entry);
  refuseUnrotatableHere(name, entry);

  // A human in a console, and nothing to call. The core answers this too, and answering it here is what
  // keeps a rotation row from being opened for an act that never starts: a history of attempts that logs
  // the ones that were never attempted is a history nobody can read.
  if (entry.rotation?.kind === "manual") {
    return {
      name,
      kind: "manual",
      status: "unchanged",
      rolled: false,
      recorded: [],
      stranded: [],
      reason: "manual",
    };
  }

  // Knowable for free, and catastrophic to discover late: `runWriteSecret` in `update` mode raises on a
  // name the store does not hold, and for a `provider` secret that raise would land *after* the issuer had
  // rolled — manufacturing the one failure this design is built around out of a configuration gap.
  if (!(await deps.store.has(name))) {
    throw new SecretNotFoundError({
      message: `Secret '${name}' has never been stored in this environment, so there is nothing to replace.`,
      action: `Create it first: pithy secrets create ${name} --env ${request.environment}.`,
      detail: `rotate refused: '${name}' has no row in this environment's store`,
    });
  }

  // **The bracket is the core's, not this route's (`#379`).** This function opened the row and closed it
  // by hand, which was right when `rotateSecretValue` recorded nothing. `#379` moved the bracket into the
  // function that *performs* a rotation — same order, refuse then open then roll then close — and made
  // the ledger a required option, so the CLI cannot omit it the way it did. Keeping this bracket as well
  // would write the row twice.
  return rotateSecretValue({
    name,
    entry,
    targets: [request.environment],
    ledger: trackerRotationLedger(deps.tracker, {
      environment: request.environment,
      trigger: "manual",
      rotatedBy: request.actor,
    }),
    store: ({ value }) =>
      runWriteSecret(deps, {
        mode: "update",
        name,
        value,
        valueType: entry.valueType,
        rotatable: entry.rotatable,
      }).then(() => undefined),
    ...(request.attempts === undefined ? {} : { attempts: request.attempts }),
  });
}
