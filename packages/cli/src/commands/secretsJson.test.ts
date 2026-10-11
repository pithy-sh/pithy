// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SecretBackend } from "@pithy-sh/secrets/src/registry";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MintedSecret } from "../capabilities/mintSecrets";
import { contractAt, expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * **What `pithy secrets provision` and `pithy secrets edit` write under `--json`, held to the schemas
 * `pithy schema secrets` publishes (#697).**
 *
 * The writes, the rotation and the listing run from the real binary against a fake Workflows API in
 * `secretsRotate.e2e.test.ts`; `verify` is held in `capabilities/verifySecrets.test.ts` and `deprovision` in
 * `teardowns.test.ts`. These two reach further than a fake can follow — every manager deployed, a Secrets
 * Store listed, an editor opened — so each of those parts is replaced with what it returns, and the command
 * between them is the real one.
 */

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  projectCloudflareAccount: async () => null,
  projectEnvironments: async () => ["staging", "prod"],
}));
vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => ({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token", SECRETS_STORE_ID: "store" }),
  cloudflareAccountConfirmation: () => ({ source: "test" }),
}));
vi.mock("../cloudflare/clients", () => ({ cloudflareClients: async () => ({}) }));
vi.mock("../audit/cliAudit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/cliAudit")>()),
  createProjectCliAudit: async () => async () => {},
}));
vi.mock("../capabilities/secretsDispatcher", () => ({ buildSecretDispatcher: async () => ({}) }));
vi.mock("../capabilities/secretsProvisioner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/secretsProvisioner")>()),
  CloudflareSecretsProvisioner: class {},
}));
vi.mock("@pithy-sh/secrets/src/provision/provisionSecrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/secrets/src/provision/provisionSecrets")>()),
  provisionSecrets: async () => ({
    perEnv: [
      { env: "staging", databaseId: "db-staging", storeId: "store" },
      { env: "prod", databaseId: "db-prod", storeId: "store" },
    ],
  }),
}));
vi.mock("../project/workerScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/workerScope")>()),
  resolveWorkers: async () => [{ name: "api", dir: "/does/not/exist", config: {}, capabilities: [] }],
}));
vi.mock("../capabilities/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/secrets")>()),
  resolveSecretRegistry: () => ({}),
}));
vi.mock("../provision/secretBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provision/secretBindings")>()),
  workerSecretRegistry: () => ({}),
  secretsStoreBindings: async () => ({
    bound: [
      { binding: "EMAIL_LINK_SIGNING_KEY", store_id: "store", secret_name: "acme-staging-email-link-signing-key" },
    ],
    missing: [],
    minted: ["email-link-signing-key"],
  }),
}));
vi.mock("../provision/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provision/store")>()),
  cloudflareSecretsStore: () => ({ exists: async () => true }),
}));
vi.mock("../provision/wranglerEnv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provision/wranglerEnv")>()),
  applySecretBindings: async () => {},
}));
vi.mock("../capabilities/mintSecrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/mintSecrets")>()),
  mintDeclaredSecrets: async (): Promise<MintedSecret[]> => [
    { name: "SESSION_SECRET", environments: ["staging", "prod"], created: ["staging"] },
  ],
}));
vi.mock("../devSecrets/location", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../devSecrets/location")>()),
  resolveDevSecretsFile: async () => "/home/you/.config/pithy/acme/secrets.jsonc",
}));
vi.mock("../devSecrets/edit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../devSecrets/edit")>()),
  editDevSecrets: async () => ({ changed: true, secrets: 3 }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pithy secrets --json conforms to its published payloads", () => {
  test("provision", async () => {
    await expectConforms("secrets provision", await runCaptured("secrets provision", ["--json"]));
  });

  test("edit", async () => {
    await expectConforms("secrets edit", await runCaptured("secrets edit", ["--json"]));
  });
});

/** `pithy schema` publishes the backends `--backend` takes: the set `requireBackend` parses with, and no copy of it. */
describe("pithy secrets rm --backend", () => {
  test("publishes exactly the backends the command accepts", async () => {
    expect((await contractAt("secrets rm")).flags?.backend?.enum).toEqual(SecretBackend.options);
  });
});
