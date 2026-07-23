import { describe, expect, test } from "vitest";
import { DO_PRICING, estimate, type Workload } from "./costModel";

const base: Workload = {
  sessionsPerMonth: 1_000_000,
  wsMessagesPerSession: 0,
  plainRequestsPerSession: 0,
  awakeSecondsPerSession: 0,
};

describe("multiplayer cost model", () => {
  test("applies the 20:1 WebSocket billing ratio", () => {
    // 20 WS messages across 1M sessions = 20M messages, billed as 1M requests via the 20:1 ratio.
    const cost = estimate({ ...base, wsMessagesPerSession: 20 });
    expect(cost.billableRequests).toBe(1_000_000);
  });

  test("plain HTTP requests are billed one-for-one, not discounted", () => {
    const cost = estimate({ ...base, plainRequestsPerSession: 6 });
    expect(cost.billableRequests).toBe(6_000_000);
  });

  test("the free request tier zeroes a small workload", () => {
    // 6 plain requests × 100k sessions = 600k < the 1M included tier → no request cost.
    const cost = estimate({ ...base, sessionsPerMonth: 100_000, plainRequestsPerSession: 6 });
    expect(cost.requestCost).toBe(0);
  });

  test("duration bills the fixed 128 MB allocation, hibernation aside", () => {
    // 10s awake × 1M sessions × (128/1024) GB = 1,250,000 GB-s.
    const cost = estimate({ ...base, awakeSecondsPerSession: 10 });
    expect(Math.round(cost.durationGbs)).toBe(1_250_000);
    // Past the 400k GB-s free tier: (1,250,000 - 400,000)/1e6 × $12.50.
    const metered = (1_250_000 - DO_PRICING.durationGbsIncluded) / 1_000_000;
    expect(cost.durationCost).toBeCloseTo(metered * DO_PRICING.durationPerMillionGbs, 6);
  });
});
