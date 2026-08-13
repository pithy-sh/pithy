// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import type { SecretBackend, SecretScope } from "../registry";
import { canonicalGlobalEnvironment, type ManagedEnvironment, resolveWriteTargets } from "../scope";

/**
 * **Where a write is allowed to land, decided once, before anything is dispatched.**
 *
 * A `global` secret is *defined* by holding one value in every environment — `email-link-signing-key`
 * exists so a link signed in staging verifies in prod. A split is therefore not a state the product has
 * a meaning for, and it can arrive two ways:
 *
 * 1. **An operator asks for one.** `pithy secrets update <global> --env staging` narrows a scope that
 *    cannot be narrowed. This is a category error, not a fault, and it is what this module refuses.
 * 2. **A fan-out fails part-way.** Three environments, the third throws. That one is a fault, it is not
 *    preventable here, and the honest treatment is below.
 *
 * ## Why refusal is all this can offer, and why that is enough
 *
 * The write path is `CLI → dispatch → one Workflow per environment, in one Worker per environment`.
 * There is no transaction across them and no rollback: a compensating write is itself a Workflow that
 * can fail, which is the same problem one level down. **So "complete-or-revert" is not available and is
 * not implied.** What is available is deciding before anything is written, which is exactly what closes
 * case 1 — and case 1 is the one an ordinary command produces.
 *
 * This is why the refusal is here and not in the manager. A Workflow that throws does not produce a CLI
 * error: it fails an instance, the runtime retries it, and the CLI polls and has to read an operator's
 * typo as a distributed failure. Retrying a refusal is nonsense. Refusing before dispatch also satisfies
 * *a refusal that has already written is not a refusal* for free — nothing was sent, so nothing landed.
 *
 * ## The residual window, stated rather than papered over
 *
 * Case 2 remains reachable. A `global` + `d1` secret fans out across every declared environment, and a
 * fault inside that fan-out leaves some environments on the new value and the rest on the old. Nothing
 * here narrows that. What the dispatch path does instead is **say what it wrote** — see
 * `environmentsWrittenBeforeFailure` in `./dispatch.ts` — so the split is visible to the operator who
 * has to repair it. A guarantee that cannot be given is not given.
 *
 * `global` + `cf-secrets-store` needs none of this, and the reason is structural rather than an
 * oversight: it is one account-level entry that every environment binds, so it is a single write with
 * nothing to be inconsistent with (`resolveWriteTargets`). It still refuses `--env`, because narrowing a
 * scope that has no parts is the same category error arriving at a backend where it happens to be
 * harmless.
 *
 * ## One owner, so a third caller inherits it
 *
 * `resolveWriteTargets` in `../scope.ts` is the backend × scope **table**. It holds no policy and it
 * refuses nothing. This is the **rule**, and it is what `dispatchSecretWrite` and `mintDeclaredSecrets`
 * both call to obtain their targets. `capabilities/writeTargetsOwner.test.ts` in `@pithy-sh/cli` fails
 * the build on any shipped module that reaches the table directly, so a write path added later cannot
 * quietly skip the rule by naming the thing underneath it.
 */
export interface SecretWriteIntent {
  /** The secret's registry name. It appears in the refusal, so the operator knows which one is global. */
  name: string;
  /** Where the secret is held. Decides the fan-out shape for a `global` write; never decides the rule. */
  backend: SecretBackend;
  /** The secret's declared scope. This is what the rule is about. */
  scope: SecretScope;
  /** What the command is doing. It changes the wording of the remedy and nothing else — see the tests. */
  mode: "create" | "update" | "delete";
  /**
   * The environment the operator named, or `undefined` when they named none.
   *
   * **The absence has to survive to here**, which is why this is optional rather than defaulted upstream.
   * The command used to resolve a missing `--env` on a global secret to the canonical environment before
   * dispatch, which erased the difference between *the operator narrowed the write* and *the operator
   * said nothing* — and it is exactly that difference the rule turns on.
   */
  requested: ManagedEnvironment | undefined;
  /** Every environment the project declares, from the root `pithy.config.ts`. The fan-out set. */
  declared: DeclaredEnvironments | readonly string[];
}

/** The remedy's verb, by mode. A `rm` that is told to "set it everywhere" is a remedy for another command. */
const REMEDY: Record<SecretWriteIntent["mode"], string> = {
  create: "set it in every environment",
  update: "set it in every environment",
  delete: "remove it from every environment",
};

/**
 * The environments this write reaches — or a refusal, thrown, if the request and the scope disagree.
 *
 * Two refusals, and they are the same rule read from both ends: a `global` secret cannot be narrowed to
 * one environment, and an `environment` secret cannot be widened to all of them. Neither has a bypass
 * flag. The remedy for both is a single re-run, and a re-run is the confirmation of intent that a `--yes`
 * would otherwise have to stand in for.
 */
export function secretWriteTargets(intent: SecretWriteIntent): ManagedEnvironment[] {
  if (intent.scope === "environment") {
    if (intent.requested === undefined) {
      throw new ValidationError({
        message: `Secret '${intent.name}' is environment-scoped — choose an environment.`,
        action: `Pass one of ${intent.declared.map((env) => `--env ${env}`).join(" or ")}.`,
        detail: `environment-scoped secret '${intent.name}' dispatched with no requested environment`,
      });
    }
    return resolveWriteTargets(intent.backend, intent.scope, intent.requested, intent.declared);
  }

  if (intent.requested !== undefined) {
    throw new ValidationError({
      message: `Secret '${intent.name}' is global. It holds one value across every environment, so --env cannot narrow it.`,
      action: `Run it again without --env to ${REMEDY[intent.mode]}.`,
      detail: `global secret '${intent.name}': ${intent.mode} narrowed to ${intent.requested}, which the scope does not permit`,
    });
  }

  // The canonical environment is the table's input for a `global` write, not the operator's — it picks
  // which manager performs the single `cf-secrets-store` write, and is unread for `d1`. Resolved here so
  // the table keeps its signature and the command stops inventing an environment it was never given.
  const canonical = canonicalGlobalEnvironment(intent.declared);
  if (canonical === undefined) {
    throw new ValidationError({
      message: `This project declares no environments, so '${intent.name}' has nowhere to go.`,
      action: "Declare at least one environment in the root pithy.config.ts, then run this again.",
      detail: `global secret '${intent.name}': empty declaration`,
    });
  }
  return resolveWriteTargets(intent.backend, intent.scope, canonical, intent.declared);
}
