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
 * **Propagation is not instant.** A custom domain takes time to route to a new version, so the probe
 * retries on a doubling schedule — `1s, 2s, 4s, 8s, 16s, 32s` over seven attempts, about a minute in
 * all — before concluding anything. `backoffSchedule` below is that schedule, named so a test asserts it.
 *
 * **The window was four seconds until #677, and the header claimed a backoff it did not implement.** Five
 * attempts a constant second apart concluded before any real promotion had finished, and it failed two
 * consecutive correct deploys of the dashboard — each time naming the version the *previous* deploy had
 * shipped, which by then was serving. Nothing observed the delay, so the flat second survived the
 * sentence describing it as a backoff: every test injected a `sleep` that discarded the duration.
 *
 * **A minute, because thirty seconds is inside the uncertainty.** Real promotion was measured only as a
 * bound — longer than the four seconds that failed, no longer than the thirty-three by which it had
 * already finished. A ceiling inside that interval is a coin flip; sixty is clear of it.
 *
 * **What the widening costs, stated rather than waved at.** A verified deploy pays nothing: the loop
 * returns on the first sighting, so one request and no wait. A `mismatch` and an `unreachable` pay the
 * whole schedule, which is right — both are failures, and both were being reached wrongly before.
 *
 * **And `inconclusive` would have paid it too, which is why the loop stops early.** The expected-version
 * return fires on one condition, so a Worker answering `/health` without a version — a project that has
 * not adopted `CF_VERSION_METADATA` — would fall through every attempt to a verdict `isDeployFailure`
 * calls fine: 63 seconds **per Worker**, on every deploy, for a state `pithy doctor` already reports. Not
 * hypothetical; the kit's own first adopter shipped exactly that on both deployed environments
 * (`docs/commands/doctor.md`). `SETTLED_ATTEMPTS` ends it after three such answers, because waiting
 * cannot change them.
 *
 * **The early exit turns on a 2xx, and that is the whole care in it.** A `200` naming no version says the
 * route is mounted and the binding is absent — settled, and no wait produces one. A **non**-2xx says a
 * Worker has not finished answering properly, which is transient and is what the schedule is *for*, so it
 * is not treated as settled and keeps the full minute. Collapsing the two is the mistake available here:
 * `version: null` covers both, and bailing on it would cut the window for a Worker that was merely still
 * coming up. The one case the exit genuinely costs is the deploy that *adds* the binding, where the old
 * version answers versionless and the new one would have reported — that now reads `inconclusive`, which
 * fails nothing and verifies on the next deploy.
 *
 * **A gradual deployment is not a failure.** Under one, the previous version is still legitimately
 * serving a share of traffic, so hitting it is expected. The rule that distinguishes the two is
 * *consistency*: if any probe sees the version just shipped, the deploy is verified. If every probe sees
 * one single other version, that is a genuine mismatch. If probes see **more than one** version, the
 * fleet is mixed — a rollout in progress — and the answer is `inconclusive`, said out loud, rather than a
 * failure.
 *
 * ## And nothing answering is not "cannot tell"
 *
 * Those two were one branch until #264, and the conflation cost the whole check. A probe that received no
 * response at all and a probe that received a 200 with no `version` field both landed in `inconclusive`,
 * under a sentence blaming `CF_VERSION_METADATA` — so a Worker deployed with a declared domain and no
 * route behind it, answering at no address, reported a deploy that "succeeded" and pointed the adopter at
 * a binding that was already declared.
 *
 * They are different facts and they are established differently. *Something answered and could not say
 * which version it is* is ordinary — an unadopted binding, a `/health` that is not mounted — and stays
 * `inconclusive`. *Nothing answered* is transport-level: DNS, TLS, a timeout, no route. That is a failed
 * deploy, and the address that did not answer is the fact worth printing.
 */

import { HEALTH_PATH } from "@pithy-sh/core/src/worker/health";

/** What a probe concluded. */
export type DeployVerification =
  | "verified" // the version just shipped answered at the declared domain
  | "mismatch" // something else is consistently answering there
  | "inconclusive" // a gradual rollout, or the Worker answered without a version
  | "unreachable"; // nothing answered at all

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
  /** How many times to probe before concluding. Defaults to 7, which `backoffSchedule` spreads over ~63s. */
  attempts?: number;
  /**
   * The **first** wait, in ms, which then doubles on each attempt. Defaults to 1000.
   *
   * Named for the first interval rather than for the whole window because that is what a caller can
   * reason about: `backoffSchedule` turns it and `attempts` into the series, and the series is what is
   * asserted. It stays injected so the suite drives it, and so does anyone who measures a real ceiling
   * and wants a different one.
   */
  delayMs?: number;
  /**
   * How long one probe may take before it is abandoned, in ms. Defaults to 5 seconds.
   *
   * Without a bound, a domain that accepts a connection and never answers stalls on undici's 300-second
   * headers timeout — seven attempts of that is thirty-five minutes of a `pithy deploy` that looks hung,
   * in CI, after the deploy has already succeeded. A health probe that cannot answer in five seconds has
   * answered: this attempt failed, try the next one.
   *
   * **The arithmetic moved with the attempt count in #677, and so did the worst case *with* the bound.**
   * Seven five-second timeouts plus the 63-second schedule is about a minute and a half before an
   * unreachable address is called unreachable, against roughly half a minute before. That is the price of
   * the wider window and it is paid only by a deploy that is already failing — the verdict was going to
   * be `unreachable` either way, and arriving at it a minute later costs an operator nothing that
   * arriving at it wrongly after four seconds did not cost them more.
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

/** Seven probes, so the doubling schedule below spans about a minute. See the header for why a minute. */
const DEFAULT_ATTEMPTS = 7;

/** The first wait. Each subsequent one doubles it. */
const DEFAULT_DELAY_MS = 1000;

/** Five seconds per probe. A `/health` route that cannot answer in that has answered. */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * How many consecutive 2xx-without-a-version answers settle the question.
 *
 * Three, which is about the four-second window that existed before #677 — so the one case that was
 * paying that window and is served by nothing longer goes on paying roughly it, while every case the
 * longer window exists for keeps the whole minute.
 */
const SETTLED_ATTEMPTS = 3;

/**
 * What one probe learned, and the distinction the whole conclusion turns on.
 *
 * `reached` is whether an HTTP response came back at all — any status. A 404 or a 500 is a Worker (or a
 * Cloudflare error page) at that address saying something, which is a different world from a DNS failure.
 * `version` is what it reported, when it could.
 */
interface Probe {
  reached: boolean;
  version: string | null;
  /**
   * A **2xx** whose body carried no `version`: the route is mounted and the binding is not.
   *
   * The distinction that lets the loop stop early. `version: null` covers two unlike facts — a Worker
   * answering `200 {"status":"ok"}` with no `CF_VERSION_METADATA`, which will never start reporting one
   * however long anyone waits, and a non-2xx from a Worker that is still coming up, which may well report
   * a version on the next probe. Waiting is pointless for the first and is the whole point for the second.
   */
  versionless: boolean;
}

/** No single wait exceeds this. See `backoffSchedule` for why a cap exists at all. */
const MAX_WAIT_MS = 32_000;

/**
 * The waits between probes, doubling from `delayMs` and capped: for 7 attempts at 1000ms,
 * `[1s, 2s, 4s, 8s, 16s, 32s]`.
 *
 * **One fewer entry than `attempts`, because nothing is waited after the last probe.** That is the whole
 * reason this is a list rather than a function of the attempt number — the absence of a final wait is a
 * property of the series, so it is visible in what the series *is* rather than in an `if` at the call
 * site that a reader has to evaluate.
 *
 * **Capped at `MAX_WAIT_MS`, because `attempts` is a public option and doubling is a trap in one.** The
 * total used to be linear in it — `(attempts - 1) · delayMs` — so raising 7 to 12 bought five more
 * seconds. Uncapped doubling makes the same edit buy about thirty-four minutes, and `timeoutMs` bounds a
 * single probe rather than the series, so nothing else would catch it. Past the cap the series is linear
 * again, which is the behavior someone tuning the number already expects. The default schedule is
 * unchanged: its largest wait is exactly the cap.
 *
 * Exported so the schedule is asserted directly. The flat delay it replaces was described in this file's
 * header as a backoff for as long as it existed, and no test could contradict the sentence because every
 * one of them injected a `sleep` that threw the duration away (#677).
 */
export function backoffSchedule(attempts: number, delayMs: number): number[] {
  return Array.from({ length: Math.max(0, attempts - 1) }, (_, index) => Math.min(delayMs * 2 ** index, MAX_WAIT_MS));
}

/** One probe. Reports whether anything answered, and the version it named. */
async function probe(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Probe> {
  try {
    // `HEALTH_PATH` rather than a literal: `createBackend` mounts the route, and a probe that writes
    // its own copy of the path is a deploy check that goes inconclusive the day the route moves (#400).
    const response = await fetchImpl(`${url.replace(/\/+$/, "")}${HEALTH_PATH}`, {
      method: "GET",
      headers: { accept: "application/json" },
      // An abort lands in the same `catch` as a DNS or TLS failure, which is right: all three mean nothing
      // answered, and the retry loop is what decides whether that is fatal.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Answered, whatever it said. The body is only read on a 2xx — a 404's body is not JSON worth parsing.
    // A non-2xx is deliberately *not* `versionless`: it is a Worker that has not finished answering
    // properly, which is the transient case, and the schedule exists for exactly that.
    if (!response.ok) return { reached: true, version: null, versionless: false };
    const body = (await response.json().catch(() => ({}))) as HealthBody;
    const version = typeof body.version === "string" && body.version.length > 0 ? body.version : null;
    return { reached: true, version, versionless: version === null };
  } catch {
    // A DNS failure, a TLS failure, a timeout. Indistinguishable from "not routed yet" on the first
    // attempt, which is exactly why this retries rather than concluding.
    return { reached: false, version: null, versionless: false };
  }
}

/**
 * Probe the declared domain until the expected version answers, or until the attempts run out.
 *
 * Returns as soon as the expected version is seen — the common case costs one request and no wait at all.
 * Only a deploy that has *not* propagated pays the schedule, which is why widening it is free.
 */
export async function verifyDeployedVersion(options: VerifyDeployOptions): Promise<VerifyDeployResult> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const waits = backoffSchedule(attempts, delayMs);

  const observed: string[] = [];
  let reached = 0;
  /** 2xx answers that named no version. Compared against the attempt count, never kept as a streak. */
  let settled = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { reached: answered, version, versionless } = await probe(options.url, fetchImpl, timeoutMs);
    if (answered) reached += 1;
    if (versionless) settled += 1;
    // **Stop once the answer cannot change.** Every probe so far has been a 2xx that named no version, so
    // the route is mounted, the binding is absent, and no amount of waiting produces one. The verdict is
    // the same `inconclusive` the full schedule would reach, so the only thing the remaining attempts buy
    // is a minute of silence per Worker on a deploy that succeeded. `settled === attempt` and not a
    // counter of consecutive answers, deliberately: one version sighting means propagation is under way
    // and this is not that situation at all, so the whole window applies again.
    if (settled === attempt && attempt >= SETTLED_ATTEMPTS) {
      return {
        status: "inconclusive",
        observed,
        attempts: attempt,
        detail: `${options.url} answered without a version. Check that it declares CF_VERSION_METADATA.`,
      };
    }
    if (version !== null) {
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
    // `waits` is one shorter than `attempts`, so the last probe finds nothing here and concludes.
    const wait = waits[attempt - 1];
    if (wait !== undefined) await sleep(wait);
  }

  if (reached === 0) {
    // Nothing answered — not once, over every attempt. The deploy went somewhere, and it is not here.
    // The address is the whole diagnostic: a declared domain with no route behind it is what produces
    // this, and naming a binding instead sends the adopter to the wrong file (#264).
    return {
      status: "unreachable",
      observed,
      attempts,
      detail: `Nothing answered at ${options.url} in ${attempts} attempts. Check that a route in this environment serves that host.`,
    };
  }

  if (observed.length === 0) {
    // Something is there and cannot say which version it is. Ordinary: a project that has not adopted the
    // `CF_VERSION_METADATA` binding genuinely cannot answer, and neither can a Worker with no `/health`.
    return {
      status: "inconclusive",
      observed,
      attempts,
      detail: `${options.url} answered without a version. Check that it declares CF_VERSION_METADATA.`,
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

/** Whether a verification should fail the command. A consistent mismatch, and nothing answering at all. */
export function isDeployFailure(status: DeployVerification): boolean {
  // `inconclusive` is deliberately not a failure: a gradual rollout and an unadopted binding are both
  // ordinary, and failing a deploy for either would train everyone to ignore the check. `unreachable` is
  // the opposite of ordinary — the declared address answered nothing, over every attempt (#264).
  return status === "mismatch" || status === "unreachable";
}
