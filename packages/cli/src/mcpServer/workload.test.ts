// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { defaultTokenSource, parseTokenSource, tokenExpiry, workloadTokens } from "./workload";

/** An unsigned JWT claiming `exp`, which is all the scheduler reads. */
function jwt(expSeconds: number, marker = "a"): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment({ exp: expSeconds, marker })}.sig`;
}

const AUDIENCE = "https://acme-prod.acme.workers.dev";

describe("parseTokenSource", () => {
  test("reads the three spellings", () => {
    expect(parseTokenSource("github")).toEqual({ kind: "github" });
    expect(parseTokenSource("gitlab:MCP_ID_TOKEN")).toEqual({ kind: "gitlab", variable: "MCP_ID_TOKEN" });
    expect(parseTokenSource("env:MY_TOKEN")).toEqual({ kind: "env", variable: "MY_TOKEN" });
  });

  test("refuses anything else, naming all three", () => {
    for (const raw of ["gitlab", "env:", "github:X", "vault:X", "env:1BAD"]) {
      const refusal = (() => {
        try {
          parseTokenSource(raw);
        } catch (error) {
          return error;
        }
      })();
      expect(refusal).toBeInstanceOf(PithyError);
      expect((refusal as PithyError).payload.message).toContain("github, gitlab:<VARIABLE> or env:<VARIABLE>");
    }
  });

  test("GitHub's issuer implies GitHub's source, and nothing else implies one", () => {
    expect(defaultTokenSource("https://token.actions.githubusercontent.com")).toEqual({ kind: "github" });
    expect(defaultTokenSource("https://gitlab.com")).toBeUndefined();
  });
});

describe("tokenExpiry", () => {
  test("reads exp in milliseconds, and null for anything that is not a JWT", () => {
    expect(tokenExpiry(jwt(100))).toBe(100_000);
    expect(tokenExpiry("opaque")).toBeNull();
  });
});

describe("workloadTokens on GitHub Actions", () => {
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example/token?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-bearer",
  };

  test("asks the runner for a token for the environment's origin, with the runner's bearer", async () => {
    const fetch = vi.fn(async () => Response.json({ value: jwt(10_000) }));
    const tokens = workloadTokens({ kind: "github" }, AUDIENCE, { env, fetch, now: () => 0 });
    expect(await tokens.current()).toBe(jwt(10_000));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get("audience")).toBe(AUDIENCE);
    expect(new URL(url).searchParams.get("api-version")).toBe("2.0");
    expect((init.headers as Record<string, string>).authorization).toBe("bearer runner-bearer");
  });

  test("presents the held token per call, and fetches again a minute before it expires", async () => {
    let clock = 0;
    let minted = 0;
    const fetch = vi.fn(async () => Response.json({ value: jwt(300, String(++minted)) }));
    const tokens = workloadTokens({ kind: "github" }, AUDIENCE, { env, fetch, now: () => clock });
    const first = await tokens.current();
    clock = 200_000;
    expect(await tokens.current()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock = 241_000;
    expect(await tokens.current()).not.toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("without id-token: write there is no request URL, and the refusal says to grant it", async () => {
    const tokens = workloadTokens({ kind: "github" }, AUDIENCE, { env: {}, fetch: vi.fn() });
    const refusal = await tokens.current().catch((error: unknown) => error);
    expect((refusal as PithyError).payload.action).toContain("id-token: write");
  });

  test("a runner that refuses names neither its bearer nor a token", async () => {
    const fetch = vi.fn(async () => new Response("no", { status: 403 }));
    const refusal = await workloadTokens({ kind: "github" }, AUDIENCE, { env, fetch })
      .current()
      .catch((error: unknown) => error as PithyError);
    expect(JSON.stringify((refusal as PithyError).payload)).not.toContain("runner-bearer");
    expect((refusal as PithyError).payload.detail).toContain("403");
  });
});

describe("workloadTokens from a named variable", () => {
  test("GitLab's id_tokens: variable is read, held, and read again before expiry", async () => {
    let clock = 0;
    const env: NodeJS.ProcessEnv = { MCP_ID_TOKEN: jwt(300, "one") };
    const tokens = workloadTokens({ kind: "gitlab", variable: "MCP_ID_TOKEN" }, AUDIENCE, { env, now: () => clock });
    expect(await tokens.current()).toBe(jwt(300, "one"));
    env.MCP_ID_TOKEN = jwt(900, "two");
    clock = 100_000;
    expect(await tokens.current()).toBe(jwt(300, "one"));
    clock = 250_000;
    expect(await tokens.current()).toBe(jwt(900, "two"));
  });

  test("a custom issuer's variable works the same way", async () => {
    const tokens = workloadTokens({ kind: "env", variable: "MY_TOKEN" }, AUDIENCE, {
      env: { MY_TOKEN: jwt(300) },
      now: () => 0,
    });
    expect(await tokens.current()).toBe(jwt(300));
  });

  test("an empty variable is refused naming the variable and the audience, never a value", async () => {
    const refusal = await workloadTokens({ kind: "gitlab", variable: "MCP_ID_TOKEN" }, AUDIENCE, { env: {} })
      .current()
      .catch((error: unknown) => error as PithyError);
    expect((refusal as PithyError).payload.message).toBe("MCP_ID_TOKEN holds no identity token.");
    expect((refusal as PithyError).payload.action).toContain(`aud: ${AUDIENCE}`);
  });

  test("a token already past its exp cannot be refreshed from here, and says to rerun the job", async () => {
    const refusal = await workloadTokens({ kind: "env", variable: "T" }, AUDIENCE, {
      env: { T: jwt(1) },
      now: () => 5_000,
    })
      .current()
      .catch((error: unknown) => error as PithyError);
    expect((refusal as PithyError).payload.message).toContain("has expired");
    expect(JSON.stringify((refusal as PithyError).payload)).not.toContain(jwt(1));
  });
});
