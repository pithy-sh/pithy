// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { controlplane } from "@pithy-sh/core/src/controlPlane/capability";
import { describe, expect, test } from "vitest";
import { checkRetention, describeRetention, type RetentionOptions } from "./retention";

const API = { name: "api", dir: "/p/apps/api" };
const plain = { name: "plain" } as Capability;

function options(overrides: Partial<RetentionOptions> = {}): RetentionOptions {
  return {
    environments: ["dev", "staging", "prod"],
    workers: [API],
    account: null,
    remoteSkip: null,
    composeWorker: async () => ({ capabilities: [controlplane()], retention: { audit: { default: "2y" } } }),
    appDatabaseId: async (_dir, env) => `db-${env}`,
    countHolds: async () => 0,
    ...overrides,
  };
}

describe("checkRetention", () => {
  test("reports the effective retention once per Worker, and counts holds in every deployed environment", async () => {
    const asked: string[] = [];
    const check = await checkRetention(
      options({
        countHolds: async (id) => {
          asked.push(id);
          return 0;
        },
      }),
    );
    expect(check.state).toBe("ok");
    expect(check.workers).toHaveLength(1);
    expect(check.workers[0]?.retention?.audit.defaultDays).toBe(730);
    expect(asked).toEqual(["db-staging", "db-prod"]);
    expect(describeRetention(check)).toEqual(["api: no purge window; audit 2y by default; no class ages."]);
  });

  test("a standing hold is named and keeps the report verbose", async () => {
    const check = await checkRetention(options({ countHolds: async (id) => (id === "db-prod" ? 2 : 0) }));
    expect(check.state).toBe("held");
    expect(describeRetention(check)).toContain(
      "prod: api has 2 legal holds standing. No purge, prune or inactivity deletion touches a held subject.",
    );
  });

  test("a block under the floor is a finding, with the refusal the Worker would deploy with", async () => {
    const check = await checkRetention(
      options({
        composeWorker: async () => ({
          capabilities: [controlplane()],
          retention: { audit: { prefixes: { "controlplane/": "30d" } } },
        }),
      }),
    );
    expect(check.state).toBe("findings");
    expect(describeRetention(check)[0]).toMatch(/refused, so it will not deploy\. .*under the kit's floor of 365/);
  });

  test("nothing to say for a Worker with no block and no control plane", async () => {
    const check = await checkRetention(options({ composeWorker: async () => ({ capabilities: [plain] }) }));
    expect(check).toEqual({ state: "not-applicable", workers: [], holds: [] });
  });

  test("a Worker with a block and no control plane is reported, and its holds are never asked", async () => {
    const check = await checkRetention(
      options({ composeWorker: async () => ({ capabilities: [plain], retention: { classAges: { pii: "3y" } } }) }),
    );
    expect(check.state).toBe("ok");
    expect(check.holds).toEqual([]);
    expect(describeRetention(check)).toEqual(["api: no purge window; audit kept forever; inactive past pii 3y."]);
  });

  test("offline, holds are skipped and say so", async () => {
    const check = await checkRetention(options({ remoteSkip: "offline" }));
    expect(check.state).toBe("could-not-check");
    expect(describeRetention(check)).toContain("prod: skipped — offline, so api's holds were not counted.");
  });

  test("an unreadable count and an unprovisioned environment", async () => {
    const check = await checkRetention(
      options({
        appDatabaseId: async (_dir, env) => (env === "staging" ? null : `db-${env}`),
        countHolds: async () => {
          throw new Error("no such table");
        },
      }),
    );
    expect(check.holds.map((answer) => answer.state)).toEqual(["not-provisioned", "unreadable"]);
    expect(check.state).toBe("could-not-check");
    expect(describeRetention(check)).toContain("prod: could not count api's legal holds.");
  });
});
