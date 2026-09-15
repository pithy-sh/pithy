// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { bounceRoutingRuleName } from "@pithy-sh/email/src/provision/provisionEmail";
import { managedEnvironments } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import {
  deprovisionSupport,
  provisionSupport,
  type SupportDeprovisioner,
  type SupportProvisioner,
  supportRoutingRuleName,
  supportWorkerName,
} from "./provisionSupport";

/**
 * The provisioning orchestration — order, fan-out, and what it reports.
 *
 * Every live step sits behind a seam precisely so this is testable without touching Cloudflare, and
 * the properties worth pinning are the ones whose failure is invisible until prod: the order
 * (a routing rule created before the classifier exists means real customer mail arrives with nothing
 * to classify it), and the per-environment fan-out (an index created in staging and not prod
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
      return { bucket: "acme-global-support", created: true, skipped: false };
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
    await provisionSupport(provisioner, DEFAULT_ENVIRONMENTS);
    expect(calls[0]).toBe("preflight");
  });

  test("creates the bucket before any worker that could write to it", async () => {
    const { provisioner, calls } = recorder();
    await provisionSupport(provisioner, DEFAULT_ENVIRONMENTS);
    expect(calls.indexOf("bucket")).toBeLessThan(
      calls.indexOf(`worker:${managedEnvironments(DEFAULT_ENVIRONMENTS)[0]}`),
    );
  });

  test("creates the routing rule last, so mail never arrives before a classifier exists", async () => {
    // The ordering that matters most. A rule created first starts delivering real customer mail to a
    // Worker whose classification host is not deployed yet — a window where messages land and stay
    // `uncategorized` with nothing to say why.
    const { provisioner, calls } = recorder();
    await provisionSupport(provisioner, DEFAULT_ENVIRONMENTS);
    expect(calls.at(-1)).toBe("routing");
  });

  test("touches the search index once per environment, after that environment's worker", async () => {
    // Per environment because each has its own app database — an index in staging says nothing about
    // prod. After the worker so a database that gains an index always has something to write it.
    const { provisioner, calls } = recorder();
    await provisionSupport(provisioner, DEFAULT_ENVIRONMENTS);

    for (const env of managedEnvironments(DEFAULT_ENVIRONMENTS)) {
      expect(calls).toContain(`search:${env}`);
      expect(calls.indexOf(`worker:${env}`)).toBeLessThan(calls.indexOf(`search:${env}`));
    }
    expect(calls.filter((call) => call.startsWith("search:"))).toHaveLength(
      managedEnvironments(DEFAULT_ENVIRONMENTS).length,
    );
  });

  test("reports what the index actually did, per environment", async () => {
    // Reported rather than assumed: this is DDL on the adopter's own database, and a provisioning
    // command whose output cannot be audited is one an operator has to take on faith.
    const { provisioner } = recorder({
      ensureSearchIndex: async (env) => ({ created: env === "prod", dropped: env === "staging" }),
    });
    const result = await provisionSupport(provisioner, DEFAULT_ENVIRONMENTS);

    expect(result.search.filter((entry) => entry.created).map((entry) => entry.env)).toEqual(["prod"]);
    expect(result.search.filter((entry) => entry.dropped).map((entry) => entry.env)).toEqual(["staging"]);
  });

  test("an unchanged index reports neither created nor dropped", async () => {
    const { provisioner } = recorder({ ensureSearchIndex: async () => ({ created: false, dropped: false }) });
    const result = await provisionSupport(provisioner, DEFAULT_ENVIRONMENTS);
    expect(result.search.every((entry) => !entry.created && !entry.dropped)).toBe(true);
  });

  test("a skipped bucket is reported rather than hidden", async () => {
    const { provisioner } = recorder({
      ensureBucket: async () => ({ bucket: "acme-global-support", created: false, skipped: true }),
    });
    expect((await provisionSupport(provisioner, DEFAULT_ENVIRONMENTS)).bucket.skipped).toBe(true);
  });

  test("a skipped routing rule is reported, because everything else can be right and no mail arrive", async () => {
    const { provisioner } = recorder({ ensureRoutingRule: async () => ({ created: false, skipped: true }) });
    expect((await provisionSupport(provisioner, DEFAULT_ENVIRONMENTS)).routing).toEqual({
      created: false,
      skipped: true,
    });
  });

  /**
   * The narrowed list is how skip-and-report reaches this orchestrator (pithy-sh/pithy#512). The bucket is
   * project-global and must not wait for the last environment to be provisioned; the routing rule must
   * wait for the first, because it is the step that starts delivering real customer mail.
   */
  test("a narrowed environment list deploys only those workers, and the bucket is still created", async () => {
    const { provisioner, calls } = recorder();
    const result = await provisionSupport(provisioner, ["staging"]);

    expect(calls).toEqual(["preflight", "bucket", "worker:staging", "search:staging", "routing"]);
    expect(result.environments).toEqual(["staging"]);
    expect(result.bucket.bucket).toBe("acme-global-support");
  });

  test("no environment at all still creates the bucket, and makes no routing rule", async () => {
    const { provisioner, calls } = recorder();
    const result = await provisionSupport(provisioner, []);

    expect(calls).toEqual(["preflight", "bucket"]);
    expect(result.routing).toEqual({ created: false, skipped: true });
    expect(result.environments).toEqual([]);
  });

  test("a failing step stops the run rather than continuing past it", async () => {
    const { provisioner, calls } = recorder({
      ensureBucket: async () => {
        throw new Error("R2 unavailable");
      },
    });
    await expect(provisionSupport(provisioner, DEFAULT_ENVIRONMENTS)).rejects.toThrow("R2 unavailable");
    // No worker deployed against a bucket that does not exist.
    expect(calls.some((call) => call.startsWith("worker:"))).toBe(false);
  });
});

/**
 * A deprovisioner that records what was called, in order. `workers` is which environments run a classification
 * worker before the run; a deleted one stops running.
 */
function teardown(overrides: Partial<SupportDeprovisioner> = {}, workers: readonly string[] = DEFAULT_ENVIRONMENTS) {
  const calls: string[] = [];
  const running = new Set(workers);
  const deprovisioner: SupportDeprovisioner = {
    removeRoutingRule: async () => {
      calls.push("routing");
      return { removed: true };
    },
    hasWorker: async (env) => running.has(env),
    deleteWorker: async (env) => {
      running.delete(env);
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
  const staging = { environment: "staging", declared: DEFAULT_ENVIRONMENTS };
  const prod = { environment: "prod", declared: DEFAULT_ENVIRONMENTS };

  /**
   * **#591, in support.** `pithy support deprovision` walked every declared environment: a run meant for staging took
   * production's classification worker with it. Planting the old loop back fails this.
   */
  test("removes the named environment's worker and no other, and keeps the rule and the bucket", async () => {
    const { deprovisioner, calls } = teardown();
    expect(await deprovisionSupport(deprovisioner, staging)).toEqual({ env: "staging", routingRuleRemoved: false });
    expect(calls).toEqual(["worker:staging"]);
  });

  test("naming no environment refuses, lists the declared ones, and deletes nothing", async () => {
    const { deprovisioner, calls } = teardown();
    await expect(
      deprovisionSupport(
        deprovisioner,
        { environment: undefined, declared: DEFAULT_ENVIRONMENTS },
        { deleteStorage: true },
      ),
    ).rejects.toMatchObject({
      message: "Name the environment to deprovision. Nothing was deleted.",
      payload: { action: "Pass --env with one of: staging, prod." },
    });
    expect(calls).toEqual([]);
  });

  test("naming an environment the project does not declare refuses, and deletes nothing", async () => {
    const { deprovisioner, calls } = teardown();
    await expect(
      deprovisionSupport(deprovisioner, { environment: "live", declared: DEFAULT_ENVIRONMENTS }),
    ).rejects.toThrow('"live" is not an environment this project declares. Nothing was deleted.');
    expect(calls).toEqual([]);
  });

  /**
   * **The bucket and the rule are every environment's.** One `<project>-global-support` bucket holds the whole
   * project's correspondence, and one rule delivers its inbound mail. A staging teardown with `--storage` deleted
   * production's support history; with `--routing-zone`, it stopped production's inbound mail.
   */
  test("--storage refuses while another environment still runs, before anything is deleted", async () => {
    const { deprovisioner, calls } = teardown();
    await expect(deprovisionSupport(deprovisioner, staging, { deleteStorage: true })).rejects.toMatchObject({
      message: "The support bucket is shared by every environment, and prod still runs. Nothing was deleted.",
      payload: { action: "Deprovision prod first, or drop --storage." },
    });
    expect(calls).toEqual([]);
  });

  test("--routing-zone refuses the same way", async () => {
    const { deprovisioner, calls } = teardown();
    await expect(deprovisionSupport(deprovisioner, staging, { removeRouting: true })).rejects.toMatchObject({
      message: "The inbound routing rule is shared by every environment, and prod still runs. Nothing was deleted.",
      payload: { action: "Deprovision prod first, or drop --routing-zone." },
    });
    expect(calls).toEqual([]);
  });

  test("removes the routing rule first on the last teardown, so mail stops before its handler does", async () => {
    // The inverse of provisioning's ordering, for the inverse reason: workers torn down while mail is
    // still arriving means messages land in a Worker with no classification host.
    const { deprovisioner, calls } = teardown({}, ["prod"]);
    expect(await deprovisionSupport(deprovisioner, prod, { removeRouting: true, deleteStorage: true })).toEqual({
      env: "prod",
      routingRuleRemoved: true,
    });
    expect(calls).toEqual(["routing", "worker:prod", "bucket"]);
  });

  test("keeps the bucket by default — it holds correspondence, not cache", async () => {
    const { deprovisioner, calls } = teardown({}, ["prod"]);
    await deprovisionSupport(deprovisioner, prod);
    expect(calls).not.toContain("bucket");
  });
});

describe("names", () => {
  test("the worker name is derived per project and environment, never hand-written", () => {
    expect(supportWorkerName("acme", "prod")).toBe("acme-prod-support");
    expect(supportWorkerName("acme", "staging")).toBe("acme-staging-support");
  });

  test("two projects in one account never name the same worker", () => {
    expect(supportWorkerName("acme", "prod")).not.toBe(supportWorkerName("globex", "prod"));
  });

  test("the routing rule name is distinct from the email capability's, and from another project's", () => {
    // `ensureWorkerRoute` keys idempotency on the rule *name*, so a shared one would make whichever
    // capability — or whichever project on the same zone — provisioned second silently believe its rule
    // already existed, and its mail would go to the other one's Worker.
    expect(supportRoutingRuleName("acme")).toBe("acme-global-support-inbound");
    expect(supportRoutingRuleName("acme")).not.toBe(bounceRoutingRuleName("acme"));
    expect(supportRoutingRuleName("acme")).not.toBe(supportRoutingRuleName("globex"));
  });

  test("the worker name comes off core's facade, under the Worker namespace's own limit", () => {
    expect(supportWorkerName("acme", "prod")).toBe(resourceNames("acme").env("prod").worker("support"));
  });

  test("`production` is refused — the old spelling would deploy a second host beside the real one", () => {
    expect(() => supportWorkerName("acme", "production" as never)).toThrowError(/not an environment name/);
  });
});
