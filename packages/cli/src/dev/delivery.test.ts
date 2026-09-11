// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { childCloudflareIdentity, deliveryFailureNote, deliveryPreflight } from "./delivery";

/** A project composing email, with a real from address and credentials the children will actually get. */
const live = {
  composed: true,
  requested: "remote",
  fromAddress: "hello@acme.dev",
  cloudflare: { accountId: "acct-1", hasToken: true, mismatch: null },
} as const;

describe("deliveryPreflight", () => {
  test("a project composing no email is asked nothing and says nothing", () => {
    expect(deliveryPreflight({ ...live, composed: false })).toEqual({ live: false, lines: [] });
  });

  test("sends for real when a login and a real sending address are both there", () => {
    const result = deliveryPreflight(live);
    expect(result.live).toBe(true);
    expect(result.lines.join(" ")).toContain("hello@acme.dev");
  });

  test("the simulator by config is stated as the deliberate choice it is, not as a failure", () => {
    const result = deliveryPreflight({ ...live, requested: "simulator" });
    expect(result.live).toBe(false);
    expect(result.lines.join(" ")).toContain("by config");
  });

  test("no Cloudflare login falls back to the simulator, with the command that fixes it", () => {
    const result = deliveryPreflight({ ...live, cloudflare: { accountId: null, hasToken: false, mismatch: null } });
    expect(result.live).toBe(false);
    expect(result.lines.join("\n")).toContain("pithy init");
  });

  test("half a pair is no login — an account with no token cannot send, and says so", () => {
    // Both halves travel together or not at all: `cloudflareChildEnv` hands over whatever resolved, and
    // an id with nothing to authenticate with is the `pithy init` case, not the sending case.
    expect(
      deliveryPreflight({ ...live, cloudflare: { accountId: "acct-1", hasToken: false, mismatch: null } }).live,
    ).toBe(false);
    expect(deliveryPreflight({ ...live, cloudflare: { accountId: null, hasToken: true, mismatch: null } }).live).toBe(
      false,
    );
  });

  test("a contradicted pin says so, and names the config key — never `run pithy init`", () => {
    // The third state. `pithy dev` refuses outright on a mismatch, so only `pithy doctor` reaches here —
    // and with two states it had to choose between announcing `sending for real` about a disowned account
    // and telling the operator to run a command that would not help.
    const result = deliveryPreflight({
      ...live,
      cloudflare: {
        accountId: null,
        hasToken: false,
        mismatch: "This project pins Cloudflare account A, and the file supplies credentials for B.",
      },
    });
    expect(result.live).toBe(false);
    expect(result.lines[0]).toContain("pins Cloudflare account A");
    expect(result.lines.join("\n")).toContain("cloudflare.accountId");
    expect(result.lines.join("\n")).not.toContain("pithy init");
  });

  test("the live line names the account the mail will actually leave through", () => {
    // #555 in one line of output. `wrangler whoami` answers for the shell and `pithy doctor` for the
    // project, and nothing said which one a dev-session send would use. This does.
    const result = deliveryPreflight(live);
    expect(result.lines[0]).toContain("acct-1");
  });

  test("a from address nobody can onboard falls back too, naming the address", () => {
    const result = deliveryPreflight({ ...live, fromAddress: "noreply@example.com" });
    expect(result.live).toBe(false);
    expect(result.lines[0]).toContain("noreply@example.com");
  });

  test("a from address with no domain at all is caught rather than resolved to nothing", () => {
    expect(deliveryPreflight({ ...live, fromAddress: undefined }).live).toBe(false);
    expect(deliveryPreflight({ ...live, fromAddress: "noreply@" }).live).toBe(false);
  });
});

describe("deliveryFailureNote", () => {
  test("a remote send binding that will not stand up is a problem line and an action line", () => {
    const note = deliveryFailureNote("✘ [ERROR] Could not establish remote binding for send_email EMAIL");
    expect(note).toBeDefined();
    expect(note).toContain("nothing will be delivered");
    expect(note).toContain("devDelivery");
  });

  test("a rejected sender is caught at first send, not only at startup", () => {
    const note = deliveryFailureNote("send failed: the sender address is not verified for this account");
    expect(note).toContain("not onboarded");
  });

  test("an ordinary host line is left to the tee, never accused", () => {
    expect(deliveryFailureNote("[wrangler] Ready on http://localhost:8797")).toBeUndefined();
    expect(deliveryFailureNote("send_email binding called with MessageBuilder:")).toBeUndefined();
  });
});

describe("childCloudflareIdentity", () => {
  test("reads the account off the environment the children are handed, not off a second resolution", () => {
    // The whole point: the preflight and the spawn consult one value. A second resolution is how the
    // banner came to say `sending for real from noreply@pithy.sh` over a worker authenticating as
    // somebody else's tenant (#555).
    expect(childCloudflareIdentity({ CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_API_TOKEN: "t" })).toEqual({
      accountId: "acct-1",
      hasToken: true,
      // An environment that resolved has no disagreement left in it: `cloudflareEnv` throws on one.
      mismatch: null,
    });
  });

  test("an environment carrying neither key is no login at all", () => {
    expect(childCloudflareIdentity({ PATH: "/usr/bin" })).toEqual({
      accountId: null,
      hasToken: false,
      mismatch: null,
    });
  });

  test("a blank value is unset, exactly as the credential overlay reads it", () => {
    expect(childCloudflareIdentity({ CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" })).toEqual({
      accountId: null,
      hasToken: false,
      mismatch: null,
    });
  });
});
