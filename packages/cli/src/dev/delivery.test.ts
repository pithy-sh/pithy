// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { deliveryFailureNote, deliveryPreflight } from "./delivery";

/** A project composing email, with a real from address and a resolved login. */
const live = { composed: true, requested: "remote", fromAddress: "hello@acme.dev", hasCloudflareLogin: true } as const;

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
    const result = deliveryPreflight({ ...live, hasCloudflareLogin: false });
    expect(result.live).toBe(false);
    expect(result.lines.join("\n")).toContain("pithy init");
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
