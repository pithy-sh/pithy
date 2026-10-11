// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, test, vi } from "vitest";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import type { TokenListItem, TokenResult } from "../tokens/engine";

/**
 * **What `pithy token` writes under `--json`, held to the schema `pithy schema token` publishes (#697).**
 *
 * The engine — the account calls, the sinks, the audit — is `tokens/engine.test.ts`'s. Here it is replaced
 * with what it returns, typed as it returns it, and everything between the flags and the line is the real
 * command: the project read, the projection that keeps a token's value out of the line, and the rename of
 * a revoke's count. Nothing reaches an account.
 */

const engine = vi.hoisted(() => ({
  minted: undefined as unknown,
  listed: [] as unknown[],
  revoked: undefined as unknown,
}));

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  loadProjectCloudflare: () => null,
}));
vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => ({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token", SECRETS_STORE_ID: "store" }),
}));
vi.mock("../cloudflare/clients", () => ({ cloudflareClients: async () => ({ accountTokens: () => ({}) }) }));
vi.mock("../project/composeFor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/composeFor")>()),
  resolveWorkerSetFor: async () => [],
}));
vi.mock("../tokens/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tokens/engine")>()),
  mintProfileToken: async () => engine.minted,
  rotateProfileToken: async () => engine.minted,
  listProfileTokens: async () => engine.listed,
  revokeProfileToken: async () => engine.revoked,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pithy token --json conforms to its published payloads", () => {
  const result: TokenResult = {
    profile: "ci-system",
    env: "prod",
    tokenId: "tok-1",
    name: "acme-prod-ci-system",
    value: "never-printed",
    sink: { sink: "dev-vars", location: "/home/you/.config/pithy/acme/tokens.json" },
    status: "active",
  };

  test("mint and rotate, with and without a status", async () => {
    engine.minted = result;
    await expectConforms("token mint", await runCaptured("token mint", ["ci-system", "--env", "prod", "--json"]));
    engine.minted = { ...result, status: undefined } satisfies TokenResult;
    await expectConforms("token rotate", await runCaptured("token rotate", ["ci-system", "--env", "prod", "--json"]));
  });

  test("list", async () => {
    engine.listed = [
      { profile: "ci-system", env: "prod", name: "acme-prod-ci-system", tokenId: "tok-1", routeScope: "scoped" },
      {
        profile: "ci-system",
        env: "prod",
        name: "acme-prod-ci-system",
        tokenId: "tok-2",
        status: "disabled",
        routeScope: "inactive",
      },
    ] satisfies TokenListItem[];
    await expectConforms("token list", await runCaptured("token list", ["--env", "prod", "--json"]));
  });

  test("revoke", async () => {
    engine.revoked = { profile: "ci-system", env: "prod", name: "acme-prod-ci-system", revoked: 0 };
    await expectConforms("token revoke", await runCaptured("token revoke", ["ci-system", "--env", "prod", "--json"]));
  });
});
