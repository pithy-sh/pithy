// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkerScripts } from "./resources";
import {
  accountWorkerScripts,
  type ConnectWorkerScripts,
  provisionFollowUp,
  provisionNextEntry,
  undeployedWorkers,
} from "./undeployed";

/**
 * **Which of an environment's Workers no deploy has uploaded (#697)** — the fact `pithy provision`'s `next`
 * turns on. A script is asked for by the name provisioning wrote into the stanza, and an account that could
 * not answer is not an absence: `undefined`, so the run names no deploy it cannot vouch for.
 */

function scripts(deployed: readonly string[]): WorkerScripts {
  return {
    exists: async (name) => deployed.includes(name),
    delete: async () => {
      throw new Error("provisioning never deletes a script");
    },
  };
}

const workers = [
  { worker: "api", name: "acme-staging-api" },
  { worker: "web", name: "acme-staging-web" },
];

describe("undeployedWorkers", () => {
  test("names each script the account does not hold, in the report's order", async () => {
    expect(await undeployedWorkers(workers, scripts([]))).toEqual(["acme-staging-api", "acme-staging-web"]);
    expect(await undeployedWorkers(workers, scripts(["acme-staging-api"]))).toEqual(["acme-staging-web"]);
  });

  test("every script deployed is an empty answer", async () => {
    expect(await undeployedWorkers(workers, scripts(["acme-staging-api", "acme-staging-web"]))).toEqual([]);
  });

  test("no account to ask, or one that refused, is no answer at all", async () => {
    expect(await undeployedWorkers(workers, null)).toBeUndefined();
    const refusing: WorkerScripts = {
      exists: async () => {
        throw new Error("planted: the account is not confirmed");
      },
      delete: async () => {},
    };
    expect(await undeployedWorkers(workers, refusing)).toBeUndefined();
  });
});

/**
 * The run's `next`, from the report and a way to reach the account's scripts. Asked after a provisioning that
 * already succeeded, so every way the question can fail leaves the key absent and never fails the run.
 */
describe("provisionFollowUp", () => {
  test("a Worker no deploy has uploaded names the deploy for the report's environment", async () => {
    const next = await provisionFollowUp({ env: "staging", workers }, async () => scripts(["acme-staging-api"]));
    expect(next).toEqual([
      { command: "pithy deploy --env staging", why: "acme-staging-web is not deployed in staging." },
    ]);
  });

  test("a feature's report names the feature deploy", async () => {
    const feature = [{ worker: "api", name: "acme-12-x-api" }];
    const next = await provisionFollowUp({ env: "feature", workers: feature }, async () => scripts([]));
    expect(next?.map((step) => step.command)).toEqual(["pithy deploy --env feature"]);
  });

  test("every Worker deployed carries no key", async () => {
    const all = async () => scripts(["acme-staging-api", "acme-staging-web"]);
    expect(await provisionFollowUp({ env: "staging", workers }, all)).toBeUndefined();
  });

  test("no credentials, a builder that throws, or an account that refuses, carries no key and does not throw", async () => {
    expect(await provisionFollowUp({ env: "staging", workers }, async () => null)).toBeUndefined();
    expect(
      await provisionFollowUp({ env: "staging", workers }, async () => {
        throw new Error("planted: the clients would not build");
      }),
    ).toBeUndefined();
    const refusing: WorkerScripts = {
      exists: async () => {
        throw new Error("planted: the account is not confirmed");
      },
      delete: async () => {},
    };
    expect(await provisionFollowUp({ env: "staging", workers }, async () => refusing)).toBeUndefined();
  });
});

/** Credentials as the run resolves them: the environment's pair, over an empty config directory. */
function credentials(accountId: string | undefined, apiToken: string | undefined): void {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", accountId);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", apiToken);
}

/**
 * The account's scripts, reached only with both halves of a credential pair. Without one there is nobody to
 * ask, which is `null` — never a throw, because the provisioning it follows has already succeeded.
 */
describe("accountWorkerScripts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test.each([
    ["no credentials", undefined, undefined],
    ["no account id", undefined, "token"],
    ["no API token", "acc", undefined],
  ])("%s is null, and nothing is connected", async (_label, accountId, apiToken) => {
    credentials(accountId, apiToken);
    let connected = 0;
    const connect: ConnectWorkerScripts = async () => {
      connected += 1;
      return scripts([]);
    };
    expect(await accountWorkerScripts(null, connect)).toBeNull();
    expect(connected).toBe(0);
  });

  test("both credentials connect, with what vouches for the account traveling with the id", async () => {
    credentials("acc", "token");
    const asked: Parameters<ConnectWorkerScripts>[0][] = [];
    const reached = scripts(["acme-staging-api"]);
    const answer = await accountWorkerScripts({ accountId: "acc" }, async (account) => {
      asked.push(account);
      return reached;
    });
    expect(answer).toBe(reached);
    expect(asked.map(({ accountId, apiToken }) => ({ accountId, apiToken }))).toEqual([
      { accountId: "acc", apiToken: "token" },
    ]);
    expect(asked[0]?.confirmation).toBeDefined();
  });
});

/**
 * **What both `pithy provision` call sites spread into the report.** Only `--json` carries `next`, so a text
 * run builds nothing and asks the account nothing; under `--json` the key is there exactly when a deploy is
 * owed, for the report's own environment — `feature` for a branch's.
 */
describe("provisionNextEntry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a text run is no entry, and never reaches the account", async () => {
    let built = 0;
    const entry = await provisionNextEntry(
      { env: "staging", workers },
      {
        json: false,
        account: null,
        buildScripts: async () => {
          built += 1;
          return scripts([]);
        },
      },
    );
    expect(entry).toEqual({});
    expect(built).toBe(0);
  });

  test("--json names the deploy for the report's environment, and the feature deploy for a feature's", async () => {
    const declared = await provisionNextEntry(
      { env: "staging", workers },
      { json: true, account: null, buildScripts: async () => scripts(["acme-staging-api"]) },
    );
    expect(declared.next?.map((step) => step.command)).toEqual(["pithy deploy --env staging"]);
    const feature = await provisionNextEntry(
      { env: "feature", workers: [{ name: "acme-12-x-api" }] },
      { json: true, account: null, buildScripts: async () => scripts([]) },
    );
    expect(feature.next?.map((step) => step.command)).toEqual(["pithy deploy --env feature"]);
  });

  test("--json with every Worker deployed carries no key, never an empty one", async () => {
    const entry = await provisionNextEntry(
      { env: "staging", workers },
      { json: true, account: null, buildScripts: async () => scripts(["acme-staging-api", "acme-staging-web"]) },
    );
    expect(entry).toEqual({});
    expect("next" in entry).toBe(false);
  });

  // The default builder, as the command reaches it: with no credentials it is no entry, not a throw.
  test("--json with no credentials carries no key", async () => {
    credentials(undefined, undefined);
    expect(await provisionNextEntry({ env: "staging", workers }, { json: true, account: null })).toEqual({});
  });
});
