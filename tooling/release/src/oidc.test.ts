// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { actionsTokenMinter, mintActionsIdToken } from "./oidc";

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.local/token?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-credential",
};

function issues(value = "a.b.c"): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify({ value, count: 1 }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function calls(send: typeof fetch): [string, RequestInit][] {
  return (send as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
}

describe("mintActionsIdToken", () => {
  it("returns the token the endpoint issues", async () => {
    const send = issues("header.claims.signature");

    const token = await mintActionsIdToken({ audience: "https://dashboard.pithy.sh", env: ENV, fetch: send });

    expect(token).toBe("header.claims.signature");
  });

  // The audience is what makes a token narrow, so it goes on the request rather than being assumed. The
  // endpoint arrives with `?api-version=` already on it, which is the reason this is `set` and not `+=`.
  it("asks for the audience it was given, keeping the endpoint's own query", async () => {
    const send = issues();

    await mintActionsIdToken({ audience: "https://staging.dashboard.pithy.sh", env: ENV, fetch: send });

    const [url, init] = calls(send)[0] ?? [];
    const asked = new URL(url ?? "");
    expect(asked.searchParams.get("audience")).toBe("https://staging.dashboard.pithy.sh");
    expect(asked.searchParams.get("api-version")).toBe("2.0");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer request-credential");
  });

  // Without `id-token: write` the runner injects neither variable, and a token minted from nothing is
  // not a thing to guess at.
  it("refuses when the job holds no id-token permission", async () => {
    const send = issues();

    await expect(mintActionsIdToken({ audience: "https://dashboard.pithy.sh", env: {}, fetch: send })).rejects.toThrow(
      /id-token/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses when only half the environment is present", async () => {
    await expect(
      mintActionsIdToken({
        audience: "https://dashboard.pithy.sh",
        env: { ACTIONS_ID_TOKEN_REQUEST_URL: ENV.ACTIONS_ID_TOKEN_REQUEST_URL },
        fetch: issues(),
      }),
    ).rejects.toThrow(/id-token/);
  });

  it("reports an endpoint that refuses", async () => {
    const send = vi.fn(async () => new Response("bad audience", { status: 400 })) as unknown as typeof fetch;

    await expect(mintActionsIdToken({ audience: "https://dashboard.pithy.sh", env: ENV, fetch: send })).rejects.toThrow(
      /400/,
    );
  });

  it("reports an answer that carries no token", async () => {
    const send = vi.fn(
      async () => new Response(JSON.stringify({ count: 1 }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(mintActionsIdToken({ audience: "https://dashboard.pithy.sh", env: ENV, fetch: send })).rejects.toThrow(
      /without a token/,
    );
  });

  // A CI log for a public repository is public, and the request credential is the one thing here that
  // could mint another token.
  it("never quotes the request credential in a refusal", async () => {
    const send = vi.fn(
      async () => new Response("rejected request-credential", { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(mintActionsIdToken({ audience: "https://dashboard.pithy.sh", env: ENV, fetch: send })).rejects.toThrow(
      /\[redacted\]/,
    );
  });
});

describe("actionsTokenMinter", () => {
  it("mints a distinct token for each audience it is asked for", async () => {
    let issued = 0;
    const send = vi.fn(async (url: string) => {
      issued += 1;
      const audience = new URL(url).searchParams.get("audience");
      return new Response(JSON.stringify({ value: `${audience}#${issued}` }), { status: 200 });
    }) as unknown as typeof fetch;
    const mint = actionsTokenMinter({ env: ENV, fetch: send });

    const staging = await mint("https://staging.dashboard.pithy.sh");
    const prod = await mint("https://dashboard.pithy.sh");

    expect(staging).toBe("https://staging.dashboard.pithy.sh#1");
    expect(prod).toBe("https://dashboard.pithy.sh#2");
  });
});
