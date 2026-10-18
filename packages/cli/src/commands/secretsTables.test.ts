// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { secretTablesDatabase } from "@pithy-sh/secrets/src/tables/database";
import { defineSecretTable } from "@pithy-sh/secrets/src/tables/defineSecretTable";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { resolveWorkerScopes, type WorkerScope } from "../migrations/run";
import { readVaultTables } from "../secretTables/report";
import { expectConforms } from "../test-utils/payloadContract";
import secrets from "./secrets";

/**
 * `pithy secrets tables`: what the vault holds of each declared table, never a value — headless, with the
 * same facts on `--json`. The read is the report's own seam, stubbed; what is held here is the command.
 */

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  projectCloudflareAccount: async () => null,
}));

vi.mock("../migrations/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../migrations/run")>()),
  resolveWorkerScopes: vi.fn(),
}));

vi.mock("../secretTables/report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secretTables/report")>()),
  readVaultTables: vi.fn(),
}));

const CustomerSecrets = defineSecretTable({
  name: "customer",
  keys: { userId: z.string().describe("The user."), organizationId: z.string().describe("The organization.") },
  secrets: {
    STRIPE_KEY: { valueType: "text", rotatable: true },
    WEBHOOK_SIG: { valueType: "text", rotatable: true },
  },
});

function api(declares: boolean): WorkerScope {
  const app = defineCapability({
    name: "app",
    requiredBindings: [],
    ...(declares ? { databases: { secrets: secretTablesDatabase({ tables: [CustomerSecrets] }) } } : {}),
  });
  return { name: "api", dir: join("apps", "api"), capabilities: [app] };
}

const tables = (secrets.subCommands as Record<string, { run?: (input: never) => unknown }>).tables;

async function invoke(args: Record<string, unknown>): Promise<string> {
  const written: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await tables?.run?.({ args: { json: false, ...args } } as never);
  } finally {
    stdout.mockRestore();
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point.
  return written.join("").replace(/\u001b\[[0-9;]*m/g, "");
}

beforeEach(() => {
  vi.mocked(readVaultTables).mockReset();
  vi.mocked(readVaultTables).mockResolvedValue({
    newestKeyVersion: 4,
    tables: [
      {
        table: "customer",
        keys: ["userId", "organizationId"],
        secrets: [
          { name: "STRIPE_KEY", rows: 1204, keyVersions: { "4": 1204 } },
          { name: "WEBHOOK_SIG", rows: 1204, keyVersions: { "3": 2, "4": 1202 } },
        ],
      },
    ],
  });
});

describe("pithy secrets tables", () => {
  test("lists each table, its keys, its secret names, row counts and key versions, then Done.", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(true)]);
    expect(await invoke({ env: "prod" })).toBe(
      [
        "customer  userId, organizationId",
        "  STRIPE_KEY   1204 rows  key v4",
        "  WEBHOOK_SIG  1204 rows  keys v3 2, v4 1202",
        "",
        "2 rows are not on key v4. The last at-rest rotation did not reach them.",
        "",
        "Done.",
        "",
      ].join("\n"),
    );
    expect(vi.mocked(readVaultTables).mock.calls[0]?.[0]).toMatchObject({ env: "prod" });
  });

  test("--json carries the same facts and conforms to the payload", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(true)]);
    const written = await invoke({ env: "prod", json: true });
    expect(JSON.parse(written)).toMatchObject({
      command: "secrets tables",
      env: "prod",
      newestKeyVersion: 4,
      behind: 2,
      tables: [{ table: "customer", worker: "api", state: "migrated" }],
    });
    await expectConforms("secrets tables", written);
  });

  test("a project declaring no table reads no vault", async () => {
    vi.mocked(resolveWorkerScopes).mockResolvedValue([api(false)]);
    expect(await invoke({ env: "prod" })).toBe("No secret tables declared.\n\nDone.\n");
    expect(readVaultTables).not.toHaveBeenCalled();
  });

  test("an environment outside the legal set is refused before anything is read", async () => {
    vi.mocked(resolveWorkerScopes).mockClear();
    const errors: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    try {
      await expect(invoke({ env: "production" })).rejects.toThrow("exit 2");
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
    expect(errors.join("")).toContain("production");
    expect(resolveWorkerScopes).not.toHaveBeenCalled();
  });
});
