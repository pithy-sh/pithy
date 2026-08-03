// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import type { EnvInventory, WorkerEnvironments } from "../project/envInventory";

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
});

describe("renderEnvInventory", () => {
  test("renders a provisioned id as an OSC-8 hyperlink when hyperlinks are on", async () => {
    const { renderEnvInventory } = await loadEnv({ FORCE_COLOR: "1" });
    const out = renderEnvInventory(inventory());
    expect(out).toContain(
      "\x1b]8;;https://dash.cloudflare.com/acct-9/workers/d1/databases/db-uuid/metrics\x1b\\db-uuid\x1b]8;;\x1b\\",
    );
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
            { name: "dev", scriptName: "pithy-app", baseUrl: "local", workerDashboardUrl: null, resources: [] },
            {
              name: "prod",
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
