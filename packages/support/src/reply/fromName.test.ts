// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { email } from "@pithy-sh/email/src/capability";
import { describe, expect, test } from "vitest";
import { support } from "../capability";
import { SupportConfig } from "../config/config";
import { claimedSenders, replyFromName } from "./fromName";
import { replySender } from "./sender";

describe("reply.fromName", () => {
  test("defaults to the agent's name alone", () => {
    expect(SupportConfig.parse({}).reply.fromName).toBe("{agent}");
  });

  test("an empty pattern is refused", () => {
    expect(() => SupportConfig.parse({ reply: { fromName: "" } })).toThrow();
  });
});

describe("replyFromName", () => {
  test("writes the agent's name into the pattern", () => {
    expect(replyFromName("{agent} at Acme", "Jim Scott")).toBe("Jim Scott at Acme");
  });

  test("every placeholder is filled", () => {
    expect(replyFromName("{agent} ({agent})", "Jim")).toBe("Jim (Jim)");
  });

  test("no agent name gives no display name, so the email capability's fromName is used", () => {
    expect(replyFromName("{agent} at Acme", undefined)).toBeUndefined();
    expect(replyFromName("{agent} at Acme", "   ")).toBeUndefined();
  });

  test("a pattern with no placeholder is the name as written", () => {
    expect(replyFromName("Acme Support", "Jim Scott")).toBe("Acme Support");
  });

  test("a pattern with no placeholder is used with no agent name too", () => {
    expect(replyFromName("Acme Support", undefined)).toBe("Acme Support");
  });

  test("line breaks and control characters never reach the From line", () => {
    expect(replyFromName("{agent}", "Jim\r\nBcc: x@evil.test")).toBe("Jim Bcc: x@evil.test");
  });
});

describe("the addresses support may send as", () => {
  test("are its inbound addresses and its reply-to, once each, normalized", () => {
    const config = SupportConfig.parse({
      inboundAddresses: ["Support@Help.Example.com", "billing@help.example.com"],
      reply: { replyToAddress: "support@help.example.com" },
    });
    expect(claimedSenders(config)).toEqual(["support@help.example.com", "billing@help.example.com"]);
  });

  test("are nothing at all when nothing is claimed", () => {
    expect(claimedSenders(SupportConfig.parse({}))).toEqual([]);
  });

  test("are what compose binds the email capability's enqueue to", () => {
    const mail = email({ fromAddress: "noreply@example.com", fromName: "Acme", baseUrl: "https://example.com" });
    const bound: (readonly string[])[] = [];
    const enqueueAs = mail.enqueueAs;
    mail.enqueueAs = (claimed) => {
      bound.push(claimed);
      return enqueueAs(claimed);
    };
    const inbox = support({
      inboundAddresses: ["support@help.example.com"],
      reply: { replyToAddress: "answers@help.example.com" },
      submission: { enabled: false },
    });

    inbox.compose?.({ capabilities: [mail, inbox] });

    expect(bound).toEqual([["support@help.example.com", "answers@help.example.com"]]);
  });
});

describe("an email capability too old to send as support's addresses", () => {
  test("is refused at compose, naming the upgrade", () => {
    const mail = email({ fromAddress: "noreply@example.com", fromName: "Acme", baseUrl: "https://example.com" });
    const old = { ...mail, enqueueAs: undefined } as unknown as typeof mail;
    const inbox = support({ inboundAddresses: ["support@help.example.com"], submission: { enabled: false } });

    expect(() => inbox.compose?.({ capabilities: [old, inbox] })).toThrowError(
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "core/internal",
          action: expect.stringContaining("@pithy-sh/email"),
        }),
      }),
    );
  });

  test("and the action names the release that carries enqueueAs", () => {
    const mail = email({ fromAddress: "noreply@example.com", fromName: "Acme", baseUrl: "https://example.com" });
    const old = { ...mail, enqueueAs: undefined } as unknown as typeof mail;
    try {
      replySender([old], SupportConfig.parse({ inboundAddresses: ["support@help.example.com"] }));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { payload?: { action?: string } }).payload?.action).toContain("^0.9.0");
    }
  });

  test("no email capability composed is no sender, not a refusal", () => {
    expect(replySender([], SupportConfig.parse({}))).toBeUndefined();
  });
});
