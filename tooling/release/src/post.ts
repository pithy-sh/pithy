// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
 * ## Off is the default, and it is one fact
 *
 * The dashboard does not exist yet. This is configured and disabled: with no endpoint and no credential
 * set, {@link releaseRecordsConfig} answers `configured: false`, the step says so and the release
 * continues. Deliberately **not** a separate `ENABLED` switch — a second flag can disagree with whether
 * an endpoint is actually configured, and then the log line is a lie in one direction or the other.
 * Set both variables and it is on; that is the whole switch.
 *
 * ## Nothing here may fail a release
 *
 * An unreachable dashboard cannot block publishing an open-source package. Every failure — a refusal, a
 * transport error, a dashboard that never answers — is reported and returned, never thrown. The caller
 * exits 0.
 *
 * The cost of that is a dashboard silently missing a release, which would under-report the gap. That is
 * what the replay in `changelog.ts` is for: the `Security:` marker is visible prose committed to the
 * CHANGELOG, so a missed write is recoverable rather than permanent.
 *
 * ## What the log may say
 *
 * A CI log for a public repository is public. The credential reaches exactly one place — the
 * `Authorization` header — and no failure path echoes it, including the endpoint's own rejection body,
 * which is upstream text this code does not control.
 */

/** How long to wait for the dashboard before giving up. A release does not queue behind it. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of an endpoint's rejection body to quote — enough to diagnose, not enough to be a payload. */
const REJECTION_EXCERPT = 200;

/** The step's configuration: an endpoint and a credential, or a reason it is off. */
export type ReleaseRecordsConfig =
  | { configured: false; reason: string }
  | { configured: true; url: string; token: string };

/** The environment variables that turn the write on. Both, or it is off. */
interface ReleaseRecordsEnv {
  /** The dashboard's ingest endpoint. Must be https. */
  PITHY_RELEASE_RECORDS_URL?: string | undefined;
  /** The scoped credential for that one endpoint. Never a Cloudflare token. */
  PITHY_RELEASE_RECORDS_TOKEN?: string | undefined;
}

/** An unset variable and one set to the empty string are the same fact: not configured. */
function present(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Read the step's configuration from the environment.
 *
 * Absent is *off* and is not an error — that is the state this ships in. A **malformed** endpoint is an
 * error, because it means someone configured this and got it wrong, and silently doing nothing would
 * hide that until a customer asked why the dashboard was empty.
 */
export function releaseRecordsConfig(env: ReleaseRecordsEnv): ReleaseRecordsConfig {
  const url = present(env.PITHY_RELEASE_RECORDS_URL);
  const token = present(env.PITHY_RELEASE_RECORDS_TOKEN);
  if (url === null || token === null) {
    return { configured: false, reason: "no endpoint configured" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`PITHY_RELEASE_RECORDS_URL is not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`PITHY_RELEASE_RECORDS_URL must be https, got ${parsed.protocol.replace(":", "")}`);
  }
  return { configured: true, url, token };
}

/** What the write did. Every one of these is a normal, non-fatal outcome. */
export type PostOutcome =
  | { status: "off"; reason: string }
  | { status: "empty" }
  | { status: "posted"; count: number }
  | { status: "failed"; reason: string };

/** What {@link postReleaseRecords} needs. */
export interface PostOptions {
  /** The records this release produced. */
  records: ReleaseRecord[];
  /** The resolved configuration, from {@link releaseRecordsConfig}. */
  config: ReleaseRecordsConfig;
  /** Transport seam, so a test needs no network. */
  fetch?: typeof fetch;
  /** How long to wait before giving up. */
  timeoutMs?: number;
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
 * Post the records, if there is anywhere to post them and anything to say.
 *
 * Never throws. Every failure comes back as `{ status: "failed" }` for the caller to log and continue.
 */
export async function postReleaseRecords(options: PostOptions): Promise<PostOutcome> {
  const { config } = options;
  if (!config.configured) return { status: "off", reason: config.reason };
  if (options.records.length === 0) return { status: "empty" };

  // The contract with `pithy-sh/dashboard#2`. A malformed record stored is worse than one never sent:
  // the dashboard would hold a release nothing can compare against, and the replay would not fix it
  // because the key is already there.
  const validated = ReleaseRecord.array().safeParse(options.records);
  if (!validated.success) {
    return { status: "failed", reason: `records do not satisfy the contract: ${validated.error.message}` };
  }

  const send = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await send(config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ records: validated.data }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Read the body for diagnosis, and never let reading it become its own failure.
      const body = await response.text().catch(() => "");
      const excerpt = redact(body.slice(0, REJECTION_EXCERPT).trim(), config.token);
      return {
        status: "failed",
        reason: `dashboard rejected the records: ${response.status}${excerpt === "" ? "" : ` ${excerpt}`}`,
      };
    }
    return { status: "posted", count: validated.data.length };
  } catch (error) {
    return { status: "failed", reason: reasonOf(error, config.token) };
  } finally {
    clearTimeout(timer);
  }
}
