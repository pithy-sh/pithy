// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "../error/pithyError";
import { MAX_ENVIRONMENT_NAME } from "./environment";
import {
  FEATURE_DERIVED_PROJECT_NAME,
  MAX_CAPABILITY_JOB,
  NAMESPACE_LIMITS,
  WORKFLOW_DERIVED_PROJECT_NAME,
} from "./limits";
import { NAME_SEGMENT } from "./segment";

/**
 * One naming rule, in one module: **`<project>-<env>-<thing>`**, kebab-case.
 *
 * Every Cloudflare namespace Pithy writes into is flat and account-wide — D1, KV, R2, Worker
 * scripts, Workflows, the single Secrets Store, the API-token list. None of them can be
 * partitioned, so the *name* is the partition, and the project segment is the only thing keeping
 * two Pithy projects in one account from adopting or overwriting each other's resources.
 *
 * **Project first** because that is the ownership boundary everything turns on: teardown, the
 * token listing's prefix filter, and the reaper's reservation all key on it. **Environment second**
 * because these end up in listings nobody can filter — `wrangler d1 list`, the account dashboard,
 * the Secrets Store — and sorting by name should group a project's resources and then that
 * project's environments, so everything belonging to prod sits together. Environment last
 * would scatter prod through the listing, interleaved with staging, which is exactly when
 * someone acts on the wrong one.
 *
 * A `global`-scoped thing puts the literal `global` in the environment slot rather than omitting
 * it, so the scheme has no exception to remember.
 *
 * This module is in `core` because it has no dependencies and every layer needs it — capabilities,
 * the CLI, and the Workers runtime alike. It therefore uses **no `node:` builtin**: core is bundled
 * into the adopter's Worker, where `node:crypto` is not free.
 */

/**
 * The default budget of the un-namespaced {@link resourceName} composer: the strictest cap of any
 * namespace Pithy writes into, which is R2's 63.
 *
 * A caller that knows its namespace does **not** use this — it passes that namespace's own limit
 * from `./limits`, or, better, goes through the facade in `./resourceNames`, which cannot pick the
 * wrong budget. This number is the conservative answer for a call site that has no namespace at all.
 */
export const MAX_RESOURCE_NAME = NAMESPACE_LIMITS.r2.maxLength;

/** Below this the trailing segment is not worth keeping legible, so a name this tight is refused instead. */
const MIN_THING_BUDGET = 1;

/**
 * The cap on a project name — **derived, not chosen, and derived from two shapes rather than one**.
 *
 * A project name has to survive every name it will ever be the head of, so it gets the *smaller* of
 * the two worst cases (`./limits` carries both derivations with their arithmetic):
 *
 * - {@link WORKFLOW_DERIVED_PROJECT_NAME} — `<project>-<env>-<capability>-<job>` against a Workflow's
 *   64 characters, after the longest environment and the longest `<capability>-<job>`.
 * - {@link FEATURE_DERIVED_PROJECT_NAME} — `<project>-f<issue>-<slug>-<binding>-<kind>` against R2's
 *   63, with room for the reserved issue digits, a legible slug, and a binding kept whole.
 *
 * Neither number is repeated here. Each is a computed constant with its arithmetic in `./limits`, and a
 * copy in this sentence is a copy that goes stale the first time a term of the derivation moves.
 *
 * The feature shape is the binding one, and it used to be invisible: the cap was derived from the
 * Workflow alone, so a project inside it could still compose a feature name whose slug was hashed
 * away to nothing. Taking the minimum is the only version that is true of both.
 *
 * **Why the cap belongs on the project name rather than on each composed name:** without it the
 * refusal lands at the first `pithy <capability> provision`, by which time `pithy add` has created
 * real R2 buckets and D1 databases under a name that fits *their* budget. The project is
 * half-provisioned, and the only documented remedy — renaming — orphans everything already made.
 * Capped here, `pithy init` and `requireProjectName` refuse it before anything is written.
 */
export const MAX_PROJECT_NAME = Math.min(WORKFLOW_DERIVED_PROJECT_NAME, FEATURE_DERIVED_PROJECT_NAME);

/** Lowercase, collapse any run of non-`[a-z0-9]` to one `-`, and trim leading/trailing `-`. */
export function kebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A stable 6-hex-character digest, FNV-1a. Pure arithmetic rather than `node:crypto` so this module
 * runs unchanged in a Worker. It is a *disambiguator for truncated names*, never a security
 * primitive — collision resistance beyond "two different capability names look different" is not
 * claimed and must not be relied on.
 */
export function hash6(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * Fit a kebab segment into `budget` characters: verbatim when it fits, otherwise a truncated head
 * plus a short stable hash so it stays distinct and within budget. Deterministic in `segment`
 * alone, so two commands computing the same name agree without storing it. The hash shrinks for
 * tiny budgets, and the result never exceeds `budget` nor trails a hyphen.
 */
export function fitSegment(segment: string, budget: number): string {
  if (budget <= 0) return "";
  if (segment.length <= budget) return segment;
  if (budget < 4) return hash6(segment).slice(0, budget);
  const hashLen = Math.min(6, Math.max(2, budget - 2));
  const headLen = Math.max(1, budget - hashLen - 1);
  return `${segment.slice(0, headLen).replace(/-+$/, "")}-${hash6(segment).slice(0, hashLen)}`;
}

/** The parts of a provisioned name. Every field is required — an absent segment is a naming bug, not a default. */
export interface ResourceNameParts {
  /**
   * The project name — the root `pithy.config.ts` `name`, resolved by `requireProjectName` and
   * **never guessed**. This is the ownership boundary; a wrong value here writes into another
   * project's resources.
   */
  project: string;
  /** The environment (`dev`, `staging`, `prod`), or the literal `global` for a value shared across all of them. */
  env: string;
  /** What this resource is — a capability, a binding, a secret, a token profile. The only segment ever truncated. */
  thing: string;
}

/**
 * Compose `<project>-<env>-<thing>`, kebab-cased and fitted to `budget`.
 *
 * **Only `thing` is ever truncated.** The project and environment segments are taken verbatim,
 * because a hashed project segment would let two long project names share a prefix — and the token
 * listing filters on exactly that prefix, so a collision there means one project enumerating and
 * acting on another's credentials. If project and environment alone cannot fit, that is refused
 * with the limit named rather than quietly hashed into an ambiguous name.
 *
 * `budget` defaults to {@link MAX_RESOURCE_NAME}; a namespace with its own limit passes it in.
 *
 * The project segment is held to {@link isValidProjectName} — the same rule the Worker and Workflow
 * namers apply — so a project this accepts is one every namespace accepts. It is a backstop, not the
 * gate: the real refusal belongs at `pithy init` and `requireProjectName`, before anything is written.
 */
export function resourceName(parts: ResourceNameParts, budget: number = MAX_RESOURCE_NAME): string {
  const project = kebab(parts.project);
  const env = kebab(parts.env);
  const thing = kebab(parts.thing);

  for (const [role, value] of [
    ["project", project],
    ["environment", env],
    ["thing", thing],
  ] as const) {
    if (!value) {
      throw new ValidationError({
        message: `A resource name needs a ${role}.`,
        action: role === "project" ? "Set `name` in pithy.config.ts." : undefined,
        detail: `resourceName received an empty ${role} segment (raw: ${JSON.stringify(parts)})`,
      });
    }
  }

  assertValidProjectName(parts.project);

  const head = `${project}-${env}`;
  const thingBudget = budget - head.length - 1;
  if (thingBudget < MIN_THING_BUDGET) {
    throw new InternalError({
      message: `The project and environment names alone exceed the ${budget}-character limit for this resource.`,
      action: "Shorten `name` in pithy.config.ts.",
      detail: `"${head}" leaves ${thingBudget} characters for "${thing}"`,
    });
  }

  return `${head}-${fitSegment(thing, thingBudget)}`;
}

/**
 * Could every Cloudflare name this project generates be created? The one rule, in one place, so no
 * namespace re-derives a looser version of it.
 *
 * **Read after kebabbing**, for the same reason {@link isReservedProjectName} is: the raw string never
 * reaches an account, only what the composer made of it. `Acme Corp` is legal (it becomes `acme-corp`);
 * `2026 Launch` is not, and neither answer can be read off the raw characters.
 *
 * **Two dimensions, one answer: charset and length.** Both have the same failure mode and so must have
 * the same home — {@link NAME_SEGMENT} for the charset, {@link MAX_PROJECT_NAME} for the number. The
 * charset is the shared segment rule rather than a project-specific one: a project name is the head of
 * every composed name, so it is held to exactly what every other segment is held to.
 *
 * The rule matters at the *source* — `pithy init` and `requireProjectName` — because the namespaces
 * disagree about it. A digit-leading project composes a legal D1 database name, a legal KV title, and a
 * legal bucket name, so `pithy add` provisions all three for real; only the first host-worker deploy
 * refuses it, by which point the documented remedy — rename the project — orphans everything already
 * created. A 33-character project fails exactly the same way, one deploy later. One rule, enforced
 * before anything is written, is the only version of this that is safe.
 */
export function isValidProjectName(name: string): boolean {
  const normalized = kebab(name);
  return normalized.length <= MAX_PROJECT_NAME && NAME_SEGMENT.test(normalized);
}

/**
 * Refuse a project name no Cloudflare namespace could carry, as a **`ValidationError`**: a project name
 * is something a human typed, so it is a 400 with an action, never an internal 500 blamed on the toolkit.
 *
 * Length and charset are one rule with two sentences, because they are two different mistakes: a name
 * that is merely long is otherwise perfect, and "use lowercase letters" would be no help at all.
 */
export function assertValidProjectName(name: string): void {
  if (isValidProjectName(name)) return;
  const normalized = kebab(name);
  if (normalized.length > MAX_PROJECT_NAME && NAME_SEGMENT.test(normalized)) {
    throw new ValidationError({
      message: `"${name}" is ${normalized.length} characters. A project name stops at ${MAX_PROJECT_NAME}.`,
      action: `Shorten \`name\` in pithy.config.ts to ${MAX_PROJECT_NAME} characters or fewer.`,
      detail: `${MAX_PROJECT_NAME} is the smaller of what a 64-character Workflow name leaves after a ${MAX_ENVIRONMENT_NAME}-character environment and a ${MAX_CAPABILITY_JOB}-character <capability>-<job> (${WORKFLOW_DERIVED_PROJECT_NAME}), and what a 63-character feature resource name leaves after a six-digit issue, a legible slug, and a binding (${FEATURE_DERIVED_PROJECT_NAME}).`,
    });
  }
  throw new ValidationError({
    message: `"${name}" can't be a project name.`,
    action: "Use lowercase letters, digits, and single hyphens, starting with a letter.",
    detail: `"${name}" kebabs to "${normalized}", which does not match ${NAME_SEGMENT.source}.`,
  });
}

/**
 * **`pithy-int-` is reserved for Pithy's own live integration tests, on any account.**
 *
 * Every Cloudflare name a live test creates begins with it, no real project's name may, and the
 * test-debris reaper deletes nothing without it. The reservation is what makes automatic reaping safe
 * in both directions: without it the reaper is guessing — either it fails to recognize the names a
 * suite invented, and debris accumulates silently on a real account, or it matches loosely enough to
 * one day delete a customer's database. With it, membership is decidable from the name alone.
 *
 * It lives here, next to the composer, because both halves of the reservation are naming facts.
 * `<project>-<env>-<thing>` puts the project first and takes it **verbatim**, so the prefix of every
 * generated name is decided by the project name and nothing else — which is what lets one guard, on
 * `pithy init`, keep the two sets from ever overlapping. See {@link isReservedProjectName}.
 *
 * This is deliberately narrower than the product's own `pithy` prefix. A project may legitimately be
 * named `pithy-app`, and everything it provisions is real; `pithy-int-…` is debris by definition.
 */
export const RESERVED_TEST_PREFIX = "pithy-int-";

/**
 * Would a project of this name generate resource names inside the reservation? The one rule
 * `pithy init` enforces, stated once so no call site re-derives it.
 *
 * Two traps make the obvious `name.startsWith(RESERVED_TEST_PREFIX)` wrong, and both are reachable
 * with a name a human would type.
 *
 * **Kebabbing.** The composer kebabs the project before using it, so the raw string is not what
 * Cloudflare sees. `"Pithy Int Ruse"` is not prefixed by `pithy-int-`, and it normalizes straight into
 * the reservation.
 *
 * **The trailing hyphen.** The composer appends one after the project. A project named exactly
 * `pithy-int` is not prefixed by `pithy-int-` either, and it generates `pithy-int-dev-db` — inside the
 * namespace the reaper deletes.
 *
 * Testing `` `${kebab(name)}-` `` against the prefix closes both: it compares the form the composer
 * actually uses, including the separator it actually adds.
 */
export function isReservedProjectName(name: string): boolean {
  return `${kebab(name)}-`.startsWith(RESERVED_TEST_PREFIX);
}
