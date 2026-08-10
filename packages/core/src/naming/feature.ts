// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "../error/pithyError";
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
  return `${kebab(identity.project)}-f${identity.issue}`;
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
 * feature that provisions a bucket and a database wants them recognisably the same name.
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
 * A `global` secret is not named here at all: it is one account-level value every environment binds,
 * so a feature binds the project's `<project>-global-<secret>` rather than minting a second copy.
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
 */
export function featureWorkerName(identity: FeatureIdentity, worker: string): string {
  return composeFeatureName(head(identity), kebab(identity.slug), kebab(worker), "", NAMESPACE_LIMITS.worker.maxLength);
}
