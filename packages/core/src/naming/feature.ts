// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "../error/pithyError";
import { featureMarker, isFeatureMarker } from "./environment";
import { FEATURE_TAIL_SEPARATOR, MAX_ISSUE_DIGITS, NAMESPACE_LIMITS } from "./limits";
import { assertValidProjectName, kebab, ownedThing } from "./resource";

/**
 * The names a feature environment provisions under: `<project>-f<issue>-<slug>--<binding>-<kind>` for a
 * resource, `<project>-f<issue>-<slug>--<owner>---<binding>-<kind>` for a resource one Worker owns, and
 * `<project>-f<issue>-<slug>--<worker>` for a Worker script.
 *
 * **Two hyphens after the slug, and a project with no `f<digits>` segment.** Together they make every feature
 * name parse back to exactly one (project, issue, slug): the first double hyphen ends the slug, and no name a
 * declared environment composes holds one that is not followed by a third ({@link FEATURE_TAIL_SEPARATOR}), and
 * the first `f<digits>` segment is the issue's, because the project may carry none ({@link assertFeatureProject}).
 * Without them, project `acme-f12-x`'s `prod` and project `acme`'s branch `feature/12-x-prod` would compose names
 * in common, and a branch whose slug is a hyphen-prefix of a sibling's could compose the sibling's database. See
 * {@link parseFeatureName}.
 *
 * **No environment segment, and a Worker segment only for an owned binding.** A feature *is* an environment, and
 * two Workers that declare the same binding share one resource unless one lists it in `ownBindings`.
 *
 * Every name here is **derived and recomputed**, never stored: `provision` and `destroy` both compute the
 * same string from `(identity, binding, kind)`, which is what lets teardown reconcile exactly rather than
 * scan a prefix a hyphenated sibling slug could ambiguously match.
 *
 * **Never truncated.** A short hash is a slug some sibling branch can have whole, so a fitted name would be a name
 * two features could compose. A slug that does not fit is refused, naming the maximum
 * ({@link assertFeatureSlugFits}), and every feature name is exactly its feature's.
 *
 * It lives in `core`, beside the rest of the naming rule, so the CLI and the facade compose one
 * implementation rather than two that drift.
 */

/** A Cloudflare resource kind Pithy names and creates — in a feature, and in every declared environment. */
export type FeatureResourceKind = "d1" | "kv" | "r2" | "queue";

/** Every feature resource kind, for tests and for callers that enumerate. */
export const FEATURE_RESOURCE_KINDS: readonly FeatureResourceKind[] = ["d1", "kv", "r2", "queue"];

/**
 * **The segment each kind ends a feature resource's name with — never more than `MAX_FEATURE_KIND`.**
 *
 * `d1`, `kv` and `r2` spell themselves. A queue is `q`, and that is load-bearing: `MAX_FEATURE_KIND` is a term in
 * `FEATURE_DERIVED_PROJECT_NAME`, so spelling it `queue` would take the project budget from 26 to 23 — and a
 * project name is stable forever once anything is provisioned, so a smaller budget orphans every resource of a
 * project already named against the old one. `feature.test.ts` fails on a segment longer than the budget.
 */
export const FEATURE_KIND_SEGMENT: Readonly<Record<FeatureResourceKind, string>> = {
  d1: "d1",
  kv: "kv",
  r2: "r2",
  queue: "q",
};

/** The identity of a feature — everything a feature name is derived from. */
export interface FeatureIdentity {
  /** The project name, from the root `pithy.config.ts` (e.g. `acme`). */
  project: string;
  /** The issue number as a string (e.g. `69`). Digits only, up to {@link MAX_ISSUE_DIGITS}. */
  issue: string;
  /** The kebab-case feature slug, from the branch (e.g. `media-cli`). */
  slug: string;
}

/**
 * Refuse an issue number the budgets were not derived against.
 *
 * `MAX_ISSUE_DIGITS` is a term in {@link FEATURE_DERIVED_PROJECT_NAME}, so an eight-digit issue would
 * quietly spend a character every project name was already accepted against. It is also the cheapest
 * possible check that the value is an issue number at all, before it is interpolated into a Cloudflare name.
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
 * **The issue as a name carries it: its digits, without leading zeros.** `feature/0643-foo` and
 * `feature/643-foo` are one issue, so they are one feature and compose one set of names. `0` stays `0`.
 */
export function canonicalIssue(issue: string): string {
  assertIssue(issue);
  return issue.replace(/^0+(?=[0-9])/, "");
}

/**
 * The `f<digits>` segment a project name carries, or `null` — the shape a feature's issue takes.
 *
 * Read after kebabbing, because the kebab is what reaches an account.
 */
export function featureMarkerInProjectName(project: string): string | null {
  return kebab(project).split("-").find(isFeatureMarker) ?? null;
}

/**
 * **Refuse features for a project whose name carries an `f<digits>` segment.**
 *
 * A feature name is read left to right: the project, then the first `f<digits>` segment, which is the issue.
 * A project named `acme-f12-x` puts that segment inside itself, and then its feature 3 on `y` and project `acme`'s
 * feature 12 on `x-f3-y` are one string. Environment names already obey this rule ({@link isFeatureMarker}), so
 * the project obeys it too, where the two shapes meet.
 *
 * **Refused here, not at `requireProjectName`.** Such a project's staging and prod are untouched: no name they
 * compose parses as a feature name ({@link parseFeatureName}), so no feature anywhere can compose one of theirs. Refusing the
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
function head(identity: FeatureHead): string {
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
  /** The slug segment: the whole slug, since no feature name is truncated. */
  slug: string;
  /** Everything after {@link FEATURE_TAIL_SEPARATOR}: the binding and kind, Worker, Workflow or entry. */
  thing: string;
}

/**
 * **Read a feature name back into its owner, or `null` when it is not one.**
 *
 * Exact, because the shape leaves one reading: a feature name splits at its first {@link FEATURE_TAIL_SEPARATOR},
 * everything before it is `<project>-f<issue>-<slug>`, and the first `f<digits>` segment there is the issue, since
 * a project may carry none. The thing after it may hold an owned binding's `---`, and **never starts with a
 * hyphen**: the first `--` of every name a declared environment composes is the start of an owned `---`, so a thing
 * starting with `-` is refused, and no environment's name reads as a feature's.
 */
export function parseFeatureName(name: string): ParsedFeatureName | null {
  const at = name.indexOf(FEATURE_TAIL_SEPARATOR);
  if (at < 0) return null;
  const thing = name.slice(at + FEATURE_TAIL_SEPARATOR.length);
  const segments = name.slice(0, at).split("-");
  const marker = segments.findIndex(isFeatureMarker);
  if (thing === "" || thing.startsWith("-") || marker < 1 || marker === segments.length - 1) return null;
  if (segments.some((segment) => segment === "")) return null;
  return {
    project: segments.slice(0, marker).join("-"),
    issue: (segments[marker] as string).slice(1).replace(/^0+(?=[0-9])/, ""),
    slug: segments.slice(marker + 1).join("-"),
    thing,
  };
}

/**
 * **Is this name one this feature composes?** The ownership check the isolation gates ask.
 *
 * Parsed, never prefix-matched, and exact: the name's project, issue and slug are this feature's, character for
 * character. `<project>-f<issue>-` is shared by every branch of one issue, so a prefix match would reach siblings,
 * and no feature name is fitted ({@link composeFeatureName}), so there is nothing but the slug itself to accept.
 */
export function isFeatureOwnedName(identity: FeatureIdentity, name: string): boolean {
  const parsed = parseFeatureName(name);
  if (parsed === null) return false;
  return (
    parsed.project === kebab(identity.project) &&
    parsed.issue === canonicalIssue(identity.issue) &&
    parsed.slug === kebab(identity.slug)
  );
}

/** A feature's project and issue: everything its names are derived from but the slug. */
export type FeatureHead = Pick<FeatureIdentity, "project" | "issue">;

/**
 * **The longest slug one feature name leaves room for** — `limit` less `<project>-f<issue>-`, the
 * {@link FEATURE_TAIL_SEPARATOR}, and `thing`, which is everything after it. Zero or less when `thing` leaves none.
 */
export function featureSlugRoom(parts: FeatureHead, thing: string, limit: number): number {
  return limit - head(parts).length - 1 - FEATURE_TAIL_SEPARATOR.length - thing.length;
}

/**
 * Compose `<head>-<slug>--<tail><fixed>` whole, or refuse.
 *
 * **Never truncated.** A fitted slug is a short hash, and a hash is a slug some sibling branch can have whole, so
 * `feature/12-login` would own `feature/12-c`'s names. A name that does not fit is refused, naming the longest
 * slug that does, and
 * `pithy feature create` and `pithy provision --feature` refuse the branch before anything exists
 * ({@link assertFeatureSlugFits}). This is the backstop behind them: no path composes a feature name that is not
 * exactly its feature's.
 */
function composeFeatureName(
  parts: FeatureHead,
  slug: string,
  tail: string,
  fixed: string,
  limit: number,
  label: string,
): string {
  const headSegment = head(parts);
  for (const [role, value] of [
    ["slug", slug],
    ["binding or worker", tail],
  ] as const) {
    if (value) continue;
    // An empty segment would compose `acme-f69--db-d1`, or a name ending in a dash: neither is a legal bucket or
    // script name.
    throw new ValidationError({
      message: `A feature resource name needs a ${role}.`,
      action: "Use letters, digits, and hyphens — something that survives kebabbing.",
      detail: `composeFeatureName received an empty ${role} segment for "${headSegment}".`,
    });
  }

  const thing = `${tail}${fixed}`;
  const room = featureSlugRoom(parts, thing, limit);
  if (room < 1) {
    throw new ValidationError({
      message: `"${thing}" is too long for a feature's ${label.replace(/^an? /, "")}.`,
      action: `Shorten it. ${label[0]?.toUpperCase()}${label.slice(1)} stops at ${limit}, and ${headSegment}-<slug>-- comes first.`,
      detail: `${headSegment}-<slug>--${thing} leaves ${room} characters for a slug.`,
    });
  }
  if (slug.length > room) {
    throw new ValidationError({
      message: `Slug "${slug}" is ${slug.length} characters. ${label[0]?.toUpperCase()}${label.slice(1)} ${headSegment}-<slug>--${thing} leaves room for at most ${room}.`,
      action: "Use a shorter branch slug.",
      detail: `${headSegment}-${slug}--${thing} is ${headSegment.length + 1 + slug.length + FEATURE_TAIL_SEPARATOR.length + thing.length} characters; the limit is ${limit}. Feature names are never truncated.`,
    });
  }
  return `${headSegment}-${slug}${FEATURE_TAIL_SEPARATOR}${thing}`;
}

/** One kind of name a feature composes, as far as its slug budget reads it. */
export interface FeatureNameShape {
  /** How an error names the namespace, e.g. `a Workflow name`. */
  label: string;
  /** The longest name the namespace takes. */
  limit: number;
  /** Everything after {@link FEATURE_TAIL_SEPARATOR}, e.g. `email-suppressions-d1`. */
  thing: string;
}

/** The longest slug every one of `shapes` leaves room for, for this project and issue, and the shape that sets it. */
export function tightestFeatureShape(
  parts: FeatureHead,
  shapes: readonly FeatureNameShape[],
): { max: number; shape: FeatureNameShape | null } {
  let max = Number.POSITIVE_INFINITY;
  let shape: FeatureNameShape | null = null;
  for (const candidate of shapes) {
    const room = featureSlugRoom(parts, candidate.thing, candidate.limit);
    if (room < max) {
      max = room;
      shape = candidate;
    }
  }
  return { max, shape };
}

/** The longest slug a feature of this project and issue may have, across every name it composes. */
export function maxFeatureSlug(parts: FeatureHead, shapes: readonly FeatureNameShape[]): number {
  return tightestFeatureShape(parts, shapes).max;
}

/**
 * **Refuse a branch whose slug cannot fit every name its feature composes.** The one refusal
 * `pithy feature create` and `pithy provision --feature` make, before a worktree or a resource exists, with the
 * project's maximum in the message. {@link composeFeatureName} refuses the same slug one name at a time; this says
 * it once, for all of them.
 */
export function assertFeatureSlugFits(identity: FeatureIdentity, shapes: readonly FeatureNameShape[]): void {
  const { max, shape } = tightestFeatureShape(identity, shapes);
  const slug = kebab(identity.slug);
  if (shape === null || slug.length <= max) return;
  const issue = canonicalIssue(identity.issue);
  const project = kebab(identity.project);
  if (max < 1) {
    throw new ValidationError({
      message: `"${shape.thing}" leaves no room for a slug in ${project}'s features.`,
      action: `Shorten it. ${shape.label[0]?.toUpperCase()}${shape.label.slice(1)} stops at ${shape.limit}.`,
      detail: `${head(identity)}-<slug>--${shape.thing} leaves ${max} characters for a slug.`,
    });
  }
  throw new ValidationError({
    message: `Slug "${slug}" is ${slug.length} characters. Feature slugs in ${project} stop at ${max} characters at issue ${issue}.`,
    action: `Name the branch feature/${issue}-<slug of ${max} or fewer>. Feature names are never truncated.`,
    detail: `${shape.label} ${head(identity)}-<slug>--${shape.thing} is held to ${shape.limit} characters.`,
  });
}

/**
 * The full Cloudflare resource name for a feature's binding — `<project>-f<issue>-<slug>--<binding>-<kind>`, the
 * kind spelled by {@link FEATURE_KIND_SEGMENT}. With an `owner`, the `apps/<owner>` Worker that lists the binding in
 * `ownBindings`, it is `<project>-f<issue>-<slug>--<owner>---<binding>-<kind>`.
 *
 * Held to **R2's 63**, the strictest of the kinds a feature provisions and a queue's number too, so one shape is
 * legal for all of them: lowercase, hyphenated, alphanumeric at both ends. A D1 or KV name could be longer, but a
 * feature that provisions a bucket and a database wants them recognizably the same name.
 */
export function featureResourceName(
  identity: FeatureIdentity,
  binding: string,
  kind: FeatureResourceKind,
  owner?: string,
): string {
  return composeFeatureName(
    identity,
    kebab(identity.slug),
    owner === undefined ? kebab(binding) : ownedThing(owner, binding),
    `-${FEATURE_KIND_SEGMENT[kind]}`,
    NAMESPACE_LIMITS.r2.maxLength,
    NAMESPACE_LIMITS.r2.label,
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
 * A `global` secret is named here too: a feature shares nothing with any other environment, so its entry for a
 * global secret is its own rather than the project's `<project>-global-<secret>`.
 */
export function featureSecretEntryName(identity: FeatureIdentity, secret: string): string {
  return composeFeatureName(
    identity,
    kebab(identity.slug),
    kebab(secret),
    "",
    NAMESPACE_LIMITS.secretEntry.maxLength,
    NAMESPACE_LIMITS.secretEntry.label,
  );
}

/**
 * The Worker **script name** for one of a feature's workers — `<project>-f<issue>-<slug>--<worker>`.
 *
 * This is the name the feature's Workers deploy under, and therefore the name a sibling's `service`
 * binding must target, so RPC inside a feature environment reaches that feature's deployment rather than
 * production's.
 *
 * Held to the **Worker rule** ({@link NAMESPACE_LIMITS.worker}). `apps/<name>` has a charset rule and no length
 * rule, so nothing upstream bounds the worker segment.
 *
 * **`app` is the `apps/<app>` directory, never the deploy name.** A scaffolded Worker deploys as
 * `<project>-<app>`, and handing that here composed `<project>-f<issue>-<slug>--<project>-<app>` — the
 * project twice, spent out of the budget above. This function takes a string and cannot tell the
 * two apart, so the provisioning path reaches it only through `featureScope`, which is handed both names
 * and picks.
 */
export function featureWorkerName(identity: FeatureIdentity, app: string): string {
  return composeFeatureName(
    identity,
    kebab(identity.slug),
    kebab(app),
    "",
    NAMESPACE_LIMITS.worker.maxLength,
    NAMESPACE_LIMITS.worker.label,
  );
}

/** The `<thing>` a feature's Artifacts namespace ends with, after {@link FEATURE_TAIL_SEPARATOR}. */
export const FEATURE_ARTIFACTS_THING = "artifacts";

/**
 * A feature's **Artifacts namespace** — `<project>-f<issue>-<slug>--artifacts`.
 *
 * A declared environment's namespace is `<project>-<env>` and has no `<thing>`. A feature's needs one, because the
 * separator and what follows it are what make a name a feature name: {@link isFeatureOwnedName} reads this one back
 * as this feature's, so `pithy feature destroy` reaps the repos of exactly this branch and of no sibling. Held to the
 * namespace's 63, the same number the rest of a feature's names are derived against, and `artifacts` is shorter than
 * the shortest binding tail, so it moves no slug budget.
 */
export function featureArtifactsNamespace(identity: FeatureIdentity): string {
  return composeFeatureName(
    identity,
    kebab(identity.slug),
    FEATURE_ARTIFACTS_THING,
    "",
    NAMESPACE_LIMITS.artifactsNamespace.maxLength,
    NAMESPACE_LIMITS.artifactsNamespace.label,
  );
}

/**
 * The deployed name of one of a feature's **Workflows** — `<project>-f<issue>-<slug>--<capability>-<job>`.
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
    identity,
    kebab(identity.slug),
    `${kebab(capability)}-${kebab(job)}`,
    "",
    NAMESPACE_LIMITS.workflow.maxLength,
    NAMESPACE_LIMITS.workflow.label,
  );
}

/**
 * The name of one of a feature's **Vectorize indexes** — `<project>-f<issue>-<slug>--<thing>`.
 *
 * An index name is account-wide, so a feature's vector host cannot bind `<project>-feature-vector-<index>`: every
 * open branch would read and write one index. Held to the Vectorize limit and fitted the way every feature name
 * is, so teardown recomputes it from the identity.
 */
export function featureVectorizeIndexName(identity: FeatureIdentity, thing: string): string {
  return composeFeatureName(
    identity,
    kebab(identity.slug),
    kebab(thing),
    "",
    NAMESPACE_LIMITS.vectorizeIndex.maxLength,
    NAMESPACE_LIMITS.vectorizeIndex.label,
  );
}
