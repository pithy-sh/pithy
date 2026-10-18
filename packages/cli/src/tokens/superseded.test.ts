// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AccountTokenSummary } from "@pithy-sh/cloudflare/src/tokens/accountTokensManager";
import { describe, expect, test, vi } from "vitest";
import { supersededAccountTokens, supersededNotice, supersededStoredToken } from "./superseded";

const token = (name: string, extra: Partial<AccountTokenSummary> = {}): AccountTokenSummary => ({
  id: `id-${name}`,
  name,
  status: "active",
  ...extra,
});

describe("supersededAccountTokens (#728)", () => {
  test("names the secrets manager's own tokens by their exact names, and nothing else", () => {
    const all = [
      token("acme-global-secrets-manager"),
      token("acme-prod-secrets"),
      token("acme-staging-secrets"),
      token("acme-prod-runtime"),
      token("globex-global-secrets-manager"),
      token("hand-made"),
    ];
    expect(supersededAccountTokens(all, "acme", "prod")).toEqual([
      {
        kind: "account-token",
        name: "acme-global-secrets-manager",
        tokenId: "id-acme-global-secrets-manager",
        status: "active",
        was: "the secrets manager's own token",
        supersededBy: "runtime",
      },
      {
        kind: "account-token",
        name: "acme-prod-secrets",
        tokenId: "id-acme-prod-secrets",
        status: "active",
        was: "the secrets manager's own token, minted for prod",
        supersededBy: "runtime",
      },
    ]);
  });

  test("an account holding none names none", () => {
    expect(supersededAccountTokens([token("acme-prod-runtime")], "acme", "prod")).toEqual([]);
  });
});

describe("supersededStoredToken (#728)", () => {
  const media = { secret: "media-storage-credentials", field: "apiToken" };

  test("names a media bundle that still carries the token supplied to `pithy media provision`", async () => {
    const carries = vi.fn(async () => true);
    expect(await supersededStoredToken({ env: "prod", media, carries })).toEqual({
      kind: "stored",
      name: "media-storage-credentials",
      env: "prod",
      was: "the Images and Stream token supplied to `pithy media provision`",
      supersededBy: "runtime",
    });
    expect(carries).toHaveBeenCalledWith({ env: "prod", name: "media-storage-credentials", field: "apiToken" });
  });

  test("a bundle rewritten without it, or no media at all, names nothing and asks nothing", async () => {
    expect(await supersededStoredToken({ env: "prod", media, carries: async () => false })).toBeNull();
    const carries = vi.fn(async () => true);
    expect(await supersededStoredToken({ env: "prod", media: null, carries })).toBeNull();
    expect(await supersededStoredToken({ env: "dev", media, carries })).toBeNull();
    expect(carries).not.toHaveBeenCalled();
  });
});

describe("supersededNotice (#728)", () => {
  test("names each one, and the order the upgrade runs in", () => {
    const notice = supersededNotice(
      [
        {
          kind: "account-token",
          name: "acme-global-secrets-manager",
          tokenId: "t9",
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
      ],
      null,
    );
    expect(notice).toContain("Superseded by runtime, and still present:");
    expect(notice).toContain("acme-global-secrets-manager · t9 — the secrets manager's own token");
    expect(notice).toContain(
      "media-storage-credentials in prod — the Images and Stream token supplied to `pithy media provision`",
    );
    expect(notice).toMatch(/Mint runtime, redeploy, then revoke each\./);
    expect(notice).toContain("pithy doctor");
  });

  test("says what it could not ask, and nothing when there is nothing to say", () => {
    expect(supersededNotice([], null)).toBeNull();
    expect(supersededNotice([], "The prod secrets manager cannot say.")).toBe(
      "Whether a supplied media token is still stored could not be asked: The prod secrets manager cannot say.\n",
    );
  });
});
