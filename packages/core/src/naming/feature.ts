// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "../error/pithyError";
import { featureMarker, isFeatureMarker } from "./environment";
import { FEATURE_TAIL_SEPARATOR, MAX_ISSUE_DIGITS, NAMESPACE_LIMITS } from "./limits";
import { assertValidProjectName, fitSegment, kebab } from "./resource";

/**
 * The names a feature environment provisions under: `<project>-f<issue>-<slug>--<binding>-<kind>` for a
 * resource, `<project>-f<issue>-<slug>--<worker>` for a Worker script.
 *
 * **Two hyphens after the slug, and a project with no `f<digits>` segment (#643).** Together they make every
 * feature name parse back to exactly one (project, issue, slug): the double hyphen is something no other name
 * Pithy composes can hold ({@link FEATURE_TAIL_SEPARATOR}), and the first `f<digits>` segment is the issue's,
 * because the project may carry none ({@link assertFeatureProject}). Before them, project `acme-f12-x`'s `prod`
 * and project `acme`'s branch `feature/12-x-prod` composed every name between them, and a branch whose slug
 * was a hyphen-prefix of a sibling's could compose the sibling's database. See {@link parseFeatureName}.
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

/**
 * **The issue as a name carries it: its digits, without leading zeros (#643).** `feature/0643-foo` and
 * `feature/643-foo` are one issue, so they are one feature and compose one set of names. Read as strings they
 * were two features, and their rate-limit namespaces collided every time. `0` stays `0`.
 */
export function canonicalIssue(issue: string): string {
  assertIssue(issue);
  return issue.replace(/^0+(?=[0-9])/, "");
}

/**
 * The `f<digits>` segment a project name carries, or `null` — the shape a feature's issue takes (#643).
 *
 * Read after kebabbing, because the kebab is what reaches an account.
 */
export function featureMarkerInProjectName(project: string): string | null {
  return kebab(project).split("-").find(isFeatureMarker) ?? null;
}

/**
 * **Refuse features for a project whose name carries an `f<digits>` segment (#643).**
 *
 * A feature name is read left to right: the project, then the first `f<digits>` segment, which is the issue.
 * A project named `acme-f12-x` puts that segment inside itself, and then its feature 3 on `y` and project `acme`'s
 * feature 12 on `x-f3-y` are one string. Environment names already obey this rule ({@link isFeatureMarker}), so
 * the project obeys it too, where the two shapes meet.
 *
 * **Refused here, not at `requireProjectName`.** Such a project's staging and prod are untouched: no name they
 * compose holds {@link FEATURE_TAIL_SEPARATOR}, so no feature anywhere can compose one of theirs. Refusing the
 * name everywhere would break every command of a project that is otherwise sound. `pithy init` refuses a new one,
 * and `pithy doctor` names the segment an existing one carries. Nothing is renamed.
 */
export function assertFeatureProject(project: string): void {
  const marker = featureMarkerInProjectName(project);
  if (marker === null) return;
  throw new ValidationError({
    message: `"${project}" can't have feature environments. Its name carries ${marker}, the shape a feature's issue takes.`,
    action: "Staging and prod are unaffected. Features need a project name with no f and a number as one segment.",
    detail: `A feature name is <project>-f<issue>-<slug>--<thing>, read from the first f<digits> segment. With one inside "${kebab(project)}", another project's feature could compose this project's feature names.`,
  });
}

/** The `<project>-f<issue>` head both feature shapes share, with the project held to the one project rule. */
function head(identity: FeatureIdentity): string {
  assertValidProjectName(identity.project);
  assertFeatureProject(identity.project);
  return `${kebab(identity.project)}-${featureMarker(canonicalIssue(identity.issue))}`;
}

/** A feature name, read back: which project, issue and slug it belongs to, and what it names. */
export interface ParsedFeatureName {
  /** The project segment, kebabbed. */
  project: string;
  /** The issue, canonical. */
  issue: string;
  /** The slug segment as it stands in the name: the whole slug, or its fitted form when it was truncated. */
  slug: string;
  /** Everything after {@link FEATURE_TAIL_SEPARATOR}: the binding and kind, Worker, Workflow or entry. */
  thing: string;
}

/**
 * **Read a feature name back into its owner, or `null` when it is not one (#643).**
 *
 * Exact, because the shape leaves one reading: a feature name holds {@link FEATURE_TAIL_SEPARATOR} exactly once,
 * everything before it is `<project>-f<issue>-<slug>`, and the first `f<digits>` segment there is the issue,
 * since a project may carry none. Nothing else Pithy composes holds the separator at all.
 */
export function parseFeatureName(name: string): ParsedFeatureName | null {
  const at = name.indexOf(FEATURE_TAIL_SEPARATOR);
  if (at < 0 || name.indexOf(FEATURE_TAIL_SEPARATOR, at + 1) >= 0) return null;
  const thing = name.slice(at + FEATURE_TAIL_SEPARATOR.length);
  const segments = name.slice(0, at).split("-");
  const marker = segments.findIndex(isFeatureMarker);
  if (thing === "" || marker < 1 || marker === segments.length - 1) return null;
  if (segments.some((segment) => segment === "")) return null;
  return {
    project: segments.slice(0, marker).join("-"),
    issue: (segments[marker] as string).slice(1).replace(/^0+(?=[0-9])/, ""),
    slug: segments.slice(marker + 1).join("-"),
    thing,
  };
}

/**
 * **Is this name one this feature composes?** The ownership check the isolation gates ask (#643).
 *
 * Parsed, never prefix-matched. `<project>-f<issue>-` is shared by every branch of one issue, and a slug that is
 * a hyphen-prefix of a sibling's (`feature-address` of `feature-address-2`) matched the sibling's names too. The
 * slug segment must be the feature's slug, or a fitted form of it, which is what a truncated name carries.
 */
export function isFeatureOwnedName(identity: FeatureIdentity, name: string): boolean {
  const parsed = parseFeatureName(name);
  if (parsed === null) return false;
  if (parsed.project !== kebab(identity.project) || parsed.issue !== canonicalIssue(identity.issue)) return false;
  const slug = kebab(identity.slug);
  if (parsed.slug === slug) return true;
  for (let budget = 1; budget < slug.length; budget += 1) {
    if (fitSegment(slug, budget) === parsed.slug) return true;
  }
  return false;
}

/**
 * Fit `<head>-<slug>--<tail><fixed>` into `budget`, truncating the slug first and the tail only if the
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
  const separator = FEATURE_TAIL_SEPARATOR.length;
  let tailSegment = tail;
  let slugBudget = inner - headSegment.length - 1 - (separator + tailSegment.length);

  if (slugBudget < MIN_SLUG_BUDGET) {
    // The tail is eating the name — truncate it too, reserving the slug its minimum.
    const tailBudget = inner - headSegment.length - 1 - MIN_SLUG_BUDGET - separator;
    tailSegment = fitSegment(tailSegment, Math.max(1, tailBudget));
    slugBudget = inner - headSegment.length - 1 - (separator + tailSegment.length);
  }

  return `${headSegment}-${fitSegment(slug, Math.max(1, slugBudget))}${FEATURE_TAIL_SEPARATOR}${tailSegment}${fixed}`;
}

/**
 * The full Cloudflare resource name for a feature's binding — `<project>-f<issue>-<slug>--<binding>-<kind>`.
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
 * `<project>-f<issue>-<slug>--<secret>`.
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
 * The Worker **script name** for one of a feature's workers — `<project>-f<issue>-<slug>--<worker>`.
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
 * `<project>-<app>`, and handing that here composed `<project>-f<issue>-<slug>--<project>-<app>` — the
 * project twice, spent out of the budget above (#587). This function takes a string and cannot tell the
 * two apart, so the provisioning path reaches it only through `featureScope`, which is handed both names
 * and picks.
 */
export function featureWorkerName(identity: FeatureIdentity, app: string): string {
  return composeFeatureName(head(identity), kebab(identity.slug), kebab(app), "", NAMESPACE_LIMITS.worker.maxLength);
}

/**
 * The deployed name of one of a feature's **Workflows** — `<project>-f<issue>-<slug>--<capability>-<job>` (#643).
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
 * The name of one of a feature's **Vectorize indexes** — `<project>-f<issue>-<slug>--<thing>` (#643).
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
