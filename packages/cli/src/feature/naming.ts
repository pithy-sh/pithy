// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";

/** A Cloudflare resource kind `pithy feature` can name. */
export type FeatureResourceKind = "d1" | "kv" | "r2";

/** The identity of a feature — everything a resource name is derived from. */
export interface FeatureIdentity {
  /** The project name, from pithy.config (e.g. "acme"). */
  project: string;
  /** The issue number as a string (e.g. "69"). */
  issue: string;
  /** The kebab-case feature slug (e.g. "media-cli"). */
  slug: string;
}

/** The strictest CF resource name cap — R2 bucket names max out at 63 chars. */
export const MAX_RESOURCE_NAME = 63;

/** Below this the slug segment isn't worth keeping legible; the binding is truncated to give it room. */
const MIN_SLUG_BUDGET = 3;

/** Lowercase, hyphenate any run of non-`[a-z0-9]`, trim leading/trailing hyphens. */
function kebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** First 6 lowercase hex chars of the sha256 digest of `input`. */
function hash6(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 6);
}

/**
 * Fit a kebab segment into `budget` chars: verbatim when it fits, else a truncated head plus a short
 * stable hash so it stays unique and within budget. Deterministic in `(segment)` alone. The hash shrinks
 * for tiny budgets so the result never exceeds `budget` (and never trails a hyphen).
 */
function fitSegment(segment: string, budget: number): string {
  if (budget <= 0) return "";
  if (segment.length <= budget) return segment;
  if (budget < 4) return hash6(segment).slice(0, budget);
  const hashLen = Math.min(6, Math.max(2, budget - 2));
  const headLen = Math.max(1, budget - hashLen - 1);
  return `${segment.slice(0, headLen)}-${hash6(segment).slice(0, hashLen)}`;
}

/**
 * The environment-scoped Worker **script name** for one of the feature's workers:
 * `<project>-f<issue>-<slug>-<worker>`, capped like every other feature resource. This is the name the
 * feature's Workers deploy under, and therefore the name a sibling's `service` binding must target — so
 * worker-to-worker RPC in a feature environment reaches that feature's deployment rather than production's.
 * Deterministic in `(identity, worker)`, so CI computes the same name on every push without storing it.
 */
export function featureWorkerName(identity: FeatureIdentity, worker: string): string {
  const head = `${kebab(identity.project)}-f${identity.issue}`;
  const workerSegment = kebab(worker);
  const slugBudget = MAX_RESOURCE_NAME - head.length - 1 - (1 + workerSegment.length);
  const slug = fitSegment(kebab(identity.slug), Math.max(1, slugBudget));
  return `${head}-${slug}-${workerSegment}`;
}

/**
 * The full Cloudflare resource name for a feature's binding: `<project>-f<issue>-<slug>-<binding>-<kind>`,
 * all lowercase-hyphenated (valid for R2's strict bucket rules). Guaranteed **≤ {@link MAX_RESOURCE_NAME}**:
 * the slug is truncated (with a stable hash) against the space the *actual* binding+kind suffix leaves — not
 * a fixed reserve — and, if a long binding would still overrun, the binding is truncated too so the slug
 * keeps a minimum. Deterministic in `(identity, binding, kind)`, so `provision` and `destroy` compute the
 * exact same name — that identity is what teardown reconciles against (it recomputes each expected name
 * rather than scanning a prefix, which a hyphenated sibling slug could ambiguously match). Assumes a
 * short project name, as project identifiers are; an extreme one is the caller's to keep sane.
 */
export function featureResourceName(identity: FeatureIdentity, binding: string, kind: FeatureResourceKind): string {
  const head = `${kebab(identity.project)}-f${identity.issue}`;
  let bindingSegment = kebab(binding);
  let suffixLen = 1 + bindingSegment.length + 1 + kind.length; // `-<binding>-<kind>`
  let slugBudget = MAX_RESOURCE_NAME - head.length - 1 - suffixLen;

  if (slugBudget < MIN_SLUG_BUDGET) {
    // A long binding is eating the name — truncate it too, reserving the slug its minimum.
    const bindingBudget = MAX_RESOURCE_NAME - head.length - 1 - MIN_SLUG_BUDGET - 1 - kind.length - 1;
    bindingSegment = fitSegment(bindingSegment, Math.max(1, bindingBudget));
    suffixLen = 1 + bindingSegment.length + 1 + kind.length;
    slugBudget = MAX_RESOURCE_NAME - head.length - 1 - suffixLen;
  }

  const slug = fitSegment(kebab(identity.slug), Math.max(1, slugBudget));
  return `${head}-${slug}-${bindingSegment}-${kind}`;
}
