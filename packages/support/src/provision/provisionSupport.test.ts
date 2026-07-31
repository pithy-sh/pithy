// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import {
  deprovisionSupport,
  provisionSupport,
  SUPPORT_ROUTING_RULE_NAME,
  type SupportDeprovisioner,
  type SupportProvisioner,
  supportWorkerName,
} from "./provisionSupport";

/**
 * The provisioning orchestration — order, fan-out, and what it reports.
 *
 * Every live step sits behind a seam precisely so this is testable without touching Cloudflare, and
 * the properties worth pinning are the ones whose failure is invisible until production: the order
 * (a routing rule created before the classifier exists means real customer mail arrives with nothing
 * to classify it), and the per-environment fan-out (an index created in staging and not production
 * is a search box that works for the developer and not the customer).
 */

/** A provisioner that records what was called, in order. */
function recorder(overrides: Partial<SupportProvisioner> = {}) {
  const calls: string[] = [];
  const provisioner: SupportProvisioner = {
    preflight: async () => {
      calls.push("preflight");
    },
    ensureBucket: async () => {
      calls.push("bucket");
      return { bucket: "pithy-support", created: true, skipped: false };
    },
    deployWorker: async (env) => {
      calls.push(`worker:${env}`);
    },
    ensureSearchIndex: async (env) => {
      calls.push(`search:${env}`);
      return { created: true, dropped: false };
    },
    ensureRoutingRule: async () => {
      calls.push("routing");
      return { created: true, skipped: false };
    },
    ...overrides,
  };
  return { provisioner, calls };
}

describe("provisionSupport", () => {
  test("preflights before creating anything", async () => {
    const { provisioner, calls } = recorder();
    await provisionSupport(provisioner);
    expect(calls[0]).toBe("preflight");
  });

  test("creates the bucket before any worker that could write to it", async () => {
    const { provisioner, calls } = recorder();
    await provisionSupport(provisioner);
    expect(calls.indexOf("bucket")).toBeLessThan(calls.indexOf(`worker:${managedEnvironments()[0]}`));
  });

  test("creates the routing rule last, so mail never arrives before a classifier exists", async () => {
    // The ordering that matters most. A rule created first starts delivering real customer mail to a
    // Worker whose classification host is not deployed yet — a window where messages land and stay
    // `uncategorized` with nothing to say why.
    const { provisioner, calls } = recorder();
    await provisionSupport(provisioner);
    expect(calls.at(-1)).toBe("routing");
  });

  test("touches the search index once per environment, after that environment's worker", async () => {
    // Per environment because each has its own app database — an index in staging says nothing about
    // production. After the worker so a database that gains an index always has something to write it.
    const { provisioner, calls } = recorder();
    await provisionSupport(provisioner);

    for (const env of managedEnvironments()) {
      expect(calls).toContain(`search:${env}`);
      expect(calls.indexOf(`worker:${env}`)).toBeLessThan(calls.indexOf(`search:${env}`));
    }
    expect(calls.filter((call) => call.startsWith("search:"))).toHaveLength(managedEnvironments().length);
  });

  test("reports what the index actually did, per environment", async () => {
    // Reported rather than assumed: this is DDL on the adopter's own database, and a provisioning
    // command whose output cannot be audited is one an operator has to take on faith.
    const { provisioner } = recorder({
      ensureSearchIndex: async (env) => ({ created: env === "production", dropped: env === "staging" }),
    });
    const result = await provisionSupport(provisioner);

    expect(result.search.filter((entry) => entry.created).map((entry) => entry.env)).toEqual(["production"]);
    expect(result.search.filter((entry) => entry.dropped).map((entry) => entry.env)).toEqual(["staging"]);
  });

  test("an unchanged index reports neither created nor dropped", async () => {
    const { provisioner } = recorder({ ensureSearchIndex: async () => ({ created: false, dropped: false }) });
    const result = await provisionSupport(provisioner);
    expect(result.search.every((entry) => !entry.created && !entry.dropped)).toBe(true);
  });

  test("a skipped bucket is reported rather than hidden", async () => {
    const { provisioner } = recorder({
      ensureBucket: async () => ({ bucket: "pithy-support", created: false, skipped: true }),
    });
    expect((await provisionSupport(provisioner)).bucket.skipped).toBe(true);
  });

  test("a skipped routing rule is reported, because everything else can be right and no mail arrive", async () => {
    const { provisioner } = recorder({ ensureRoutingRule: async () => ({ created: false, skipped: true }) });
    expect((await provisionSupport(provisioner)).routing).toEqual({ created: false, skipped: true });
  });

  test("a failing step stops the run rather than continuing past it", async () => {
    const { provisioner, calls } = recorder({
      ensureBucket: async () => {
        throw new Error("R2 unavailable");
      },
    });
    await expect(provisionSupport(provisioner)).rejects.toThrow("R2 unavailable");
    // No worker deployed against a bucket that does not exist.
    expect(calls.some((call) => call.startsWith("worker:"))).toBe(false);
  });
});

/** A deprovisioner that records what was called, in order. */
function teardown(overrides: Partial<SupportDeprovisioner> = {}) {
  const calls: string[] = [];
  const deprovisioner: SupportDeprovisioner = {
    removeRoutingRule: async () => {
      calls.push("routing");
      return { removed: true };
    },
    deleteWorker: async (env) => {
      calls.push(`worker:${env}`);
    },
    deleteBucket: async () => {
      calls.push("bucket");
    },
    ...overrides,
  };
  return { deprovisioner, calls };
}

describe("deprovisionSupport", () => {
  test("removes the routing rule first, so mail stops before its handler does", async () => {
    // The inverse of provisioning's ordering, for the inverse reason: workers torn down while mail is
    // still arriving means messages land in a Worker with no classification host.
    const { deprovisioner, calls } = teardown();
    await deprovisionSupport(deprovisioner);
    expect(calls[0]).toBe("routing");
  });

  test("keeps the bucket by default — it holds correspondence, not cache", async () => {
    const { deprovisioner, calls } = teardown();
    await deprovisionSupport(deprovisioner);
    expect(calls).not.toContain("bucket");
  });

  test("deletes the bucket only when explicitly asked", async () => {
    const { deprovisioner, calls } = teardown();
    await deprovisionSupport(deprovisioner, { deleteStorage: true });
    expect(calls.at(-1)).toBe("bucket");
  });
});

describe("names", () => {
  test("the worker name is derived per environment, never hand-written", () => {
    expect(supportWorkerName("production")).toBe("pithy-support-production");
    expect(supportWorkerName("staging")).toBe("pithy-support-staging");
  });

  test("the routing rule name is distinct from the email capability's", () => {
    // `ensureWorkerRoute` keys idempotency on the rule *name*, so a shared one would make whichever
    // capability provisioned second silently believe its rule already existed.
    expect(SUPPORT_ROUTING_RULE_NAME).toBe("pithy-support-inbound");
    expect(SUPPORT_ROUTING_RULE_NAME).not.toBe("pithy-email-bounce");
  });
});
