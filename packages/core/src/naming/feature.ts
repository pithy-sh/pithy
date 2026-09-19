// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "../error/pithyError";
import { featureMarker } from "./environment";
import { MAX_ISSUE_DIGITS, NAMESPACE_LIMITS } from "./limits";
import { assertValidProjectName, fitSegment, kebab } from "./resource";

/**
 * The names a feature environment provisions under: `<project>-f<issue>-<slug>-<binding>-<kind>` for a
 * resource, `<project>-f<issue>-<slug>-<worker>` for a Worker script.
 *
 * **No environment segment, and no Worker segment.** A feature *is* an environment, and two Workers that
 * declare the same binding are meant to share one resource — so the binding name, not the topology, is
 * where sharing is expressed.
 *
 * Every name here is **derived and recomputed**, never stored: `provision` and `destroy` both compute the
 * same string from `(identity, binding, kind)`, which is what lets teardown reconcile exactly rather than
 * scan a prefix a hyphenated sibling slug could ambiguously match. That is also why these names
 * **truncate** where a capability's Workflow refuses: a feature name addresses nothing that outlives the
 * feature, and failing a CI run because a branch slug was long would be the worse failure.
 *
 * It lives in `core`, beside the rest of the naming rule, so the CLI and the facade compose one
 * implementation rather than two that drift.
 */

/** A Cloudflare resource kind a feature can provision. All two characters — `MAX_FEATURE_KIND` in `./limits`. */
export type FeatureResourceKind = "d1" | "kv" | "r2";

/** Every feature resource kind, for tests and for callers that enumerate. */
export const FEATURE_RESOURCE_KINDS: readonly FeatureResourceKind[] = ["d1", "kv", "r2"];

/** The identity of a feature — everything a feature name is derived from. */
export interface FeatureIdentity {
  /** The project name, from the root `pithy.config.ts` (e.g. `acme`). */
  project: string;
  /** The issue number as a string (e.g. `69`). Digits only, up to {@link MAX_ISSUE_DIGITS}. */
  issue: string;
  /** The kebab-case feature slug, from the branch (e.g. `media-cli`). */
  slug: string;
}

/** Below this the slug segment isn't worth keeping legible; the trailing segment is truncated to give it room. */
const MIN_SLUG_BUDGET = 3;

/**
 * Refuse an issue number the budgets were not derived against.
 *
 * `MAX_ISSUE_DIGITS` is a term in {@link FEATURE_DERIVED_PROJECT_NAME}, so an eight-digit issue would
 * quietly spend a character every project name was already accepted against. It is also the cheapest
 * possible check that the value is an issue number at all — `featureResourceName` used to interpolate
 * whatever string it was handed straight into a Cloudflare name.
 */
function assertIssue(issue: string): void {
  if (new RegExp(`^[0-9]{1,${MAX_ISSUE_DIGITS}}$`).test(issue)) return;
  throw new ValidationError({
    message: `"${issue}" is not an issue number.`,
    action: `Use the issue's digits, up to ${MAX_ISSUE_DIGITS} of them.`,
    detail: `Feature resource names reserve ${MAX_ISSUE_DIGITS} digits, and every project-name budget is derived against that.`,
  });
}

/** The `<project>-f<issue>` head both feature shapes share, with the project held to the one project rule. */
function head(identity: FeatureIdentity): string {
  assertValidProjectName(identity.project);
  assertIssue(identity.issue);
  return `${kebab(identity.project)}-${featureMarker(identity.issue)}`;
}

/**
 * **The prefix every name one feature composes starts with** — `<project>-f<issue>-`, dash included (#643).
 *
 * Whatever a feature names — a resource, a Worker, a Workflow, a store entry — begins with this, and nothing
 * another feature or a declared environment names does. So it is how a check that must not trust a resolver
 * asks "is this name the feature's?" without recomposing every kind of name a resolver might produce.
 */
export function featureNamePrefix(identity: FeatureIdentity): string {
  return `${head(identity)}-`;
}

/**
 * Fit `<head>-<slug>-<tail><fixed>` into `budget`, truncating the slug first and the tail only if the
 * tail is what is eating the name. `fixed` is never touched — it carries the kind suffix, which is the
 * only thing telling a `DB` bucket from a `DB` database.
 *
 * Deterministic in its inputs and hash-disambiguated on both variable segments, so two long inputs
 * sharing a prefix still produce two different names.
 */
function composeFeatureName(headSegment: string, slug: string, tail: string, fixed: string, budget: number): string {
  for (const [role, value] of [
    ["slug", slug],
    ["binding or worker", tail],
  ] as const) {
    if (value) continue;
    // An empty segment composed `acme-f69--db-d1`, or a name ending in a dash. Neither is a legal
    // bucket or script name, and both used to come out of here without a word.
    throw new ValidationError({
      message: `A feature resource name needs a ${role}.`,
      action: "Use letters, digits, and hyphens — something that survives kebabbing.",
      detail: `composeFeatureName received an empty ${role} segment for "${headSegment}".`,
    });
  }

  const inner = budget - fixed.length;
  let tailSegment = tail;
  let slugBudget = inner - headSegment.length - 1 - (1 + tailSegment.length);

  if (slugBudget < MIN_SLUG_BUDGET) {
    // The tail is eating the name — truncate it too, reserving the slug its minimum.
    const tailBudget = inner - headSegment.length - 1 - MIN_SLUG_BUDGET - 1;
    tailSegment = fitSegment(tailSegment, Math.max(1, tailBudget));
    slugBudget = inner - headSegment.length - 1 - (1 + tailSegment.length);
  }

  return `${headSegment}-${fitSegment(slug, Math.max(1, slugBudget))}-${tailSegment}${fixed}`;
}

/**
 * The full Cloudflare resource name for a feature's binding — `<project>-f<issue>-<slug>-<binding>-<kind>`.
 *
 * Held to **R2's 63**, the strictest of the three kinds a feature provisions, so one shape is legal for
 * all of them: lowercase, hyphenated, alphanumeric at both ends. A D1 or KV name could be longer, but a
 * feature that provisions a bucket and a database wants them recognizably the same name.
 */
export function featureResourceName(identity: FeatureIdentity, binding: string, kind: FeatureResourceKind): string {
  return composeFeatureName(
    head(identity),
    kebab(identity.slug),
    kebab(binding),
    `-${kind}`,
    NAMESPACE_LIMITS.r2.maxLength,
  );
}

/**
 * The CF Secrets Store entry name holding one of a feature's **environment-scoped** secrets —
 * `<project>-f<issue>-<slug>-<secret>`.
 *
 * A Cloudflare account has one Secrets Store, flat and unpartitionable, so the entry name is the only
 * partition there is. A feature therefore needs its own names for the same reason it needs its own
 * database: without them a branch would adopt staging's master key, and its teardown would delete it.
 *
 * Held to the **Secrets Store** limit rather than R2's 63, like every other entry name — an entry has
 * no documented Cloudflare cap, and holding it to the strictest kind's would hash
 * `secrets-encryption-keys` down to nothing for no reason.
 *
 * A `global` secret is named here too since #643: a feature shares nothing with any other environment, so
 * its entry for a global secret is its own rather than the project's `<project>-global-<secret>`.
 */
export function featureSecretEntryName(identity: FeatureIdentity, secret: string): string {
  return composeFeatureName(
    head(identity),
    kebab(identity.slug),
    kebab(secret),
    "",
    NAMESPACE_LIMITS.secretEntry.maxLength,
  );
}

/**
 * The Worker **script name** for one of a feature's workers — `<project>-f<issue>-<slug>-<worker>`.
 *
 * This is the name the feature's Workers deploy under, and therefore the name a sibling's `service`
 * binding must target, so RPC inside a feature environment reaches that feature's deployment rather than
 * production's.
 *
 * Held to the **Worker rule** ({@link NAMESPACE_LIMITS.worker}), which is the bug this used to have: it
 * floored the slug at one character and never touched the worker segment, so it ran unbounded — 69
 * characters for a worker called `collaboration-realtime-gateway`, 109 for a 70-character one. `apps/<name>`
 * has a charset rule and no length rule, so nothing upstream was going to stop it either.
 *
 * **`app` is the `apps/<app>` directory, never the deploy name.** A scaffolded Worker deploys as
 * `<project>-<app>`, and handing that here composed `<project>-f<issue>-<slug>-<project>-<app>` — the
 * project twice, spent out of the budget above (#587). This function takes a string and cannot tell the
 * two apart, so the provisioning path reaches it only through `featureScope`, which is handed both names
 * and picks.
 */
export function featureWorkerName(identity: FeatureIdentity, app: string): string {
  return composeFeatureName(head(identity), kebab(identity.slug), kebab(app), "", NAMESPACE_LIMITS.worker.maxLength);
}

/**
 * The deployed name of one of a feature's **Workflows** — `<project>-f<issue>-<slug>-<capability>-<job>` (#643).
 *
 * A Workflow name is account-wide, like a Worker's, so a feature's email host cannot run
 * `<project>-feature-email-send`: every open branch would deploy the same Workflow over every other's. It takes
 * the feature's head instead, exactly as its host Worker does ({@link featureWorkerName}), so the Worker and the
 * Workflows it hosts are recognizably one feature's and teardown recomputes both from the identity.
 *
 * Held to the **Workflow** limit ({@link NAMESPACE_LIMITS.workflow}), and fitted the way every feature name is:
 * the slug gives way first, then the `<capability>-<job>` tail, deterministically.
 */
export function featureWorkflowName(identity: FeatureIdentity, capability: string, job: string): string {
  return composeFeatureName(
    head(identity),
    kebab(identity.slug),
    `${kebab(capability)}-${kebab(job)}`,
    "",
    NAMESPACE_LIMITS.workflow.maxLength,
  );
}

/**
 * The name of one of a feature's **Vectorize indexes** — `<project>-f<issue>-<slug>-<thing>` (#643).
 *
 * An index name is account-wide, so a feature's vector host cannot bind `<project>-feature-vector-<index>`: every
 * open branch would read and write one index. Held to the Vectorize limit and fitted the way every feature name
 * is, so teardown recomputes it from the identity.
 */
export function featureVectorizeIndexName(identity: FeatureIdentity, thing: string): string {
  return composeFeatureName(
    head(identity),
    kebab(identity.slug),
    kebab(thing),
    "",
    NAMESPACE_LIMITS.vectorizeIndex.maxLength,
  );
}

/** How many rate limiters one feature Worker can give a namespace of its own: one decimal digit of slot. */
export const MAX_FEATURE_RATELIMITS = 10;

/**
 * **A feature's own rate-limit `namespace_id` for its `slot`-th limiter** — never staging's, prod's, the top
 * level's, or a sibling feature's (#643).
 *
 * Cloudflare keys a rate limiter's counters by `namespace_id` across the whole account, so a feature Worker bound
 * to the top level's namespace spends production's per-IP budget, and two branches spend each other's. So every
 * `ratelimits` binding in a feature stanza is renumbered here: `1`, the issue in six digits, two digits of the
 * project and slug, and the slot — ten digits, under 2^31, and exact in the issue, so two open features of one
 * project with different issues can never share one. Two branches for **one** issue share one only if their
 * project-and-slug digits agree as well. The leading `1` keeps the id clear of the small hand-picked ids adopters
 * write, and `pithy provision --feature` still refuses an id the tracked config already uses, so a collision with
 * a declared environment is refused rather than assumed away.
 */
export function featureRatelimitNamespaceId(identity: FeatureIdentity, slot: number): string {
  assertValidProjectName(identity.project);
  if (!/^[0-9]+$/.test(identity.issue) || identity.issue.length > MAX_ISSUE_DIGITS) {
    throw new ValidationError({
      message: `A feature's issue number is at most ${MAX_ISSUE_DIGITS} digits.`,
      detail: `featureRatelimitNamespaceId: issue "${identity.issue}"`,
    });
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_FEATURE_RATELIMITS) {
    throw new ValidationError({
      message: `A feature Worker can bind at most ${MAX_FEATURE_RATELIMITS} rate limiters.`,
      action: "Bind fewer rate limiters in this Worker.",
      detail: `featureRatelimitNamespaceId: slot ${slot}`,
    });
  }
  // FNV-1a over the project and the slug: stable across runs and machines, so a branch keeps its namespace, and
  // its counters, across every re-provision.
  let hash = 0x811c9dc5;
  for (const char of `${identity.project}/${identity.slug}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const mix = String(hash % 100).padStart(2, "0");
  return `1${identity.issue.padStart(MAX_ISSUE_DIGITS, "0")}${mix}${slot}`;
}
