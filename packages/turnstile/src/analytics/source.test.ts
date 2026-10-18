// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { stubSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { afterEach, describe, expect, test } from "vitest";
import { TURNSTILE_ACCOUNT_SECRET, turnstileCapabilitySecretsRegistry } from "../secret/registry";
import { turnstileAnalyticsConfig } from "./source";

const env = {} as never;

afterEach(() => resetSharedSecrets());

describe("turnstileAnalyticsConfig (#731)", () => {
  test("is the application's one runtime token and the account turnstile's widgets live in", async () => {
    stubSecrets(turnstileCapabilitySecretsRegistry, {
      [TURNSTILE_ACCOUNT_SECRET]: { accountId: "acct-1" },
      [RUNTIME_TOKEN_SECRET]: "runtime-token",
    });
    expect(await turnstileAnalyticsConfig(env)()).toEqual({ apiToken: "runtime-token", accountId: "acct-1" });
  });

  test("an environment holding no account is a named refusal that names the provision", async () => {
    stubSecrets(turnstileCapabilitySecretsRegistry, { [RUNTIME_TOKEN_SECRET]: "runtime-token" });
    const error = (await turnstileAnalyticsConfig(env)().catch((e) => e)) as PithyError;
    expect(error.payload.code).toBe("turnstile/config");
    expect(error.payload.message).toBe(
      "This environment holds no record of the Cloudflare account its widgets live in.",
    );
    expect(error.payload.action).toContain("turnstile provision");
  });

  test("resolves once, and only when asked", async () => {
    stubSecrets(turnstileCapabilitySecretsRegistry, {
      [TURNSTILE_ACCOUNT_SECRET]: { accountId: "acct-1" },
      [RUNTIME_TOKEN_SECRET]: "runtime-token",
    });
    const config = turnstileAnalyticsConfig(env);
    expect(await config()).toBe(await config());
  });
});
