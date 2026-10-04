// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { SEARCH_OBJECTS, SEARCH_TRIGGERS, searchIndexState } from "@pithy-sh/support/src/store/searchIndex";
import { describe, expect, test, vi } from "vitest";
import {
  checkSupportSearchTriggers,
  describeSupportSearchTriggers,
  type SupportSearchTriggersOptions,
} from "./supportSearchTriggers";

/**
 * The check that turns this release's one silent failure into a reported one.
 *
 * An adopter who upgrades and deploys without re-running `pithy support provision` has a provisioned
 * `pithy_support_search` and no triggers: the write paths' `indexMessage` calls are gone, nothing
 * created the triggers, and **nothing fails**. Messages are stored, readable, and absent from the
 * search box. That is the shape this repository keeps paying for — a declared-but-never-synced
 * Workflow, an unapplied migration — so it gets the same answer: a `pithy doctor` line naming the
 * command.
 *
 * Every seam is injected here, and `SEARCH_OBJECTS` comes from the capability itself rather than from a
 * fixture: a doctor that asked about a name the provisioner does not create would report drift nothing
 * could clear.
 */

/** A capability that is support, as `isSupportCapability` narrows one. */
function support(fts: boolean): Capability {
  return { name: "support", supportConfig: { search: { fts } } } as unknown as Capability;
}

/** A capability that is not. */
const auth = { name: "auth" } as unknown as Capability;

/** The options under test, with every seam a fake. */
function options(overrides: Partial<SupportSearchTriggersOptions> = {}): SupportSearchTriggersOptions {
  return {
    projectDir: "/project",
    environments: ["staging", "prod"],
    workers: [{ name: "api", dir: "/project/apps/api" }],
    account: null,
    remoteSkip: null,
    composeWorker: async () => ({ capabilities: [auth, support(true)] }),
    appDatabaseId: async () => "db-1",
    readSearchObjects: async () => [...SEARCH_OBJECTS],
    // The capability's own reading of its own names. A fixture here could agree with a doctor that
    // disagreed with the provisioner, which is the one way this check could be wrong and look right.
    loadSearchIndex: async () => ({ SEARCH_OBJECTS, searchIndexState }),
    ...overrides,
  };
}

describe("checkSupportSearchTriggers", () => {
  test("a project that composes no support has no question to answer", async () => {
    const readSearchObjects = vi.fn();
    const check = await checkSupportSearchTriggers(
      options({ composeWorker: async () => ({ capabilities: [auth] }), readSearchObjects }),
    );

    expect(check.state).toBe("not-applicable");
    expect(check.environments).toEqual([]);
    expect(readSearchObjects).not.toHaveBeenCalled();
    expect(describeSupportSearchTriggers(check)).toEqual([]);
  });

  test("search.fts off reaches no database at all", async () => {
    // **The second half of the clean-project criterion.** A project with the flag off has no index and
    // wants none, so there is nothing to compare and nothing worth a round trip — which is also what
    // makes this check free and silent on every project that never turned search on.
    const readSearchObjects = vi.fn();
    const check = await checkSupportSearchTriggers(
      options({ composeWorker: async () => ({ capabilities: [support(false)] }), readSearchObjects }),
    );

    expect(check.state).toBe("not-applicable");
    expect(readSearchObjects).not.toHaveBeenCalled();
    expect(describeSupportSearchTriggers(check)).toEqual([]);
  });

  test("a re-provisioned project reads clean, with a line for nobody", async () => {
    const check = await checkSupportSearchTriggers(options());

    expect(check.state).toBe("ok");
    expect(check.environments.map((entry) => [entry.env, entry.state])).toEqual([
      ["staging", "ok"],
      ["prod", "ok"],
    ]);
    expect(describeSupportSearchTriggers(check)).toEqual([]);
  });

  test("a provisioned table with no triggers is drift, per environment, and names the fix", async () => {
    const check = await checkSupportSearchTriggers(
      options({
        readSearchObjects: async ({ databaseId }) =>
          databaseId === "prod-db" ? ["pithy_support_search"] : [...SEARCH_OBJECTS],
        appDatabaseId: async (_dir, env) => (env === "prod" ? "prod-db" : "staging-db"),
      }),
    );

    expect(check.state).toBe("findings");
    expect(check.environments.find((entry) => entry.env === "prod")).toEqual({
      env: "prod",
      worker: "api",
      state: "drift",
      triggers: "none",
    });
    const lines = describeSupportSearchTriggers(check);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("prod");
    expect(lines[0]).toContain("pithy support provision");
  });

  test("half a trigger set is drift too, and the line says which half is missing is not the point", async () => {
    const check = await checkSupportSearchTriggers(
      options({ readSearchObjects: async () => ["pithy_support_search", SEARCH_TRIGGERS[0]] }),
    );

    expect(check.state).toBe("findings");
    expect(check.environments.every((entry) => entry.state === "drift")).toBe(true);
    expect(describeSupportSearchTriggers(check).every((line) => line.includes("some of its triggers"))).toBe(true);
  });

  test("triggers left behind without their table is drift, and the line says writes abort", async () => {
    // The worst state this check can meet, and the one `state: "ok"` used to swallow. A trigger body
    // inserts into `pithy_support_search`; with the table gone the insert raises `no such table`, and
    // under this issue's contract that abort takes the message write down with it. So every reply and
    // every inbound message fails, and the pair that must never separate has separated. A hand-dropped
    // table, a half-finished provision or a restored D1 backup all land here. Reporting it `ok` is the
    // one answer that cannot be right. Distinct from no index at all, which stays `ok` by design.
    const check = await checkSupportSearchTriggers(options({ readSearchObjects: async () => [...SEARCH_TRIGGERS] }));

    expect(check.state).toBe("findings");
    expect(check.environments.every((entry) => entry.state === "orphaned-triggers")).toBe(true);
    const lines = describeSupportSearchTriggers(check);
    expect(lines.every((line) => line.includes("every message write fails"))).toBe(true);
    expect(lines.every((line) => line.includes("pithy support provision"))).toBe(true);
  });

  test("an environment with no app database says so, and is never read", async () => {
    const readSearchObjects = vi.fn(async () => [...SEARCH_OBJECTS]);
    const check = await checkSupportSearchTriggers(
      options({ appDatabaseId: async (_dir, env) => (env === "prod" ? null : "staging-db"), readSearchObjects }),
    );

    expect(check.environments.find((entry) => entry.env === "prod")?.state).toBe("not-provisioned");
    expect(readSearchObjects).toHaveBeenCalledTimes(1);
    expect(describeSupportSearchTriggers(check)).toEqual([
      "prod: not provisioned — env.prod has no DB database_id, so there is no index to check.",
    ]);
  });

  test("an offline run says it skipped rather than reading clean", async () => {
    // **The criterion this test exists for.** A skipped remote read that printed nothing would be
    // indistinguishable from a healthy project, which is the failure every other skip in this report is
    // written to avoid.
    const readSearchObjects = vi.fn();
    const check = await checkSupportSearchTriggers(options({ remoteSkip: "offline", readSearchObjects }));

    expect(check.state).toBe("could-not-check");
    expect(check.environments.every((entry) => entry.state === "skipped")).toBe(true);
    expect(readSearchObjects).not.toHaveBeenCalled();
    expect(describeSupportSearchTriggers(check)).toEqual([
      "staging: skipped — offline, so no index was read.",
      "prod: skipped — offline, so no index was read.",
    ]);
  });

  test("a run with no Cloudflare credentials says that, not offline", async () => {
    const check = await checkSupportSearchTriggers(options({ remoteSkip: "no-credentials" }));

    expect(check.state).toBe("could-not-check");
    expect(describeSupportSearchTriggers(check)[0]).toBe(
      "staging: skipped — no Cloudflare credentials, so no index was read.",
    );
  });

  test("a read that throws is unreadable, never clean, and carries none of what it caught", async () => {
    // A D1 read throws with ids and queries in it (#350), so the guard keeps the fact and not the text.
    const check = await checkSupportSearchTriggers(
      options({
        readSearchObjects: async () => {
          throw new Error("D1_ERROR: database 00000000-aaaa-bbbb-cccc-000000000000 unavailable");
        },
      }),
    );

    expect(check.state).toBe("could-not-check");
    expect(check.environments.every((entry) => entry.state === "unreadable")).toBe(true);
    const lines = describeSupportSearchTriggers(check);
    expect(lines[0]).toBe("staging: could not be read, so whether the index has its triggers is unknown.");
    expect(lines.join("\n")).not.toContain("00000000-aaaa");
  });

  test("drift beside a skip is still a finding, and both lines are printed", async () => {
    // The states compose: one environment answered and drifting, one never reached. Collapsing to the
    // worse verdict would be right about the exit and wrong about the report.
    const check = await checkSupportSearchTriggers(
      options({
        environments: ["staging", "prod"],
        appDatabaseId: async (_dir, env) => (env === "prod" ? null : "staging-db"),
        readSearchObjects: async () => ["pithy_support_search"],
      }),
    );

    expect(check.state).toBe("findings");
    expect(describeSupportSearchTriggers(check)).toHaveLength(2);
  });

  test("a Worker whose config will not compose costs that environment its answer, not a clean one", async () => {
    const check = await checkSupportSearchTriggers(
      options({
        composeWorker: async (_worker, env) => {
          if (env === "prod") throw new Error("pithy.config.ts threw");
          return { capabilities: [support(true)] };
        },
      }),
    );

    expect(check.state).toBe("could-not-check");
    expect(check.environments.find((entry) => entry.env === "prod")?.state).toBe("not-composed");
    expect(describeSupportSearchTriggers(check)).toEqual([
      "prod: pithy.config.ts did not compose for prod, so no index was read.",
    ]);
  });

  test("the only names asked about are the capability's own", async () => {
    const seen: string[][] = [];
    await checkSupportSearchTriggers(
      options({
        readSearchObjects: async ({ names }) => {
          seen.push([...names]);
          return [...SEARCH_OBJECTS];
        },
      }),
    );

    expect(seen).toEqual([[...SEARCH_OBJECTS], [...SEARCH_OBJECTS]]);
  });
});
