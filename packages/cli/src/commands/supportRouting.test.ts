// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeEmailRoutingApi,
  type FakeZone,
  startFakeEmailRoutingApi,
} from "@pithy-sh/cloudflare/src/test-utils/fakeEmailRoutingApi";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { support as supportCapability } from "@pithy-sh/support/src/capability";
import type { CommandDef } from "citty";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms } from "../test-utils/payloadContract";
import support from "./support";

/**
 * **`pithy support provision` routes each environment's inbound address with no routing flag.**
 *
 * The real `provision` and `deprovision` run over a project the real scaffolder built, `--name replay --worker
 * board`, so the Worker deploys as `replay-<env>-board` and neither half of the name stands in for the other. The
 * Cloudflare account is a local fake of the zones and Email Routing endpoints, in the live API's shapes, reached by
 * the real SDK through `CLOUDFLARE_BASE_URL`. Replaced, and only these: the classification-worker deploy and the
 * index and bucket steps, which shell out to wrangler or reach D1 and are not about routing.
 *
 * Each environment's composition reads which environment it is composed for, as a `pithy.config.ts` does with
 * `compositionEnvironment()`, so a different address per environment is the composition's own answer.
 */

const PROJECT = "replay";
const WORKER = "board";

/** The address each environment's composition claims. */
const addresses = vi.hoisted(() => ({ byEnv: {} as Record<string, string[]> }));
const fixture = vi.hoisted(() => ({ dir: "", workerDir: "" }));
/** What the root config claims about the account: `acct-replay` unless a case says nothing is claimed. */
const claim = vi.hoisted(() => ({ account: { accountId: "acct-replay" } as { accountId: string } | null }));

vi.mock("../audit/cliAudit", () => ({ createProjectCliAudit: async () => async () => {} }));

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: PROJECT, environments: ["staging", "prod"] }),
  projectCloudflareAccount: async () => claim.account,
}));

/** The project's one Worker, composed for whichever environment `ENVIRONMENT` names when it is resolved. */
function composedWorker() {
  const env = process.env.ENVIRONMENT ?? "";
  return {
    name: `${PROJECT}-${WORKER}`,
    dir: fixture.workerDir,
    config: {},
    capabilities: [supportCapability({ inboundAddresses: addresses.byEnv[env] ?? [], submission: { enabled: false } })],
    target: {},
  };
}

vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => [composedWorker()],
  resolveSingleWorker: async () => composedWorker(),
}));

vi.mock("../capabilities/supportProvisioner", async (importOriginal) => {
  const real = await importOriginal<typeof import("../capabilities/supportProvisioner")>();
  class Provisioner extends real.CloudflareSupportProvisioner {
    override async preflight() {}
    override async ensureBucket() {
      return { bucket: "replay-global-support", created: false, skipped: false };
    }
    override async deployWorker() {}
    override async ensureSearchIndex() {
      return { created: false, dropped: false, repaired: false };
    }
    override async ensureSemanticIndex(env: ManagedEnvironment) {
      return { indexName: `replay-${env}-support-messages`, created: false };
    }
    override async settleSemanticIndex() {
      return { dropped: false, backfilled: false };
    }
  }
  class Deprovisioner extends real.CloudflareSupportDeprovisioner {
    override async hasWorker() {
      return false;
    }
    override async deleteWorkflows() {}
    override async deleteWorker() {}
  }
  return { ...real, CloudflareSupportProvisioner: Provisioner, CloudflareSupportDeprovisioner: Deprovisioner };
});

const ZONES: FakeZone[] = [
  { id: "zone-example", name: "example.com", routingEnabled: ["help.example.com"] },
  { id: "zone-help-other", name: "other.test", routingEnabled: [] },
];

let api: FakeEmailRoutingApi;

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

async function run(subcommand: "provision" | "deprovision", args: Record<string, unknown>): Promise<Run> {
  const entry = (support.subCommands as Record<string, CommandDef>)[subcommand];
  if (!entry) throw new Error(`expected pithy support ${subcommand}`);
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixture.dir);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error("exited");
  }) as never);
  try {
    await entry.run?.({ args, rawArgs: [] } as never);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "exited") throw error;
  } finally {
    cwd.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  }
  return { stdout: out.join(""), stderr: err.join(""), exitCode };
}

/** The `--json` report of a provision run. */
async function provisionJson(args: Record<string, unknown> = {}) {
  const result = await run("provision", { json: true, ...args });
  expect(result.stderr).toBe("");
  await expectConforms("support provision", result.stdout);
  return JSON.parse(result.stdout) as Record<string, unknown> & { inboundRoutes: Record<string, unknown>[] };
}

/** The routing rules a zone holds, without the catch-all every zone carries. */
function rulesOn(zoneId: string) {
  return (api.rules.get(zoneId) ?? []).filter((rule) => rule.name !== "");
}

function writes(): string[] {
  return api.requests.filter((request) => !request.startsWith("GET "));
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "pithy-support-routing-"));
  await scaffoldProject({ targetDir: dir, appName: PROJECT, worker: WORKER });
  await linkKitPackages(dir, ["support"]);
  const workerDir = join(dir, "apps", WORKER);
  const config = (await readWranglerConfig(workerDir)) as {
    env: Record<string, { d1_databases?: unknown[] }>;
  };
  for (const env of ["staging", "prod"]) {
    const stanza = config.env[env];
    if (stanza) stanza.d1_databases = [{ binding: "DB", database_id: `db-${env}` }];
  }
  await writeWranglerConfig(workerDir, config);
  fixture.dir = dir;
  fixture.workerDir = workerDir;
});

beforeEach(async () => {
  api = await startFakeEmailRoutingApi({ accountId: "acct-replay", zones: ZONES });
  vi.stubEnv("CLOUDFLARE_BASE_URL", api.baseUrl);
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-replay");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-replay");
  vi.stubEnv("PITHY_CONFIG_DIR", await mkdtemp(join(tmpdir(), "pithy-support-routing-config-")));
  claim.account = { accountId: "acct-replay" };
  addresses.byEnv = {
    staging: ["staging@help.example.com"],
    prod: ["support@help.example.com"],
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await api.close();
});

describe("pithy support provision, with no routing flag", () => {
  test("routes each environment's own address to its own Worker, on the parent zone", async () => {
    const report = await provisionJson();
    expect(report.inboundRoutes).toEqual([
      {
        env: "staging",
        address: "staging@help.example.com",
        zone: "example.com",
        zoneId: "zone-example",
        worker: "replay-staging-board",
        outcome: "created",
        reason: null,
      },
      {
        env: "prod",
        address: "support@help.example.com",
        zone: "example.com",
        zoneId: "zone-example",
        worker: "replay-prod-board",
        outcome: "created",
        reason: null,
      },
    ]);
    expect(rulesOn("zone-example").map((rule) => [rule.name, rule.matchers, rule.actions])).toEqual([
      [
        "replay-staging-support-inbound",
        [{ type: "literal", field: "to", value: "staging@help.example.com" }],
        [{ type: "worker", value: ["replay-staging-board"] }],
      ],
      [
        "replay-prod-support-inbound",
        [{ type: "literal", field: "to", value: "support@help.example.com" }],
        [{ type: "worker", value: ["replay-prod-board"] }],
      ],
    ]);
    // Read-only towards Email Routing itself: the only writes are the two rules.
    expect(writes()).toEqual([
      "POST /client/v4/zones/zone-example/email/routing/rules",
      "POST /client/v4/zones/zone-example/email/routing/rules",
    ]);
  });

  test("a second run changes nothing and says so", async () => {
    await run("provision", {});
    api.requests.length = 0;
    const second = await run("provision", {});
    expect(writes()).toEqual([]);
    expect(second.stdout).toContain(
      "staging: staging@help.example.com already routes to replay-staging-board, on example.com.",
    );
    expect(second.stdout).toContain(
      "prod: support@help.example.com already routes to replay-prod-board, on example.com.",
    );
    expect(second.exitCode).toBeUndefined();
  });

  test("refuses an environment whose domain Email Routing is off, names it, and still routes the others", async () => {
    addresses.byEnv.staging = ["staging@mail.example.com"];
    const report = await provisionJson();
    expect(report.inboundRoutes[0]).toMatchObject({ env: "staging", zone: "example.com", outcome: "refused" });
    expect(String(report.inboundRoutes[0]?.reason)).toContain("Email Routing is not enabled for mail.example.com.");
    expect(report.inboundRoutes[1]).toMatchObject({ env: "prod", outcome: "created" });
    expect(rulesOn("zone-example").map((rule) => rule.name)).toEqual(["replay-prod-support-inbound"]);
    expect(writes().some((request) => request.includes("/dns") || request.endsWith("/email/routing"))).toBe(false);
  });

  test("refuses an address whose domain is in no zone on the account, naming the domain", async () => {
    addresses.byEnv.prod = ["support@help.nowhere.test"];
    const report = await provisionJson();
    expect(report.inboundRoutes[1]).toMatchObject({ env: "prod", zone: null, zoneId: null, outcome: "refused" });
    expect(String(report.inboundRoutes[1]?.reason)).toContain(
      "No zone on this Cloudflare account holds help.nowhere.test.",
    );
  });

  test("skips an environment whose composition claims no address", async () => {
    addresses.byEnv.staging = [];
    const report = await provisionJson();
    expect(report.inboundRoutes[0]).toMatchObject({ env: "staging", address: null, outcome: "skipped" });
    expect(report.inboundRoutes[1]).toMatchObject({ env: "prod", outcome: "created" });
  });

  test("refuses one address two environments both claim, rather than sending it to either", async () => {
    addresses.byEnv.staging = ["support@help.example.com"];
    const report = await provisionJson();
    expect(report.inboundRoutes.map((route) => route.outcome)).toEqual(["refused", "refused"]);
    expect(rulesOn("zone-example")).toEqual([]);
  });

  test("updates a rule for the address that sends it to another Worker", async () => {
    await api.close();
    api = await startFakeEmailRoutingApi({
      accountId: "acct-replay",
      zones: ZONES,
      rules: {
        "zone-example": [
          {
            id: "old",
            name: "replay-global-support-inbound",
            enabled: true,
            matchers: [{ type: "literal", field: "to", value: "support@help.example.com" }],
            actions: [{ type: "worker", value: ["replay-board-prod"] }],
          },
        ],
      },
    });
    vi.stubEnv("CLOUDFLARE_BASE_URL", api.baseUrl);
    const report = await provisionJson();
    expect(report.inboundRoutes[1]).toMatchObject({ env: "prod", outcome: "updated", worker: "replay-prod-board" });
    expect(rulesOn("zone-example").find((rule) => rule.id === "old")?.actions).toEqual([
      { type: "worker", value: ["replay-prod-board"] },
    ]);
  });
});

describe("an account the project does not claim", () => {
  test("provision makes no rule on it, and says why", async () => {
    claim.account = null;
    const report = await provisionJson();
    expect(report.inboundRoutes.map((route) => route.outcome)).toEqual(["refused", "refused"]);
    expect(String(report.inboundRoutes[0]?.reason)).toContain("Nothing states that Cloudflare account acct-replay");
    expect(writes()).toEqual([]);
  });

  test("deprovision deletes nothing on it", async () => {
    await run("provision", {});
    claim.account = null;
    api.requests.length = 0;
    const result = await run("deprovision", { json: true, env: "staging", storage: false });
    expect(JSON.parse(result.stderr).error.code).toBe("core/conflict");
    expect(writes()).toEqual([]);
    expect(rulesOn("zone-example")).toHaveLength(2);
  });
});

describe("pithy support provision, with the three routing flags", () => {
  const flags = {
    "routing-zone": "zone-example",
    "inbound-address": "support@help.example.com",
    "app-worker": "replay-board-live",
  };

  test("creates exactly the rule they describe, and derives nothing", async () => {
    const report = await provisionJson(flags);
    expect(report.inboundRoutes).toEqual([
      {
        env: null,
        address: "support@help.example.com",
        zone: null,
        zoneId: "zone-example",
        worker: "replay-board-live",
        outcome: "created",
        reason: null,
      },
    ]);
    expect(rulesOn("zone-example").map((rule) => [rule.name, rule.actions])).toEqual([
      ["replay-global-support-inbound", [{ type: "worker", value: ["replay-board-live"] }]],
    ]);
  });

  test("a partial set is still refused", async () => {
    const result = await run("provision", { json: true, "routing-zone": "zone-example" });
    expect(JSON.parse(result.stderr).error.message).toBe("The inbound routing options are incomplete.");
    expect(writes()).toEqual([]);
  });
});

describe("pithy support deprovision --env", () => {
  test("removes that environment's rule only", async () => {
    await run("provision", {});
    const result = await run("deprovision", { json: true, env: "staging", storage: false });
    await expectConforms("support deprovision", result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.inboundRoutes).toEqual([
      {
        env: "staging",
        address: "staging@help.example.com",
        zone: "example.com",
        worker: "replay-staging-board",
        outcome: "removed",
        reason: null,
      },
    ]);
    expect(rulesOn("zone-example").map((rule) => rule.name)).toEqual(["replay-prod-support-inbound"]);
  });
});
