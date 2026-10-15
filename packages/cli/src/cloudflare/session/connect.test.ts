// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { OAuthGrant } from "@pithy-sh/cloudflare/src/oauth/client";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  type CallbackListener,
  chooseSessionAccount,
  listenForCallback,
  PASTE_INSTRUCTION,
  type SignInIo,
  signIn,
} from "./connect";

const GRANT: OAuthGrant = {
  accessToken: "AT",
  refreshToken: "RT",
  expiresAt: new Date("2026-10-15T13:00:00Z"),
  scope: "user-details.read account-api-tokens.write",
};

/** A listener whose callback the test delivers by hand, or never. */
function handListener(): CallbackListener & { deliver: (path: string) => void; closed: boolean } {
  let deliver: (address: string) => void = () => {};
  const listener = {
    redirectUri: "http://127.0.0.1:41234/callback",
    address: new Promise<string>((resolve) => {
      deliver = resolve;
    }),
    closed: false,
    close() {
      listener.closed = true;
    },
    deliver: (path: string) => deliver(`http://127.0.0.1:41234${path}`),
  };
  return listener;
}

/** Captures what the flow prints, opens and is asked. */
function io(overrides: Partial<SignInIo> = {}): SignInIo & { lines: string[]; opened: string[] } {
  const lines: string[] = [];
  const opened: string[] = [];
  return {
    lines,
    opened,
    write: (line) => lines.push(line),
    open: async (url) => {
      opened.push(url);
    },
    ...overrides,
  };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";

describe("signIn", () => {
  test("prints the URL first, names the sensitive scopes, opens it, and redeems the callback's code", async () => {
    const listener = handListener();
    const out = io();
    const exchanged: string[] = [];
    const running = signIn({ scopes: ["user-details.read", "account-api-tokens.write"], open: true }, out, {
      listen: async () => listener,
      exchange: async ({ code }) => {
        exchanged.push(code);
        return GRANT;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const url = out.opened[0] ?? "";
    expect(out.lines.join("\n")).toContain(url);
    expect(out.lines.join("\n").indexOf(url)).toBeLessThan(out.lines.join("\n").indexOf("Sensitive scopes"));
    expect(out.lines.join("\n")).toMatch(/Account API Tokens Write/);
    listener.deliver(`/callback?code=cfoac_1&state=${stateOf(url)}`);
    expect(await running).toEqual(GRANT);
    expect(exchanged).toEqual(["cfoac_1"]);
    expect(listener.closed).toBe(true);
  });

  test("a pasted landing address wins the race just as a callback does, and the prompt is the only way in", async () => {
    const listener = handListener();
    let urlSeen = "";
    const out = io({
      open: async (url) => {
        urlSeen = url;
      },
      ask: async () => `http://127.0.0.1:41234/callback?code=cfoac_pasted&state=${stateOf(urlSeen)}`,
    });
    const grant = await signIn({ scopes: ["user-details.read"], open: true }, out, {
      listen: async () => listener,
      exchange: async ({ code }) => ({ ...GRANT, accessToken: code }),
    });
    expect(grant.accessToken).toBe("cfoac_pasted");
  });

  test("a pasted address from another sign-in is refused, and the prompt asks again", async () => {
    const listener = handListener();
    let urlSeen = "";
    const answers = ["http://127.0.0.1:41234/callback?code=x&state=not-this-one", ""];
    const out = io({
      open: async (url) => {
        urlSeen = url;
      },
      ask: async () => {
        const next = answers.shift() ?? "";
        return next === "" ? `http://127.0.0.1:41234/callback?code=cfoac_ok&state=${stateOf(urlSeen)}` : next;
      },
    });
    const grant = await signIn({ scopes: ["user-details.read"], open: true }, out, {
      listen: async () => listener,
      exchange: async ({ code }) => ({ ...GRANT, accessToken: code }),
    });
    expect(grant.accessToken).toBe("cfoac_ok");
    expect(out.lines.join("\n")).toMatch(/different sign-in/);
  });

  test("with a terminal, it says before the browser opens that an unreachable page is expected, and what to copy", async () => {
    // Over SSH the redirect lands on the browser's own machine, which shows "This site can't be reached".
    // That looks like a failure and is not one; the instruction has to arrive before the page does.
    const listener = handListener();
    let urlSeen = "";
    const out = io({
      open: async (url) => {
        urlSeen = url;
      },
      ask: async () => `http://127.0.0.1:41234/callback?code=c&state=${stateOf(urlSeen)}`,
    });
    await signIn({ scopes: ["user-details.read"], open: true }, out, {
      listen: async () => listener,
      exchange: async () => GRANT,
    });
    const at = (needle: string) => out.lines.findIndex((line) => line.includes(needle));
    expect(at(PASTE_INSTRUCTION)).toBeGreaterThan(at("oauth2/auth"));
    expect(PASTE_INSTRUCTION).toMatch(/can't be reached/);
    expect(PASTE_INSTRUCTION).toMatch(/address bar/);
  });

  test("with no terminal to paste into, it says so after the address, not before it", async () => {
    const listener = handListener();
    const out = io();
    const running = signIn({ scopes: ["user-details.read"], open: false }, out, {
      listen: async () => listener,
      exchange: async () => GRANT,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const at = (needle: string) => out.lines.findIndex((line) => line.includes(needle));
    expect(at("Pasting the address back needs a terminal")).toBeGreaterThan(at("oauth2/auth"));
    const url = out.lines.find((line) => line.includes("oauth2/auth")) ?? "";
    listener.deliver(`/callback?code=c&state=${stateOf(url.trim())}`);
    await running;
  });

  test("--no-open opens nothing and still prints the URL", async () => {
    const listener = handListener();
    const out = io();
    const running = signIn({ scopes: ["user-details.read"], open: false }, out, {
      listen: async () => listener,
      exchange: async () => GRANT,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(out.opened).toEqual([]);
    const url = out.lines.find((line) => line.includes("oauth2/auth")) ?? "";
    listener.deliver(`/callback?code=c&state=${stateOf(url.trim())}`);
    await running;
  });

  test("a browser that will not open is one line, and the flow carries on", async () => {
    const listener = handListener();
    const out = io({
      open: async () => {
        throw new Error("no xdg-open");
      },
    });
    const running = signIn({ scopes: ["user-details.read"], open: true }, out, {
      listen: async () => listener,
      exchange: async () => GRANT,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(out.lines.join("\n")).toMatch(/Could not open a browser/);
    const url = out.lines.find((line) => line.includes("oauth2/auth")) ?? "";
    listener.deliver(`/callback?code=c&state=${stateOf(url.trim())}`);
    expect(await running).toEqual(GRANT);
  });

  test("Cloudflare's refusal arrives as its own words", async () => {
    const listener = handListener();
    const out = io();
    const running = signIn({ scopes: ["user-details.read"], open: false }, out, {
      listen: async () => listener,
      exchange: async () => GRANT,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const url = out.lines.find((line) => line.includes("oauth2/auth")) ?? "";
    listener.deliver(`/callback?error=access_denied&error_description=The+user+denied&state=${stateOf(url.trim())}`);
    await expect(running).rejects.toThrow(/The user denied/);
  });

  test("a timeout names the sensitive-scope switch before the network, because that is what the silent failure looks like", async () => {
    const out = io();
    const failure = await signIn({ scopes: ["account-api-tokens.write"], open: false, timeoutMs: 10 }, out, {
      listen: async () => handListener(),
      exchange: async () => GRANT,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.action).toMatch(/Account API Tokens Write/);
  });

  test("a grant missing a requested scope is refused, naming the scope", async () => {
    const listener = handListener();
    const out = io();
    const running = signIn({ scopes: ["user-details.read", "d1.write"], open: false }, out, {
      listen: async () => listener,
      exchange: async () => ({ ...GRANT, scope: "user-details.read" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const url = out.lines.find((line) => line.includes("oauth2/auth")) ?? "";
    listener.deliver(`/callback?code=c&state=${stateOf(url.trim())}`);
    await expect(running).rejects.toThrow(/d1\.write/);
  });
});

describe("chooseSessionAccount", () => {
  const accounts = [
    { id: "a1", name: "Alpha" },
    { id: "b2", name: "Beta" },
  ];

  test("one account is the answer", async () => {
    expect(await chooseSessionAccount([accounts[0] ?? { id: "", name: "" }], {})).toEqual({ id: "a1", name: "Alpha" });
  });

  test("the project's pin decides among several, and a pin the session cannot see is refused", async () => {
    expect(await chooseSessionAccount(accounts, { pinned: "b2" })).toEqual({ id: "b2", name: "Beta" });
    await expect(chooseSessionAccount(accounts, { pinned: "zz" })).rejects.toThrow(/zz/);
  });

  test("--account decides when there is no pin, by id", async () => {
    expect(await chooseSessionAccount(accounts, { requested: "a1" })).toEqual({ id: "a1", name: "Alpha" });
  });

  test("several and nothing to decide asks, when it may", async () => {
    expect(await chooseSessionAccount(accounts, { choose: async () => "b2" })).toEqual({ id: "b2", name: "Beta" });
  });

  test("several, nothing to decide, and no one to ask is refused with the accounts named", async () => {
    const failure = await chooseSessionAccount(accounts, {}).catch((error: unknown) => error);
    expect((failure as PithyError).payload).toMatchObject({
      code: "input/required",
      flag: "--account",
      choices: ["a1", "b2"],
    });
    expect((failure as PithyError).payload.action).toMatch(/--account with one of: a1 \(Alpha\), b2 \(Beta\)/);
  });

  test("none at all is refused", async () => {
    await expect(chooseSessionAccount([], {})).rejects.toThrow(PithyError);
  });
});

describe("listenForCallback", () => {
  test("a callback with another sign-in's state is turned away and does not spend the one this run waits for", async () => {
    const listener = await listenForCallback((address) => new URL(address).searchParams.get("state") === "mine");
    const port = new URL(listener.redirectUri).port;
    const stray = await fetch(`http://127.0.0.1:${port}/callback?code=evil&state=someone-elses`);
    expect(stray.status).toBe(400);
    const real = await fetch(`http://127.0.0.1:${port}/callback?code=c&state=mine`);
    expect(real.status).toBe(200);
    expect(await listener.address).toBe(`http://127.0.0.1:${port}/callback?code=c&state=mine`);
    listener.close();
  });

  test("binds 127.0.0.1 on an ephemeral port, answers /callback once, and hands back the address", async () => {
    const listener = await listenForCallback();
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const port = new URL(listener.redirectUri).port;
    expect(Number(port)).toBeGreaterThan(0);
    const miss = await fetch(`http://127.0.0.1:${port}/elsewhere`);
    expect(miss.status).toBe(404);
    const hit = await fetch(`http://127.0.0.1:${port}/callback?code=c&state=s`);
    expect(hit.status).toBe(200);
    expect(await listener.address).toBe(`http://127.0.0.1:${port}/callback?code=c&state=s`);
    listener.close();
  });
});
