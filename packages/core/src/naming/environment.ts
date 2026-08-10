// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PithyError, ValidationError } from "../error/pithyError";
import { NAME_SEGMENT } from "./segment";

/**
 * What an environment may be called, in one module.
 *
 * An environment name is not decoration: it sits in the middle of every Cloudflare name a project
 * composes (`<project>-<env>-<thing>`), so its length is subtracted from every other segment's
 * budget, and its characters have to be legal in every namespace Pithy writes into. Until this
 * module existed, `--env` was a bare string that nothing checked — a fourteen-character environment
 * quietly ate the room a project name had already been accepted against.
 */

/**
 * The three first-class environments: local `dev`, `staging` for test users, `prod` for paid ones.
 *
 * **`prod`, not `production`.** The long form cost three characters of every project name, in a
 * budget where thirty-three was the ceiling, and bought nothing a four-letter word does not say.
 */
export const ENVIRONMENTS = ["dev", "staging", "prod"] as const;

/** One of Pithy's first-class environments. A custom environment is a `string`, and still validated. */
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * The scope that sits beside the environments: one value shared by all of them.
 *
 * It occupies the same slot as an environment in a composed name, which is exactly why an
 * environment may not be *called* `global` — a project would then have one set of names for two
 * different scopes, and teardown could not tell them apart.
 */
export const GLOBAL_SCOPE = "global";

/**
 * The environment one branch gets — the `env.feature` stanza a feature's provisioning run writes into.
 *
 * **A legal environment name, and never a declared one.** Legal because it is a real wrangler stanza
 * key, so every rule that governs a key governs it: seven characters, which is
 * {@link MAX_ENVIRONMENT_NAME} exactly. Never declared because the two kinds of environment write to
 * different files — a declared environment's ids are source, in the tracked `wrangler.jsonc`; a
 * feature's are a build artifact under `.wrangler/`. A project that declared this name would own two
 * files claiming one stanza, and the resolver that picks between them answers "generated" for this
 * name — so a migrate would read bytes no provisioning run wrote.
 *
 * It lives here rather than beside the scope that uses it because it is first an environment name, and
 * because {@link DeclaredEnvironments} has to refuse it: a constant defined downstream of the schema
 * that rejects it would be a cycle.
 */
export const FEATURE_ENVIRONMENT = "feature";

/**
 * The longest an environment name may be — **the longest canonical one, `staging`**.
 *
 * This is a derivation input, not a preference: `WORKFLOW_DERIVED_PROJECT_NAME` and
 * `FEATURE_DERIVED_PROJECT_NAME` are both computed against it, so every project name Pithy has ever
 * accepted was accepted on the assumption that no environment exceeds it. Letting a custom
 * environment run longer would retroactively shrink that cap — and a provisioned project cannot be
 * renamed. So a longer environment is refused here, at the one place that can still say no.
 *
 * Read off {@link ENVIRONMENTS} rather than typed, so adding an environment cannot leave the two
 * disagreeing.
 */
export const MAX_ENVIRONMENT_NAME = Math.max(...ENVIRONMENTS.map((environment) => environment.length));

/**
 * Is this a name an environment may carry?
 *
 * **Read raw, never kebabbed** — and that is the difference between this rule and the project rule.
 * A project name is prose an adopter types once into `pithy.config.ts`, so `Acme Corp` is politely
 * composed into `acme-corp`. An environment is an identifier repeated in `--env`, in
 * `.dev.vars.<environment>`, and in a wrangler environment key; normalising `Prod` to `prod` would
 * make two spellings name one environment in some places and two in others.
 */
export function isValidEnvironment(name: string): boolean {
  if (name === GLOBAL_SCOPE) return false;
  return name.length <= MAX_ENVIRONMENT_NAME && NAME_SEGMENT.test(name);
}

/**
 * Refuse a name no environment may carry, as a `ValidationError` — an environment comes from a flag
 * or a config file, so it is a 400 with an action, never an internal fault.
 *
 * Three different mistakes get three different sentences, because "invalid environment" helps with
 * none of them: `production` is the old spelling and gets the new one, a long name gets the number,
 * and anything else gets the charset.
 */
export function assertValidEnvironment(name: string): void {
  if (isValidEnvironment(name)) return;
  if (name === "production") {
    throw new ValidationError({
      message: `"production" is not an environment name in Pithy.`,
      action: "Use `prod`.",
      detail: `An environment stops at ${MAX_ENVIRONMENT_NAME} characters, the length of the longest of ${ENVIRONMENTS.join(", ")}.`,
    });
  }
  if (name === GLOBAL_SCOPE) {
    throw new ValidationError({
      message: `"${GLOBAL_SCOPE}" is a scope, not an environment.`,
      action: `Name the environment one of ${ENVIRONMENTS.join(", ")}.`,
      detail: `${GLOBAL_SCOPE} occupies the environment slot of a composed name for values shared across every environment.`,
    });
  }
  if (name.length > MAX_ENVIRONMENT_NAME && NAME_SEGMENT.test(name)) {
    throw new ValidationError({
      message: `"${name}" is ${name.length} characters. An environment stops at ${MAX_ENVIRONMENT_NAME}.`,
      action: `Use one of ${ENVIRONMENTS.join(", ")}, or a shorter name.`,
      detail: `Every project-name budget is derived against a ${MAX_ENVIRONMENT_NAME}-character environment, and a provisioned project cannot be renamed.`,
    });
  }
  throw new ValidationError({
    message: `"${name}" can't be an environment name.`,
    action: "Use lowercase letters, digits, and single hyphens, starting with a letter.",
    detail: `An environment is used verbatim in Cloudflare resource names, so it must match ${NAME_SEGMENT.source}.`,
  });
}

/**
 * The environments a project has when it declares nothing: `staging` for test users, `prod` for paid ones.
 *
 * The same two {@link ENVIRONMENTS} names minus `dev`, and the same two the starter scaffolded from a
 * hardcoded template before anything could say otherwise — so a project that never opens this setting
 * gets exactly what it got before.
 */
export const DEFAULT_ENVIRONMENTS = ["staging", "prod"] as const;

/** The local environment. Never declared: it is the top-level wrangler stanza, and it always exists. */
const LOCAL_ENVIRONMENT = "dev";

/**
 * **The set of deployed environments a project has**, declared once in the root `pithy.config.ts`.
 *
 * Until this existed a project never said. The set lived only as `env.<name>` stanzas in each Worker's
 * `wrangler.jsonc` — per Worker, so two Workers in one project could disagree and nothing reconciled them
 * — while `ManagedEnvironment` held a closed enum of two and `seed.productionEnvironments` invited a
 * project to name a third. An adopter adding `env.live` got `pithy migrate --env live` working and
 * `pithy secrets provision` skipping it in silence, because the three answers were never the same answer.
 *
 * **Ordered, and the order is meaningful.** It is the order provisioning walks — least-production first,
 * so a mistake is made in staging before it is made in prod — and the last entry is the one a
 * `global` account-level secret is written through (see `@pithy-sh/secrets`'s `resolveWriteTargets`).
 * `["staging", "prod"]` therefore behaves exactly as the hardcoded pair did.
 *
 * **`dev` is not declarable.** It is local, it is the top-level wrangler stanza rather than an `env.dev`,
 * and it resolves from Miniflare rather than an account — so a project always has it and provisioning
 * never has it. Declaring it would ask a deploy to happen for an environment that never deploys.
 *
 * **Nothing is renamed by editing this.** `<project>-<env>-<thing>` is computed from the declaration and
 * never stored, so changing a name here orphans everything already provisioned under the old one, exactly
 * as renaming `name` does. `pithy doctor` reports the change rather than applying it.
 */
export const DeclaredEnvironments = z
  .array(
    z
      .string()
      .describe(
        "One deployed environment's name, used verbatim in the middle of every Cloudflare name the project composes and in each Worker's `env.<name>` wrangler stanza.",
      ),
  )
  .check((ctx) => {
    if (ctx.value.length === 0) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: `Declare at least one environment. A project with none can never deploy — ${DEFAULT_ENVIRONMENTS.join(" and ")} is the default.`,
      });
    }
    const seen = new Set<string>();
    for (const name of ctx.value) {
      if (name === LOCAL_ENVIRONMENT) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          message: `"${LOCAL_ENVIRONMENT}" is local and always present, so it is never declared. List only the environments this project deploys.`,
        });
        continue;
      }
      if (name === FEATURE_ENVIRONMENT) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          message: `"${FEATURE_ENVIRONMENT}" is the environment a branch gets, and its config is generated rather than committed. Declaring it would give one stanza two owners.`,
        });
        continue;
      }
      if (seen.has(name)) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          message: `"${name}" is declared twice. One environment is one set of Cloudflare names.`,
        });
        continue;
      }
      seen.add(name);
      // The naming rule is `assertValidEnvironment`'s, not a second copy of it — a declaration that
      // core's namer would refuse must be refused in the declaration's own sentence, or a project could
      // write down an environment nothing could ever provision a resource for.
      try {
        assertValidEnvironment(name);
      } catch (error) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          message: error instanceof PithyError ? error.payload.message : `"${name}" can't be an environment name.`,
        });
      }
    }
  })
  .describe(
    "Every deployed environment this project has, in the order provisioning walks them — least-production first. Declared once in the root pithy.config.ts, because the set cannot be per-Worker. `dev` is never listed: it is local and always present.",
  );

/** Every deployed environment a project has. Same name as its schema, as every Zod object here is. */
export type DeclaredEnvironments = z.output<typeof DeclaredEnvironments>;
