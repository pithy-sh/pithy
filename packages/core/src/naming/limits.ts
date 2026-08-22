// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { MAX_ENVIRONMENT_NAME } from "./environment";

/**
 * What Cloudflare will actually accept as a name, per namespace — and, where it publishes nothing,
 * what Pithy chooses instead.
 *
 * Pithy used to hold one number, 63, against every namespace it writes into, justified as "R2's
 * cap". That is true of R2 and of nothing else. It over-truncated a KV title by a factor of eight
 * and truncated D1 databases, Secrets Store entries, and API token labels against limits that do
 * not exist — `secrets-encryption-keys` came out of it as `secrets-encryp-91c2e9`, hashed for
 * nothing. A truncated name is not merely ugly: it is the name teardown must recompute exactly, and
 * the name a human has to recognize in a dashboard listing that cannot be filtered.
 *
 * Every row below carries its source. `cloudflare` means the number is documented (limits page,
 * OpenAPI schema, or wrangler's own constant, verified 2026-07-31); `pithy` means Cloudflare
 * publishes no cap and this is our ceiling, chosen and stated as ours.
 */

/** Where a limit comes from — Cloudflare's documentation, or Pithy's own judgment. */
export type LimitSource = "cloudflare" | "pithy";

/**
 * What to do with a name that will not fit.
 *
 * **`refuse`** where the name is a durable address: a Workflow (renaming orphans every running
 * instance), a Worker script (renaming orphans the deployment and every `service` binding pointing
 * at it), a Vectorize index (renaming orphans the vectors — they cannot be re-embedded for free).
 * A build error naming the limit is strictly better than a silent rename.
 *
 * **`truncate`** where Pithy recomputes the name from the same inputs on every command — a D1
 * database, a KV namespace, a bucket, a secret entry, a token. Truncation is deterministic and
 * hash-disambiguated, so provision and teardown still agree, and a failed CI run is avoided.
 */
export type OverflowPolicy = "refuse" | "truncate";

/** One namespace's rule: how long a name may be, and what happens when it would be longer. */
export interface NamespaceLimit {
  /** How an error message names this namespace, e.g. `an R2 bucket name`. */
  readonly label: string;
  /** The longest name the namespace accepts. Pithy composes ASCII only, so characters are bytes. */
  readonly maxLength: number;
  /** The shortest name the namespace accepts. Only R2 states one; everywhere else it is 1. */
  readonly minLength: number;
  /** What happens to a name that would exceed {@link maxLength}. */
  readonly policy: OverflowPolicy;
  /** Whether {@link maxLength} is Cloudflare's number or Pithy's. */
  readonly source: LimitSource;
}

/**
 * Pithy's ceiling for a namespace Cloudflare does not cap — D1 database names, Secrets Store
 * entries, API token labels.
 *
 * **This is our number, not Cloudflare's.** No published cap is not the same as no cap: a name is
 * read by humans in unfilterable listings, echoed in CLI output, and pasted into wrangler configs,
 * so it needs an end. 128 is twice the longest limit Cloudflare does publish (64) and roughly twice
 * the longest name Pithy can compose today, which leaves room for a capability with a long tail
 * without ever reaching for the truncator.
 */
export const MAX_PITHY_NAME = 128;

/**
 * The rule per namespace. Read it, do not re-derive it — a limit enforced in two places eventually
 * disagrees with itself, and the number an error quotes must be the number the check used.
 */
export const NAMESPACE_LIMITS = {
  /**
   * A Workflow name: 64 characters, `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. Documented on the Workflows
   * limits page, `maxLength: 64` in the OpenAPI schema, and `MAX_WORKFLOW_NAME_LENGTH` in wrangler.
   */
  workflow: { label: "a Workflow name", maxLength: 64, minLength: 1, policy: "refuse", source: "cloudflare" },
  /**
   * A Worker script name: 255 in general, **63 once workers.dev is on**, alphanumeric and dashes
   * with no leading or trailing dash. Pithy holds the 63: it is the only number that stays true
   * after an adopter enables a workers.dev subdomain, and a script cannot be renamed afterwards.
   * Deliberately one *less* than the Workflow cap — they are different resources with different
   * numbers, and collapsing them would loosen this one.
   */
  worker: { label: "a Worker script name", maxLength: 63, minLength: 1, policy: "refuse", source: "cloudflare" },
  /**
   * An R2 bucket: 3–63 characters, lowercase letters, digits and hyphens, and it must **start and
   * end alphanumeric**. The one namespace where 63 was always the right answer.
   */
  r2: { label: "an R2 bucket name", maxLength: 63, minLength: 3, policy: "truncate", source: "cloudflare" },
  /**
   * A Vectorize index: 64 bytes, `^([a-z]+[a-z0-9_-]*[a-z0-9]+)$` — it must start with a letter,
   * which the project rule already guarantees. Refused rather than truncated because a renamed
   * index is an empty index until everything is re-embedded.
   */
  vectorizeIndex: {
    label: "a Vectorize index name",
    maxLength: 64,
    minLength: 2,
    policy: "refuse",
    source: "cloudflare",
  },
  /**
   * A KV namespace title: 512 characters, no pattern at all — spaces and mixed case are accepted
   * (`workers-kv_namespace_title.maxLength` in the OpenAPI schema). Pithy still composes a kebab
   * title, for the same reason it composes every other name the same way; what changed is that it
   * no longer hashes one at 63.
   */
  kv: { label: "a KV namespace title", maxLength: 512, minLength: 1, policy: "truncate", source: "cloudflare" },
  /**
   * A D1 database name: `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` in the OpenAPI schema, and **no documented
   * length cap** — the limits page has no row for it. So the ceiling here is {@link MAX_PITHY_NAME}.
   */
  d1: { label: "a D1 database name", maxLength: MAX_PITHY_NAME, minLength: 1, policy: "truncate", source: "pithy" },
  /**
   * A Secrets Store entry name: "cannot contain spaces", wrangler enforces `/^[A-z0-9-_]+$/`, and
   * **no documented length cap**. Ours, therefore — {@link MAX_PITHY_NAME}.
   */
  secretEntry: {
    label: "a Secrets Store entry name",
    maxLength: MAX_PITHY_NAME,
    minLength: 1,
    policy: "truncate",
    source: "pithy",
  },
  /**
   * A Cloudflare API token name: a free-text label with **no documented cap**. Ours —
   * {@link MAX_PITHY_NAME} — and it matters least of all, since nothing addresses a token by name.
   */
  apiToken: {
    label: "a Cloudflare API token name",
    maxLength: MAX_PITHY_NAME,
    minLength: 1,
    policy: "truncate",
    source: "pithy",
  },
} as const satisfies Record<string, NamespaceLimit>;

/** Every namespace the naming facade can compose into. */
export type Namespace = keyof typeof NAMESPACE_LIMITS;

/**
 * The longest `<capability>-<job>` tail any capability registry declares today. Read off the
 * registries, not guessed: `media-audio-transcribe` and `media-video-transcribe` are both 22, ahead
 * of `payments-reconcile` (18), `vector-reprocess` (16), `support-classify` (16), `email-schedule`
 * (14), `secrets-rotate` (14), `storage-sweep` (13), `testers-daily` (13).
 *
 * {@link WORKFLOW_DERIVED_PROJECT_NAME} is derived against it, so the two move together — and
 * `workflowScriptName` refuses a longer tail rather than letting a new capability silently
 * invalidate the project-name cap every existing project was accepted under.
 */
export const MAX_CAPABILITY_JOB = "media-audio-transcribe".length;

/**
 * Digits a feature's issue number may carry. Six — `f999999`, just under a million open issues in one
 * repository, which nothing this toolkit will serve is going to exhaust.
 *
 * The count is not free: every digit reserved here costs one character of **every** adopter's project
 * name, because {@link FEATURE_DERIVED_PROJECT_NAME} is computed against it and a project name cannot
 * be changed once anything is provisioned. Seven digits would buy ten million issues nobody asked for
 * and charge every project a character for them.
 */
export const MAX_ISSUE_DIGITS = 6;

/**
 * The slug length a feature resource name keeps verbatim at the worst legal project name.
 *
 * Twelve, because that is where a feature slug stops being readable in a listing: below it,
 * `fitSegment` has to fall back to a short head plus a six-hex disambiguator, and
 * `acme-f95-medi-8f21c4-db-d1` tells a human nothing about which branch owns the database.
 */
export const MIN_LEGIBLE_SLUG = 12;

/**
 * The binding length a feature resource name keeps verbatim at the worst legal project name.
 *
 * Also twelve — `MEDIA_BUCKET`, `SESSIONS`, `CACHE`, `ASSETS`, `DB`, `ROOMS` all fit. It is
 * deliberately **not** the longest binding Pithy declares (`EMAIL_SUPPRESSIONS`, 18): reserving
 * that would cost every adopter six characters of project name to protect a purely cosmetic
 * property, since a longer binding truncates deterministically and stays unique through its hash,
 * and teardown recomputes the name rather than matching a prefix.
 */
export const MIN_VERBATIM_BINDING = 12;

/** The longest feature resource kind — `d1`, `kv`, `r2` are all two characters. `feature.test.ts` pins it. */
export const MAX_FEATURE_KIND = 2;

/**
 * What the longest Workflow name leaves a project.
 *
 * ```
 *     64   a Workflow name (NAMESPACE_LIMITS.workflow)
 *   -  1   the hyphen before the environment
 *   -  7   the longest environment, `staging` (MAX_ENVIRONMENT_NAME)
 *   -  1   the hyphen before the tail
 *   - 22   the longest <capability>-<job>, `media-audio-transcribe`
 *   ----
 *     33
 * ```
 */
export const WORKFLOW_DERIVED_PROJECT_NAME =
  NAMESPACE_LIMITS.workflow.maxLength - 1 - MAX_ENVIRONMENT_NAME - 1 - MAX_CAPABILITY_JOB;

/**
 * What the longest feature resource name leaves a project — `<project>-f<issue>-<slug>-<binding>-<kind>`,
 * against R2's 63 (the strictest of the three kinds a feature provisions, and the same number a
 * feature Worker script gets).
 *
 * ```
 *     63   an R2 bucket name (NAMESPACE_LIMITS.r2)
 *   -  2   `-f`
 *   -  6   the issue number, six digits — `f999999` (MAX_ISSUE_DIGITS)
 *   - 13   `-` + a legible slug (MIN_LEGIBLE_SLUG)
 *   - 13   `-` + a binding kept whole (MIN_VERBATIM_BINDING)
 *   -  3   `-` + the kind, `d1` | `kv` | `r2`
 *   ----
 *     26
 * ```
 */
export const FEATURE_DERIVED_PROJECT_NAME =
  NAMESPACE_LIMITS.r2.maxLength -
  2 -
  MAX_ISSUE_DIGITS -
  (1 + MIN_LEGIBLE_SLUG) -
  (1 + MIN_VERBATIM_BINDING) -
  (1 + MAX_FEATURE_KIND);
