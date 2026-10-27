// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { IntegrationCreds } from "./harness";
import { type ReapPlanEntry, reapArtifactsNamespace, reapKinds, reapPlanLabels, testResourceReapPlan } from "./reap";

/**
 * Unit coverage for the reap registry. The point of the registry is that reaping is a property of the
 * *run*, not of whichever suite happens to own a resource kind — so what is worth pinning here is that
 * every kind is enumerated, that a kind missing its credential is reported rather than dropped, and that
 * one kind's failure cannot take the rest of the sweep down with it.
 */

const CREDS: IntegrationCreds = {
  accountId: "acct",
  apiToken: "token",
  secretsStoreId: "store",
  r2: { accessKeyId: "key", secretAccessKey: "secret" },
  hasCreds: true,
};

/** A plan entry that reaps a fixed list, recording what it was asked to remove. */
function fakeKind(label: string, names: string[], removed: string[]): ReapPlanEntry {
  return {
    label,
    list: async () => names,
    remove: async (name) => {
      removed.push(name);
    },
  };
}

describe("testResourceReapPlan", () => {
  test("enumerates every reapable kind, so a new suite inherits cleanup rather than arranging it", () => {
    const labels = reapPlanLabels(testResourceReapPlan(CREDS, { emailRoutingZoneId: "zone" }));
    // The kinds any `uniqueName` call can mint. A kind absent here is a kind that leaks forever.
    expect(labels).toEqual([
      "API token",
      "Artifacts namespace",
      "D1 database",
      "Email Routing rule",
      "KV namespace",
      "Queue",
      "R2 bucket",
      "Secrets Store entry",
      "Vectorize index",
      "Worker script",
    ]);
  });

  test("reports a kind whose credential is absent instead of silently omitting it", () => {
    const plan = testResourceReapPlan({ ...CREDS, r2: null, secretsStoreId: "" });
    const skipped = plan.filter((entry) => "skipped" in entry).map((entry) => entry.label);
    // Both kinds still appear — a missing credential must read as "not reaped, and here is why",
    // never as "nothing to reap". Silence is how the eight orphaned secrets went unnoticed.
    expect(skipped).toEqual(["Email Routing rule", "R2 bucket", "Secrets Store entry"]);
    expect(reapPlanLabels(plan)).toHaveLength(10);
  });

  test("names the credential a skipped kind is waiting on", () => {
    const plan = testResourceReapPlan({ ...CREDS, secretsStoreId: "" });
    const entry = plan.find((candidate) => candidate.label === "Secrets Store entry");
    expect(entry && "skipped" in entry ? entry.skipped : null).toContain("SECRETS_STORE_ID");
  });

  test("a run told no zone sweeps no routing rule, rather than guessing which zone it may edit", () => {
    // Every other kind is account-scoped, so the credentials decide what may be touched. This one edits
    // mail delivery on a domain, and the only thing allowed to name that domain is the fixture.
    const entry = testResourceReapPlan(CREDS).find((candidate) => candidate.label === "Email Routing rule");
    expect(entry && "skipped" in entry ? entry.skipped : null).toContain("EMAIL_ROUTING_ZONE_ID");
  });
});

describe("reapKinds", () => {
  const now = 1_800_000_000_000;
  const stale = `pithy-int-kv-${now - 24 * 60 * 60 * 1000}-1-aaaaaa`;
  const fresh = `pithy-int-kv-${now - 1000}-1-bbbbbb`;

  test("removes only stale debris, leaving a resource a running suite may still own", async () => {
    const removed: string[] = [];
    const results = await reapKinds([fakeKind("KV namespace", [stale, fresh, "customer-prod-cache"], removed)], {
      now,
    });

    expect(removed).toEqual([stale]);
    expect(results).toEqual([{ label: "KV namespace", reaped: [stale], failed: [], skipped: null }]);
  });

  test("carries a skipped kind through to the report", async () => {
    const results = await reapKinds([{ label: "R2 bucket", skipped: "no R2_CREDENTIALS" }], { now });
    expect(results).toEqual([{ label: "R2 bucket", reaped: [], failed: [], skipped: "no R2_CREDENTIALS" }]);
  });

  test("one kind's failure does not stop the sweep", async () => {
    const removed: string[] = [];
    const results = await reapKinds(
      [
        {
          label: "D1 database",
          list: async () => {
            throw new Error("403");
          },
          remove: async () => undefined,
        },
        fakeKind("KV namespace", [stale], removed),
      ],
      { now },
    );

    // The failing kind reports nothing rather than throwing, and the healthy kind still ran.
    expect(results[0]).toEqual({ label: "D1 database", reaped: [], failed: [], skipped: null });
    expect(removed).toEqual([stale]);
  });

  test("a removal that fails is reported, not swallowed", async () => {
    const results = await reapKinds(
      [
        {
          label: "Secrets Store entry",
          list: async () => [stale],
          remove: async () => {
            throw new Error("still referenced");
          },
        },
      ],
      { now },
    );
    expect(results[0]).toEqual({ label: "Secrets Store entry", reaped: [], failed: [stale], skipped: null });
  });
});

describe("reapArtifactsNamespace", () => {
  /** A namespace holding `repos`, whose delete answers `answer` once they are gone. */
  function namespaces(repos: string[], answer: "deleted" | "absent" | "occupied") {
    const calls: string[] = [];
    return {
      calls,
      artifacts: {
        listRepos: async (namespace: string) => {
          calls.push(`list ${namespace}`);
          return repos;
        },
        deleteRepo: async (namespace: string, repo: string) => {
          calls.push(`delete ${namespace}/${repo}`);
          return true;
        },
        deleteNamespace: async (namespace: string) => {
          calls.push(`delete ${namespace}`);
          return answer;
        },
      },
    };
  }

  test("deletes every repository, then the namespace, since Cloudflare refuses one that still holds a repo", async () => {
    const { calls, artifacts } = namespaces(["a", "b"], "deleted");
    await reapArtifactsNamespace(artifacts, "pithy-int-ns");
    expect(calls).toEqual([
      "list pithy-int-ns",
      "delete pithy-int-ns/a",
      "delete pithy-int-ns/b",
      "delete pithy-int-ns",
    ]);
  });

  test("a namespace already gone is reaped, so another runner's sweep reaching it first is no failure", async () => {
    await expect(reapArtifactsNamespace(namespaces([], "absent").artifacts, "pithy-int-ns")).resolves.toBeUndefined();
  });

  test("a namespace still occupied throws, so it is reported as not reaped and the next run tries again", async () => {
    await expect(reapArtifactsNamespace(namespaces(["a"], "occupied").artifacts, "pithy-int-ns")).rejects.toThrow(
      /still holds a repository/,
    );
  });
});
