// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import type { EnvInventory, EnvInventoryOptions, WorkerEnvironments } from "../project/envInventory";

/**
 * The options every `buildEnvInventory` call was handed. Held in a hoisted box rather than a `vi.fn`
 * because `loadEnv` calls `vi.resetModules()`, which re-runs the factory and would hand each test a
 * fresh spy the assertions could not see.
 */
const built = vi.hoisted(() => ({ calls: [] as unknown[] }));

/** The account the stubbed project names — a nickname *and* a pin, so both halves are asserted. */
const ACCOUNT: CloudflareAccountSelection = { accountName: "leed", accountId: "acct-leed" };

vi.mock("../project/envInventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/envInventory")>()),
  buildEnvInventory: async (options: unknown) => {
    built.calls.push(options);
    return { accountId: "acct-leed", workers: [] } satisfies EnvInventory;
  },
}));

// Only the account resolution is stubbed; `projectCloudflareAccount` is the one source of a value, and
// this stands in for a root `pithy.config.ts` that names one.
vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  projectCloudflareAccount: async () => ACCOUNT,
}));

/**
 * `renderEnvInventory` reads the color/hyperlink seam, which latches its `enabled` flag once at
 * import. Re-import the command module per test under a stubbed env so we can exercise both the
 * link path (FORCE_COLOR) and the plain-URL fallback (NO_COLOR).
 */
async function loadEnv(env: Record<string, string | undefined>): Promise<typeof import("./env")> {
  vi.resetModules();
  for (const key of ["NO_COLOR", "FORCE_COLOR", "COLORTERM"]) vi.stubEnv(key, env[key]);
  return await import("./env");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The default single-Worker fixture: `api`, one dev environment with a provisioned D1 and an absent KV. */
function apiWorker(): WorkerEnvironments {
  return {
    worker: "api",
    dir: "apps/api",
    environments: [
      {
        name: "dev",
        local: true,
        scriptName: "pithy-app",
        baseUrl: "local",
        workerDashboardUrl: null,
        resources: [
          {
            kind: "d1",
            binding: "DB",
            id: "db-uuid",
            provisioned: true,
            dashboardUrl: "https://dash.cloudflare.com/acct-9/workers/d1/databases/db-uuid/metrics",
          },
          { kind: "kv", binding: "SESSIONS", id: null, provisioned: false, dashboardUrl: null },
        ],
      },
      // A deployed environment with the same absent binding. Both are in one fixture on purpose: the
      // point of #320 is that these two must not read the same, and a fixture holding only one of them
      // cannot say so.
      {
        name: "staging",
        local: false,
        scriptName: "pithy-app-staging",
        baseUrl: "https://staging.example.com",
        workerDashboardUrl: null,
        resources: [{ kind: "kv", binding: "SESSIONS", id: null, provisioned: false, dashboardUrl: null }],
      },
    ],
  };
}

function inventory(overrides: Partial<EnvInventory> = {}): EnvInventory {
  return { accountId: "acct-9", workers: [apiWorker()], ...overrides };
}

describe("env command", () => {
  test("meta and args shape", async () => {
    const { default: env } = await loadEnv({});
    const args = env.args as Record<string, { type: string; default?: unknown; required?: boolean }>;
    expect(env.meta).toMatchObject({ name: "env" });
    expect(Object.keys(args)).toEqual(["name", "worker", "json"]);
    expect(args.name).toMatchObject({ type: "positional", required: false });
    expect(args.worker).toMatchObject({ type: "string" });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });

  /**
   * **`pithy env` prints an account id, so it had better be this project's (#226).**
   *
   * The inventory labels every binding with the account its resources live under. Resolved without a
   * selection it reads `<config>/cloudflare.json` — the default file — so a project whose root
   * `pithy.config.ts` names `cloudflare.accountName` had its bindings reported under another company's
   * account, with dashboard links pointing there. No name, no pin, no refusal: the exact state #206
   * exists to prevent, reached because the parameter was optional and omitting it compiled.
   */
  test("hands the inventory the account the project names, rather than letting it reach the default file", async () => {
    built.calls.length = 0;
    const { default: env } = await loadEnv({ NO_COLOR: "1" });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await env.run?.({ args: { json: true }, rawArgs: [] } as never);
    } finally {
      stdout.mockRestore();
    }
    expect(built.calls).toHaveLength(1);
    expect((built.calls[0] as EnvInventoryOptions).account).toEqual(ACCOUNT);
  });
});

describe("renderEnvInventory", () => {
  test("renders a provisioned id as an OSC-8 hyperlink when hyperlinks are on", async () => {
    const { renderEnvInventory } = await loadEnv({ FORCE_COLOR: "1" });
    const out = renderEnvInventory(inventory());
    expect(out).toContain(
      "\x1b]8;;https://dash.cloudflare.com/acct-9/workers/d1/databases/db-uuid/metrics\x1b\\db-uuid\x1b]8;;\x1b\\",
    );
    // The action item, and only where it is one. A deployed environment missing its resource is
    // something to go and do; the same words on a local one taught an operator to skim past red.
    expect(out).toContain("not provisioned");
  });

  test("falls back to a printed URL when hyperlinks are off", async () => {
    const { renderEnvInventory } = await loadEnv({ NO_COLOR: "1" });
    const out = renderEnvInventory(inventory());
    expect(out).not.toContain("\x1b]8;;");
    expect(out).toContain("db-uuid  https://dash.cloudflare.com/acct-9/workers/d1/databases/db-uuid/metrics");
  });

  test("omits links and notes the missing account id", async () => {
    const { renderEnvInventory } = await loadEnv({ NO_COLOR: "1" });
    const noAcct = inventory({
      accountId: null,
      workers: [
        {
          worker: "api",
          dir: "apps/api",
          environments: [
            {
              name: "dev",
              local: true,
              scriptName: "pithy-app",
              baseUrl: "local",
              workerDashboardUrl: null,
              resources: [{ kind: "d1", binding: "DB", id: "db-uuid", provisioned: true, dashboardUrl: null }],
            },
          ],
        },
      ],
    });
    const out = renderEnvInventory(noAcct);
    expect(out).toContain("No CLOUDFLARE_ACCOUNT_ID. Dashboard links omitted.");
    expect(out).not.toContain("dash.cloudflare.com");
  });

  test("a filter narrows to a single environment", async () => {
    const { renderEnvInventory } = await loadEnv({ NO_COLOR: "1" });
    const inv = inventory({
      workers: [
        {
          worker: "api",
          dir: "apps/api",
          environments: [
            {
              name: "dev",
              local: true,
              scriptName: "pithy-app",
              baseUrl: "local",
              workerDashboardUrl: null,
              resources: [],
            },
            {
              name: "prod",
              local: false,
              scriptName: "pithy-app-prod",
              baseUrl: "https://api.example.com",
              workerDashboardUrl: null,
              resources: [],
            },
          ],
        },
      ],
    });
    const out = renderEnvInventory(inv, "prod");
    expect(out).toContain("prod");
    expect(out).toContain("https://api.example.com");
    expect(out).not.toContain("\n  dev  ");
  });

  test("an unknown filter name is reported, not thrown", async () => {
    const { renderEnvInventory } = await loadEnv({ NO_COLOR: "1" });
    const out = renderEnvInventory(inventory(), "nope");
    expect(out).toContain("No environment named nope.");
  });
});

describe("renderEnvInventory — per worker", () => {
  test("each worker heads its own block, its environments and bindings nested beneath", async () => {
    const { renderEnvInventory } = await loadEnv({ NO_COLOR: "1" });
    const inv = inventory({
      workers: [
        apiWorker(),
        {
          worker: "collab",
          dir: "apps/collab",
          environments: [
            {
              name: "dev",
              local: true,
              scriptName: "collab",
              baseUrl: "local",
              workerDashboardUrl: null,
              resources: [{ kind: "kv", binding: "PRESENCE", id: "ns-2", provisioned: true, dashboardUrl: null }],
            },
          ],
        },
      ],
    });
    const lines = renderEnvInventory(inv).trimEnd().split("\n");
    expect(lines).toEqual([
      "api  apps/api",
      "  dev  local",
      "    worker  pithy-app",
      "    DB (d1)  db-uuid  https://dash.cloudflare.com/acct-9/workers/d1/databases/db-uuid/metrics",
      // `local`, not `not provisioned`. There is no remote `dash-dev-db` and there is not supposed to
      // be one — Miniflare serves this binding from its own declaration (#320).
      "    SESSIONS (kv)  local",
      "  staging  https://staging.example.com",
      "    worker  pithy-app-staging",
      // The same binding, absent in both. Only the deployed one is an action item.
      "    SESSIONS (kv)  not provisioned",
      "collab  apps/collab",
      "  dev  local",
      "    worker  collab",
      "    PRESENCE (kv)  ns-2",
    ]);
  });

  test("a worker with no matching environment is reported, not dropped from the report", async () => {
    const { renderEnvInventory } = await loadEnv({ NO_COLOR: "1" });
    const inv = inventory({
      workers: [
        {
          worker: "api",
          dir: "apps/api",
          environments: [
            {
              name: "staging",
              local: false,
              scriptName: "api-staging",
              baseUrl: null,
              workerDashboardUrl: null,
              resources: [],
            },
          ],
        },
        apiWorker(),
      ],
    });
    const out = renderEnvInventory(inv, "dev");
    expect(out).toContain("api  apps/api\n  No environment named dev.");
    expect(out).toContain("  dev  local");
  });
});
