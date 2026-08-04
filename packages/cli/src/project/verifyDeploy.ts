// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Prove the Worker you just deployed is the one answering at the address this project claims.
 *
 * ## Why not compare the URL wrangler printed
 *
 * That is the obvious move and it is wrong twice over. Wrangler's last printed URL may be a
 * **version-scoped preview URL** under versions and gradual deployments, so comparing it to the declared
 * domain would fire falsely on every deploy. And it depends on an output format nobody controls.
 *
 * ## Why not a liveness probe
 *
 * `GET /health` answering `ok` at the declared domain proves *a* Worker is there — **not the one just
 * deployed**. The old version answering happily would pass, and that is exactly the failure worth
 * catching: a deploy that landed somewhere else (a different account, a different script name) while the
 * declared domain kept serving what was already on it. That failure is silent, and it is the one that
 * costs the most to discover late.
 *
 * ## So the check is a version correlation
 *
 * `parseDeployOutput` already captures the `versionId` wrangler reports. `GET /health` reports the
 * running version from `CF_VERSION_METADATA`. This probes the **declared** domain and asserts the two
 * match. That is an end-to-end assertion — *the Worker I deployed is answering at the address this
 * project claims* — and it behaves identically from CI and a laptop, failing the pipeline rather than
 * printing a line nobody reads.
 *
 * ## Two cases must not produce false failures
 *
 * **Propagation is not instant.** A custom domain can take seconds to route to a new version, so the
 * probe retries with a short backoff before concluding anything.
 *
 * **A gradual deployment is not a failure.** Under one, the previous version is still legitimately
 * serving a share of traffic, so hitting it is expected. The rule that distinguishes the two is
 * *consistency*: if any probe sees the version just shipped, the deploy is verified. If every probe sees
 * one single other version, that is a genuine mismatch. If probes see **more than one** version, the
 * fleet is mixed — a rollout in progress — and the answer is `inconclusive`, said out loud, rather than a
 * failure.
 */

/** What a probe concluded. */
export type DeployVerification =
  | "verified" // the version just shipped answered at the declared domain
  | "mismatch" // something else is consistently answering there
  | "inconclusive" // a gradual rollout, or the Worker cannot report its version
  | "unreachable"; // nothing answered

/** The outcome of verifying one Worker's deploy. */
export interface VerifyDeployResult {
  /** The conclusion. */
  status: DeployVerification;
  /** Every distinct version observed, in the order first seen. Empty when nothing answered. */
  observed: string[];
  /** How many probes were made. */
  attempts: number;
  /** A one-line explanation, in brand voice, for the deploy summary. */
  detail: string;
}

/** What the probe needs. Every dependency injected, so the whole thing is testable with no network. */
export interface VerifyDeployOptions {
  /** The declared base URL, e.g. `https://api.example.com`. `/health` is appended. */
  url: string;
  /** The version id wrangler reported for the deploy just made. */
  expectedVersion: string;
  /** How many times to probe before concluding. Defaults to 5. */
  attempts?: number;
  /** The backoff between probes, in ms. Defaults to 1000. */
  delayMs?: number;
  /**
   * How long one probe may take before it is abandoned, in ms. Defaults to 5 seconds.
   *
   * Without a bound, a domain that accepts a connection and never answers stalls on undici's 300-second
   * headers timeout — five attempts of that is twenty-five minutes of a `pithy deploy` that looks hung,
   * in CI, after the deploy has already succeeded. A health probe that cannot answer in five seconds has
   * answered: this attempt failed, try the next one.
   */
  timeoutMs?: number;
  /** Injected so a test drives the probe with no network and no clock. */
  fetchImpl?: typeof fetch;
  /** Injected so a test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** The `/health` body this reads. `version` is null on a Worker with no version-metadata binding. */
interface HealthBody {
  status?: unknown;
  version?: unknown;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 1000;

/** Five seconds per probe. A `/health` route that cannot answer in that has answered. */
const DEFAULT_TIMEOUT_MS = 5000;

/** One probe. Returns the reported version, or null for anything that did not answer with one. */
async function probe(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, "")}/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      // An abort lands in the same `catch` as a DNS or TLS failure, which is right: all three mean this
      // attempt learned nothing, and the retry loop is what decides whether that is fatal.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthBody;
    return typeof body.version === "string" && body.version.length > 0 ? body.version : null;
  } catch {
    // A DNS failure, a TLS failure, a timeout. Indistinguishable from "not routed yet" on the first
    // attempt, which is exactly why this retries rather than concluding.
    return null;
  }
}

/**
 * Probe the declared domain until the expected version answers, or until the attempts run out.
 *
 * Returns as soon as the expected version is seen — the common case costs one request. Only a deploy
 * that has *not* propagated pays the full backoff.
 */
export async function verifyDeployedVersion(options: VerifyDeployOptions): Promise<VerifyDeployResult> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const observed: string[] = [];
  let answered = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const version = await probe(options.url, fetchImpl, timeoutMs);
    if (version !== null) {
      answered += 1;
      if (version === options.expectedVersion) {
        return {
          status: "verified",
          observed: observed.includes(version) ? observed : [...observed, version],
          attempts: attempt,
          detail: `${options.url} is serving the version just deployed.`,
        };
      }
      if (!observed.includes(version)) observed.push(version);
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  if (answered === 0) {
    // Either nothing is there, or the Worker answers without a version. Both are "cannot tell", and
    // neither is evidence the deploy went wrong — a project that has not adopted the
    // `CF_VERSION_METADATA` binding genuinely cannot say.
    return {
      status: "inconclusive",
      observed,
      attempts,
      detail: `${options.url} did not report a version. Check that it declares CF_VERSION_METADATA.`,
    };
  }

  if (observed.length > 1) {
    return {
      status: "inconclusive",
      observed,
      attempts,
      detail: `${options.url} is serving ${observed.length} versions — a gradual deployment is in progress.`,
    };
  }

  return {
    status: "mismatch",
    observed,
    attempts,
    detail: `${options.url} is serving ${observed[0]}, not the version just deployed.`,
  };
}

/** Whether a verification should fail the command. Only a consistent mismatch does. */
export function isDeployFailure(status: DeployVerification): boolean {
  // `inconclusive` is deliberately not a failure: a gradual rollout and an unadopted binding are both
  // ordinary, and failing a deploy for either would train everyone to ignore the check.
  return status === "mismatch";
}
