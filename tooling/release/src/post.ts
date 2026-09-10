// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MintToken } from "./oidc";
import { ReleaseRecord } from "./records";

/**
 * Write the release records to the dashboard — an endpoint, never the database, and never at the cost
 * of the release.
 *
 * ## Why an endpoint and not a direct write
 *
 * Writing to the dashboard's D1 from CI would mean CI holding a Cloudflare API token, and those are
 * **not table-scoped**: a token able to insert releases could read and write everything in that
 * database — the dashboard's own users, its subscriptions, and the control-plane private keys it holds
 * for every customer. A leaked CI secret would be a total compromise of the commercial product.
 *
 * Posting to one endpoint reduces the blast radius to "someone can post fake release records" — bad,
 * bounded, instantly revocable, and auditable. The credential grants one operation instead of a
 * database.
 *
 * ## The credential is minted, not shared
 *
 * There is no shared secret on either end. CI asks GitHub for an OIDC token naming an audience and
 * sends it as a bearer token; the dashboard verifies GitHub's signature and then the claims — issuer,
 * audience, and `sub`, which for this job is `repo:pithy-sh/pithy:environment:npm-publish`. The
 * allowlisted `sub` is configuration on the receiver, so revoking is a config edit rather than a
 * rotation held on two sides. See `oidc.ts` for the minting, and `@pithy-sh/core/src/http/oidcWebhook`
 * for the verifier.
 *
 * ## Two destinations, and a token each
 *
 * Staging and production both receive records — staging's release pane is otherwise empty of anything a
 * real pipeline produced. Each is configured by its own variable and **attempted independently**, so a
 * staging outage cannot cost the production record.
 *
 * ### Audience
 *
 * Each destination gets **its own audience: that destination's origin.** One token per destination, one
 * request each against a runner-local endpoint. The property that buys is that a token minted for
 * staging is not replayable against production — a credential narrow as well as short-lived, which is
 * the whole reason OIDC was picked over a shared secret. A shared audience would make the two
 * interchangeable to anyone holding a token in flight, and would leave the receiver asserting `sub`
 * alone; with the origin in `aud` the two checks are independent.
 *
 * The audience is *derived* from the endpoint rather than configured beside it, so there is no second
 * value to set and no way to point staging's variable at production while its audience still says
 * staging.
 *
 * ## Off is the default, and it is one fact
 *
 * With no endpoint variable set, {@link releaseRecordsConfig} answers with an empty list, the step says
 * so and the release continues. Deliberately **not** a separate `ENABLED` switch — a second flag can
 * disagree with whether an endpoint is actually configured, and then the log line is a lie in one
 * direction or the other. Set a variable and that destination is on; that is the whole switch.
 *
 * ## Nothing here may fail a release
 *
 * An unreachable dashboard cannot block publishing an open-source package. Every failure — a refusal, a
 * transport error, a dashboard that never answers, an OIDC token that never arrives — is reported and
 * returned, never thrown.
 *
 * It is still **not silent**: the caller exits non-zero and the workflow step carries
 * `continue-on-error: true`, so GitHub renders a failed step under a green job. The release stands and
 * the failure is visible in the run list rather than in a log nobody opens. A missed write is recovered
 * by `releaseRecords.ts replay`, which reads the `Security:` markers back out of the committed
 * CHANGELOGs.
 *
 * ## What the log may say
 *
 * A CI log for a public repository is public. A minted token reaches exactly one place — the
 * `Authorization` header — and no failure path echoes it, including the endpoint's own rejection body,
 * which is upstream text this code does not control.
 */

/** How long to wait for the dashboard before giving up. A release does not queue behind it. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of an endpoint's rejection body to quote — enough to diagnose, not enough to be a payload. */
const REJECTION_EXCERPT = 200;

/** Which dashboard a record is going to. The word that appears in every line about it. */
export type DestinationName = "staging" | "prod";

/** The environment variables that turn a destination on. One each, no secret beside either. */
interface ReleaseRecordsEnv {
  /** Staging's ingest endpoint. Must be https. */
  PITHY_RELEASE_RECORDS_URL_STAGING?: string | undefined;
  /** Production's ingest endpoint. Must be https. */
  PITHY_RELEASE_RECORDS_URL_PROD?: string | undefined;
}

/** The variable each destination reads, in the order deliveries are reported. */
const DESTINATIONS: readonly { name: DestinationName; variable: keyof ReleaseRecordsEnv }[] = [
  { name: "staging", variable: "PITHY_RELEASE_RECORDS_URL_STAGING" },
  { name: "prod", variable: "PITHY_RELEASE_RECORDS_URL_PROD" },
];

/** One configured dashboard: where to post, and the audience the token for it must name. */
export interface ReleaseDestination {
  /** Which dashboard this is. */
  name: DestinationName;
  /** The ingest endpoint, exactly as configured. */
  url: string;
  /** This destination's origin — never another's, which is what makes a token non-replayable. */
  audience: string;
}

/** An unset variable and one set to the empty string are the same fact: this destination is off. */
function present(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Read the configured destinations from the environment.
 *
 * Absent is *off* and is not an error — an empty list is the state this ships in, and one destination
 * configured without the other is a legitimate half. A **malformed** endpoint is an error, because it
 * means someone configured this and got it wrong, and silently doing nothing would hide that until a
 * customer asked why the dashboard was empty.
 */
export function releaseRecordsConfig(env: ReleaseRecordsEnv): ReleaseDestination[] {
  const configured: ReleaseDestination[] = [];
  for (const { name, variable } of DESTINATIONS) {
    const url = present(env[variable]);
    if (url === null) continue;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${variable} is not a URL: ${url}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`${variable} must be https, got ${parsed.protocol.replace(":", "")}`);
    }
    configured.push({ name, url, audience: parsed.origin });
  }
  return configured;
}

/** What one destination's delivery did. Both are normal, non-fatal outcomes. */
export type Delivery = { destination: DestinationName } & (
  | { status: "posted"; count: number }
  | { status: "failed"; reason: string }
);

/**
 * What the whole write did.
 *
 * `delivered` carries one entry per destination rather than collapsing to a verdict: *posted to prod,
 * failed to staging* is a different sentence from *failed*, and an exit code cannot carry it alone.
 */
export type PostOutcome =
  | { status: "off" }
  | { status: "empty" }
  | { status: "delivered"; deliveries: readonly Delivery[] };

/** What {@link postReleaseRecords} needs. */
export interface PostOptions {
  /** The records this release produced. */
  records: ReleaseRecord[];
  /** The destinations to write to, from {@link releaseRecordsConfig}. */
  destinations: readonly ReleaseDestination[];
  /** Mints one token per audience — {@link MintToken}. */
  mintToken: MintToken;
  /** Transport seam, so a test needs no network. */
  fetch?: typeof fetch;
  /** How long to wait before giving up on one destination. */
  timeoutMs?: number;
  /**
   * Post even with nothing to report.
   *
   * The dry run's proof delivery: a zero-record body that mints a real token and gets a real answer, so
   * the claims are proven to agree with the verifier before a release depends on it. Off everywhere
   * else, because an empty write is otherwise noise.
   */
  sendEmpty?: boolean;
}

/** Whatever went wrong, as one line with no credential in it. */
function reasonOf(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw, token);
}

/**
 * Remove the credential from anything about to be logged.
 *
 * Belt and braces — this code never interpolates the token into a message. But two of the strings here
 * come from somewhere else entirely: a transport error's text, and the endpoint's own rejection body.
 * Neither is ours, both are printed, and the log is public.
 */
function redact(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("[redacted]");
}

/**
 * Mint this destination's token and post to it.
 *
 * Never throws: the token stays inside this call, and so does every way it can go wrong. That is what
 * makes one destination's outage cost only its own record.
 */
async function deliver(
  destination: ReleaseDestination,
  records: ReleaseRecord[],
  options: PostOptions,
): Promise<Delivery> {
  // Held only here, and never handed to another destination — a staging token that reached the
  // production request would give away the one property the per-destination audience buys.
  let token = "";
  const send = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    token = await options.mintToken(destination.audience);
    const response = await send(destination.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ records }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Read the body for diagnosis, and never let reading it become its own failure.
      const body = await response.text().catch(() => "");
      const excerpt = redact(body.slice(0, REJECTION_EXCERPT).trim(), token);
      return {
        destination: destination.name,
        status: "failed",
        reason: `rejected the records: ${response.status}${excerpt === "" ? "" : ` ${excerpt}`}`,
      };
    }
    return { destination: destination.name, status: "posted", count: records.length };
  } catch (error) {
    return { destination: destination.name, status: "failed", reason: reasonOf(error, token) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post the records to every configured destination, if there is anywhere to post them and anything to
 * say.
 *
 * Never throws. Destinations are attempted **concurrently and independently**, so neither waits on the
 * other and neither can fail for the other's reason.
 */
export async function postReleaseRecords(options: PostOptions): Promise<PostOutcome> {
  if (options.destinations.length === 0) return { status: "off" };
  if (options.records.length === 0 && options.sendEmpty !== true) return { status: "empty" };

  // The contract with `pithy-sh/dashboard#2`. A malformed record stored is worse than one never sent:
  // the dashboard would hold a release nothing can compare against, and the replay would not fix it
  // because the key is already there. Checked once — every destination gets the same body.
  const validated = ReleaseRecord.array().safeParse(options.records);
  if (!validated.success) {
    return {
      status: "delivered",
      deliveries: options.destinations.map((destination) => ({
        destination: destination.name,
        status: "failed" as const,
        reason: `records do not satisfy the contract: ${validated.error.message}`,
      })),
    };
  }

  const deliveries = await Promise.all(
    options.destinations.map((destination) => deliver(destination, validated.data, options)),
  );
  return { status: "delivered", deliveries };
}
