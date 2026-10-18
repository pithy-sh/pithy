// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, describe, expect, test, vi } from "vitest";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import type { ForgetResult, RevokeResult, TokenListItem, TokenResult } from "../tokens/engine";
import type { SupersededToken } from "../tokens/superseded";

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
  superseded: { found: [] as unknown[], unasked: null as string | null },
  revoked: undefined as unknown,
  forgot: undefined as unknown,
  forgetEngine: undefined as unknown,
  workers: [] as unknown[],
  credentials: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token", SECRETS_STORE_ID: "store" } as Record<
    string,
    string
  >,
}));

vi.mock("../project/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/config")>()),
  loadProject: async () => ({ name: "acme" }),
  loadProjectCloudflare: () => null,
}));
vi.mock("../cloudflare/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/config")>()),
  cloudflareEnv: () => engine.credentials,
}));
vi.mock("../cloudflare/clients", () => ({ cloudflareClients: async () => ({ accountTokens: () => ({}) }) }));
vi.mock("../project/composeFor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/composeFor")>()),
  resolveWorkerSetFor: async () => engine.workers,
}));
vi.mock("../tokens/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tokens/engine")>()),
  mintProfileToken: async () => engine.minted,
  rotateProfileToken: async () => engine.minted,
  listProfileTokens: async () => engine.listed,
  listSupersededTokens: async () => engine.superseded,
  revokeProfileToken: async () => engine.revoked,
  forgetProfileToken: async (forgetEngine: unknown) => {
    engine.forgetEngine = forgetEngine;
    return engine.forgot;
  },
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
      {
        profile: "ci-system",
        env: "prod",
        name: "acme-prod-ci-system",
        tokenId: "tok-1",
        routeScope: "scoped",
        grants: "current",
      },
      {
        profile: "runtime",
        env: "prod",
        name: "acme-prod-runtime",
        tokenId: "tok-3",
        status: "active",
        routeScope: "not-required",
        grants: "missing",
      },
      {
        profile: "ci-system",
        env: "prod",
        name: "acme-prod-ci-system",
        tokenId: "tok-2",
        status: "disabled",
        routeScope: "inactive",
        grants: "inactive",
      },
    ] satisfies TokenListItem[];
    engine.superseded = {
      found: [
        {
          kind: "account-token",
          name: "acme-global-secrets-manager",
          tokenId: "tok-9",
          status: "active",
          was: "the secrets manager's own token",
          supersededBy: "runtime",
        },
        {
          kind: "stored",
          name: "media-storage-credentials",
          env: "prod",
          was: "the Images and Stream token supplied to `pithy media provision`",
          supersededBy: "runtime",
        },
      ] satisfies SupersededToken[],
      unasked: null,
    };
    await expectConforms("token list", await runCaptured("token list", ["--env", "prod", "--json"]));
  });

  test("revoke, with each word for its local copy", async () => {
    const location = "/home/you/.config/pithy/acme/tokens.json";
    for (const localCopy of ["forgotten", "absent", "uncleared"] as const) {
      engine.revoked = {
        profile: "ci-system",
        env: "prod",
        name: "acme-prod-ci-system",
        revoked: 0,
        localCopy,
        location,
        ...(localCopy === "uncleared"
          ? { localCopyProblem: `Cannot update ${location}: it is there and is not JSON.` }
          : {}),
      } satisfies RevokeResult;
      await expectConforms("token revoke", await runCaptured("token revoke", ["ci-system", "--env", "prod", "--json"]));
    }
  });

  test("forget, dropped and absent", async () => {
    const location = "/home/you/.config/pithy/acme/tokens.json";
    engine.forgot = {
      profile: "ci-system",
      env: "prod",
      localCopy: "forgotten",
      location,
      usage: "used",
    } satisfies ForgetResult;
    await expectConforms("token forget", await runCaptured("token forget", ["ci-system", "--env", "prod", "--json"]));
    engine.forgot = {
      profile: "ci-system",
      env: "prod",
      localCopy: "absent",
      location,
      usage: "skipped",
    } satisfies ForgetResult;
    await expectConforms("token forget", await runCaptured("token forget", ["ci-system", "--env", "prod", "--json"]));
  });
});

describe("pithy token forget without credentials", () => {
  test("**runs, with no account to ask** — missing credentials are the check not running, not a refusal", async () => {
    // `forget` is a local file operation that consults the account. Every other `pithy token` command
    // refuses without credentials, because each writes to the account; this one falls back to asking.
    const saved = engine.credentials;
    engine.credentials = {};
    engine.forgot = {
      profile: "ci-system",
      env: "prod",
      localCopy: "forgotten",
      location: "/home/you/.config/pithy/acme/tokens.json",
      usage: "unreadable",
    } satisfies ForgetResult;
    try {
      await expectConforms("token forget", await runCaptured("token forget", ["ci-system", "--env", "prod", "--json"]));
      expect((engine.forgetEngine as { tokens?: unknown }).tokens).toBeUndefined();
      expect((engine.forgetEngine as { project: string }).project).toBe("acme");
    } finally {
      engine.credentials = saved;
    }
  });

  test("**says its event was not recorded** when the project composes audit — never a silent forget", async () => {
    // No credentials, no client to write the audit database with. A forget that drops a value and records
    // nothing must say so on stderr, the way an unknowable capability set does (#762).
    const saved = engine.credentials;
    engine.credentials = {};
    engine.workers = [{ name: "app", capabilities: [defineCapability({ name: "audit", requiredBindings: [] })] }];
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      stderr.push(parts.map(String).join(" "));
    });
    engine.forgot = {
      profile: "ci-system",
      env: "prod",
      localCopy: "forgotten",
      location: "/home/you/.config/pithy/acme/tokens.json",
      usage: "unreadable",
    } satisfies ForgetResult;
    try {
      await runCaptured("token forget", ["ci-system", "--env", "prod", "--json"]);
      const audit = (engine.forgetEngine as { audit?: (event: unknown) => Promise<void> }).audit;
      expect(audit).toBeDefined();
      await audit?.({ action: "cloudflare/token_forgotten", outcome: "success", profile: "ci-system", env: "prod" });
      expect(stderr.join("")).toMatch(/not recorded/i);
      expect(stderr.join("")).toMatch(/cloudflare\/token_forgotten/);
    } finally {
      engine.credentials = saved;
      engine.workers = [];
    }
  });
});
