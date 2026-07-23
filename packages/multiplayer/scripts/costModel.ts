/**
 * The multiplayer (Durable Objects) cost model.
 *
 * The arithmetic ships as a script, not as hand-maths in prose, so each release can re-run it. If the
 * numbers here and the numbers in docs/costs.md disagree, the docs are wrong until updated.
 *
 * Run it: `bun run --filter @pithy-sh/multiplayer costs`
 *
 * READ THE INFERENCE FLAGS BELOW BEFORE QUOTING ANY OUTPUT. Some inputs are Cloudflare's published
 * figures; the rest are our arithmetic over them. They are not the same thing and must not be presented
 * as though they were.
 */

/**
 * Cloudflare's published Durable Objects unit prices, as of the date below.
 *
 * CITED — from Cloudflare's Durable Objects pricing page. The `websocketBillingRatio` is the load-bearing
 * one: Cloudflare applies a 20:1 ratio to incoming WebSocket messages for billing, so a model that counted
 * every frame as a request would overstate a chatty session by up to 20×.
 */
export const DO_PRICING_AS_OF = "2026-07-16";

export const DO_PRICING = {
  /** Requests included per month before metering starts (also covers WebSocket messages and alarms). */
  requestsIncluded: 1_000_000,
  /** USD per million requests past the allowance. */
  requestsPerMillion: 0.15,
  /** Twenty inbound WebSocket messages bill as one request. */
  websocketBillingRatio: 20,
  /** GB-s of duration included per month. */
  durationGbsIncluded: 400_000,
  /** USD per million GB-s past the allowance. */
  durationPerMillionGbs: 12.5,
  /** Every object bills the full 128 MB allocation while awake, regardless of actual usage. */
  durationMemoryMb: 128,
} as const;

/**
 * The workload. OURS, not Cloudflare's — every field is an assumption, and the output moves with them.
 *
 * A commit-reveal duel is not chatty: a create, a join, one commit apiece, a resolve, and a few state
 * reads. `wsMessagesPerSession` counts the inbound WebSocket messages (subject to the 20:1 ratio);
 * `plainRequestsPerSession` counts the HTTP requests that are not WebSocket messages. `awakeSecondsPerSession`
 * is how long the object is awake and unable to hibernate across the session — seconds, because it
 * hibernates between turns.
 */
export interface Workload {
  sessionsPerMonth: number;
  wsMessagesPerSession: number;
  plainRequestsPerSession: number;
  awakeSecondsPerSession: number;
}

export const DEFAULT_WORKLOAD: Workload = {
  sessionsPerMonth: 1_000_000,
  wsMessagesPerSession: 10,
  plainRequestsPerSession: 6,
  awakeSecondsPerSession: 5,
};

export interface CostEstimate {
  billableRequests: number;
  durationGbs: number;
  requestCost: number;
  durationCost: number;
  total: number;
}

/** Estimate a monthly bill, applying the 20:1 WebSocket ratio, the fixed 128 MB duration allocation, and the free tiers. */
export function estimate(workload: Workload, pricing = DO_PRICING): CostEstimate {
  const wsBillable = (workload.wsMessagesPerSession / pricing.websocketBillingRatio) * workload.sessionsPerMonth;
  const plainBillable = workload.plainRequestsPerSession * workload.sessionsPerMonth;
  const billableRequests = wsBillable + plainBillable;

  const durationGbs = workload.awakeSecondsPerSession * workload.sessionsPerMonth * (pricing.durationMemoryMb / 1024);

  const requestsMetered = Math.max(0, billableRequests - pricing.requestsIncluded);
  const durationMetered = Math.max(0, durationGbs - pricing.durationGbsIncluded);

  const requestCost = (requestsMetered / 1_000_000) * pricing.requestsPerMillion;
  const durationCost = (durationMetered / 1_000_000) * pricing.durationPerMillionGbs;

  return { billableRequests, durationGbs, requestCost, durationCost, total: requestCost + durationCost };
}

function main(): void {
  const workload = DEFAULT_WORKLOAD;
  const cost = estimate(workload);
  const usd = (n: number) => `$${n.toFixed(2)}`;

  process.stdout.write(`Multiplayer cost model — Durable Objects pricing as of ${DO_PRICING_AS_OF}.\n\n`);
  process.stdout.write(`Workload (assumptions, not Cloudflare's):\n`);
  process.stdout.write(`  ${workload.sessionsPerMonth.toLocaleString()} sessions/month\n`);
  process.stdout.write(`  ${workload.wsMessagesPerSession} inbound WebSocket messages/session (billed 20:1)\n`);
  process.stdout.write(`  ${workload.plainRequestsPerSession} plain HTTP requests/session\n`);
  process.stdout.write(`  ${workload.awakeSecondsPerSession}s awake (non-hibernating)/session\n\n`);
  process.stdout.write(`Billable requests/month: ${Math.round(cost.billableRequests).toLocaleString()}\n`);
  process.stdout.write(`Duration GB-s/month:     ${Math.round(cost.durationGbs).toLocaleString()}\n`);
  process.stdout.write(`  request cost:  ${usd(cost.requestCost)}\n`);
  process.stdout.write(`  duration cost: ${usd(cost.durationCost)}\n`);
  process.stdout.write(`  total:         ${usd(cost.total)}/month\n\n`);
  process.stdout.write(
    `This is arithmetic over Cloudflare's rates, not a quote. Cloudflare's live pricing is the authority.\n`,
  );
}

// Run only when invoked directly (`bun scripts/costModel.ts`), not when imported by a test.
if (import.meta.main) main();
