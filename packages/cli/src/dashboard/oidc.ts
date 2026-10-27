// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { OidcClaimMatch, OidcClaimName, OidcClaimValue } from "@pithy-sh/core/src/controlPlane/data/oidcTrust";
import { UpstreamError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { OidcJwks, type OidcJwksFetch, oidcJwksFetch } from "@pithy-sh/core/src/http/oidcWebhook";
import { z } from "zod";

/**
 * Registering an OIDC trust from the CLI (#722, `docs/AGENT-ACCESS.md` §6.2.1): the issuer profiles, the claim
 * flags, the immutable-identifier advice, and the one check that can be made at registration.
 *
 * ## Profiles inform a prompt; they refuse one thing only
 *
 * A profile is a provider's claim vocabulary — which claims its tokens carry, which are the recommended
 * constraint, an example of each — so a recognized issuer becomes a prompt over real choices instead of a
 * string somebody composes from documentation. **A claim is never refused for being one the profile has not heard
 * of.** GitHub's subject template is customizable per organization and repository, so a kit that validated claim
 * names against its own table would eventually refuse a legitimate token with a refusal nobody could argue with.
 *
 * The one thing a profile does refuse is a matcher that names no workload ({@link requireWorkloadIdentity}). A
 * profiled issuer is a shared one — GitHub signs for every repository with the same keys — so a trust matching only
 * `environment=prod` or `ref=refs/heads/main` admits anybody who creates a repository with that environment or
 * branch. That is the unconstrained subject the registration refuses, said with more claims. A custom issuer is a
 * first-class answer: the shape of what it is given is validated, and nothing about whether the provider will send
 * it, because nothing here knows which of its claims name a workload.
 *
 * ## Profiles are written, not fetched
 *
 * A discovery document publishes endpoints and claim *names*, never the value a claim will carry, so there is
 * nothing to read. What discovery *can* answer is whether the issuer is real and its keys parse, and that is the
 * one thing {@link resolveIssuer} checks.
 */

/** One claim in a profile: what it is called, an example of its value, and why it is worth matching. */
export interface ProfileClaim {
  /** The claim name, as the token carries it. */
  claim: string;
  /** An example value, so a prompt shows what kind of thing to type. */
  example: string;
  /** One line on what it pins. */
  hint: string;
}

/** A known issuer's claim vocabulary. */
export interface IssuerProfile {
  /** The provider, as a person names it. */
  name: string;
  /** The exact `iss` its tokens carry. */
  issuer: string;
  /** The claims to match on, in the order a prompt asks for them. The first is the one that matters most. */
  recommended: readonly ProfileClaim[];
  /** Other claims its tokens carry, offered but not asked for. */
  available: readonly string[];
  /**
   * The claims that say whose workload a token is — a repository, a project, its owner, or a subject that embeds
   * one. A matcher for this issuer must name at least one; every other claim describes the job, which anybody the
   * issuer serves can reproduce.
   */
  identifying: readonly string[];
}

/** The two issuers profiled to start with. Anything else is custom, and says so. */
export const ISSUER_PROFILES: readonly IssuerProfile[] = [
  {
    name: "GitHub Actions",
    issuer: "https://token.actions.githubusercontent.com",
    recommended: [
      {
        claim: "repository_id",
        example: "1262274726",
        hint: "The repository's numeric id. Survives a rename, and cannot be claimed by a same-named repository.",
      },
      {
        claim: "environment",
        example: "prod",
        hint: "The deployment environment the job runs in. Leave empty to match on ref instead.",
      },
      { claim: "ref", example: "refs/heads/main", hint: "The branch or tag the job runs on." },
    ],
    available: [
      "repository_owner_id",
      "actor_id",
      "ref_type",
      "workflow_ref",
      "job_workflow_ref",
      "event_name",
      "runner_environment",
      "sub",
    ],
    identifying: [
      "repository_id",
      "repository",
      "repository_owner_id",
      "repository_owner",
      "sub",
      "workflow_ref",
      "job_workflow_ref",
    ],
  },
  {
    name: "GitLab CI",
    issuer: "https://gitlab.com",
    recommended: [
      {
        claim: "project_id",
        example: "42",
        hint: "The project's numeric id. Survives a rename, and cannot be claimed by a same-named project.",
      },
      { claim: "ref", example: "main", hint: "The branch or tag the job runs on." },
      { claim: "ref_type", example: "branch", hint: "Whether ref names a branch or a tag." },
    ],
    available: ["namespace_id", "ref_protected", "environment", "sub"],
    identifying: ["project_id", "project_path", "namespace_id", "namespace_path", "sub"],
  },
];

/** The profile for an issuer, or undefined for a custom one. Compared exactly: an issuer is a string, not a host. */
export function profileFor(issuer: string): IssuerProfile | undefined {
  return ISSUER_PROFILES.find((profile) => profile.issuer === issuer);
}

/**
 * Name-based claims and the immutable id each one should be, across the profiled providers.
 *
 * A numeric id survives a rename and cannot be claimed by somebody creating a same-named project elsewhere — the
 * reason GitHub introduced an immutable subject form at all. A name is still accepted; the trade is stated once.
 */
const IMMUTABLE_FOR: Readonly<Record<string, string>> = {
  repository: "repository_id",
  repository_owner: "repository_owner_id",
  actor: "actor_id",
  project_path: "project_id",
  namespace_path: "namespace_id",
};

/** The sentence a registration prints for each name-based claim it matches on, or none. */
export function nameBasedNotes(claims: Readonly<Record<string, string>>): string[] {
  return Object.keys(claims)
    .filter((claim) => IMMUTABLE_FOR[claim] !== undefined)
    .map(
      (claim) =>
        `${claim} is a name. ${IMMUTABLE_FOR[claim]} survives a rename and cannot be claimed by a same-named project elsewhere; prefer it.`,
    );
}

/**
 * Read every `--oidc-claim key=value` into one matcher, refusing what core's {@link OidcClaimMatch} refuses.
 *
 * Split on the first `=`, so a value may itself carry one. The same claim twice with the same value is the same
 * constraint said twice; with two values it is a contradiction, and refused rather than resolved.
 */
export function parseOidcClaims(raw: readonly string[]): Record<string, string> {
  const claims: Record<string, string> = {};
  for (const pair of raw) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      throw new ValidationError({
        message: `--oidc-claim takes name=value, not ${pair === "" ? "nothing" : pair}.`,
        action: "Pass --oidc-claim repository_id=1262274726, once per claim.",
      });
    }
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    const prior = claims[name];
    if (prior !== undefined && prior !== value) {
      throw new ValidationError({
        message: `--oidc-claim names ${name} twice, with two values.`,
        action: `A token carries one ${name}. Pass it once.`,
      });
    }
    claims[name] = value;
  }
  return requireSubjectConstraint(claims);
}

/**
 * A matcher, validated: at least one claim, every name and value well formed. The refusal names why, because the
 * empty case is not a typo — it is a trust that accepts every workload its issuer serves.
 */
export function requireSubjectConstraint(claims: Record<string, string>): Record<string, string> {
  // Each pair first, so the refusal names the claim at fault in core's words rather than a record's.
  for (const [name, value] of Object.entries(claims)) {
    const named = OidcClaimName.safeParse(name);
    const valued = OidcClaimValue.safeParse(value);
    const issue = named.error?.issues[0] ?? valued.error?.issues[0];
    if (issue) {
      throw new ValidationError({
        message: `--oidc-claim ${name}: ${issue.message}`,
        action: "Pass --oidc-claim name=value, naming a claim the workload's token carries.",
      });
    }
  }
  const parsed = OidcClaimMatch.safeParse(claims);
  if (parsed.success) return parsed.data;
  throw new ValidationError({
    message: parsed.error.issues[0]?.message ?? "Those claims can't constrain a trust.",
    action:
      "Name the workload with at least one --oidc-claim, preferring an immutable id: --oidc-claim repository_id=1262274726.",
    detail: z.prettifyError(parsed.error),
  });
}

/**
 * A matcher for this issuer, validated: {@link requireSubjectConstraint}, and then — for a profiled issuer — at
 * least one claim that names whose workload the token is.
 *
 * The refusal names why, for the same reason the empty one does: a trust at a shared issuer that matches only on
 * what the job is (its ref, its environment, the event) admits every workload that issuer serves which can be made
 * to look like it, and anybody can create a repository with an environment called `prod`. Claims the profile has
 * never heard of are still allowed beside an identifying one; a custom issuer is held to shape only.
 */
export function requireWorkloadIdentity(issuer: string, claims: Record<string, string>): Record<string, string> {
  const matched = requireSubjectConstraint(claims);
  const profile = profileFor(issuer);
  if (profile === undefined) return matched;
  if (Object.keys(matched).some((claim) => profile.identifying.includes(claim))) return matched;
  const first = profile.recommended[0] as ProfileClaim;
  throw new ValidationError({
    message: `Those claims describe a job, not whose it is, so this trust would admit any ${profile.name} workload that matches them.`,
    action: `Add a claim that names the workload, preferring the immutable id: --oidc-claim ${first.claim}=${first.example}.`,
    detail: `${issuer} signs for every workload it serves. Matched on [${Object.keys(matched).join(", ")}]; at least one of [${profile.identifying.join(", ")}] is required.`,
  });
}

/** An issuer as the operator typed it: an https URL, since its keys are fetched from it. */
export function parseIssuer(raw: string): string {
  const parsed = z.url({ protocol: /^https$/ }).safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ValidationError({
    message: "--oidc-issuer is an https URL.",
    action: "Pass the exact iss its tokens carry, e.g. --oidc-issuer https://token.actions.githubusercontent.com.",
  });
}

/**
 * The audience a trust defaults to: this environment's own Worker origin.
 *
 * `connect` has already resolved and printed that address, so the property that stops a staging token being
 * replayed against production is derived rather than typed — the same pinning the release pipeline does.
 */
export function defaultAudience(workerUrl: string): string {
  return new URL(workerUrl).origin;
}

/** The part of a discovery document a trust needs. `.loose()`: providers publish much more. */
const DiscoveryDocument = z
  .object({
    issuer: z.string().describe("The issuer the document describes. Must equal the one asked about."),
    jwks_uri: z.url({ protocol: /^https$/ }).describe("Where the issuer publishes its signing keys."),
  })
  .loose()
  .describe("An OIDC discovery document, narrowed to what registering a trust reads.");

/**
 * Check an issuer the only way a registration can, and return where it publishes its keys.
 *
 * **What can be proven here is narrower than for a key, and the report says so.** There is no private key here
 * and no workload present, so nothing can make a call. What *is* verifiable is that the issuer's discovery
 * document resolves, names that issuer, and points at a key set that is reachable and parses. Every failure is
 * the issuer's — `core/upstream_failed` — and refuses the registration before anything is written.
 */
export async function resolveIssuer(issuer: string, transport: OidcJwksFetch = oidcJwksFetch): Promise<string> {
  const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const document = DiscoveryDocument.safeParse(await readJson(discoveryUrl, transport, issuer));
  if (!document.success) {
    throw unresolved(issuer, `${discoveryUrl} is not an OIDC discovery document.`);
  }
  if (document.data.issuer !== issuer) {
    throw unresolved(issuer, `${discoveryUrl} describes ${document.data.issuer}, not ${issuer}.`);
  }
  const keys = OidcJwks.safeParse(await readJson(document.data.jwks_uri, transport, issuer));
  if (!keys.success) {
    throw unresolved(issuer, `${document.data.jwks_uri} does not publish a key set.`);
  }
  return document.data.jwks_uri;
}

async function readJson(url: string, transport: OidcJwksFetch, issuer: string): Promise<unknown> {
  let response: Awaited<ReturnType<OidcJwksFetch>>;
  try {
    response = await transport(url);
  } catch (cause) {
    throw unresolved(issuer, `${url} did not answer.`, cause);
  }
  if (!response.ok) throw unresolved(issuer, `${url} answered ${response.status}.`);
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch (cause) {
    throw unresolved(issuer, `${url} answered something that is not JSON.`, cause);
  }
}

function unresolved(issuer: string, why: string, cause?: unknown): UpstreamError {
  return new UpstreamError(
    {
      message: `${issuer} does not resolve as an OIDC issuer. ${why}`,
      action: "Check --oidc-issuer is the exact iss its tokens carry. Nothing was registered.",
      detail: why,
    },
    cause === undefined ? undefined : { cause },
  );
}
