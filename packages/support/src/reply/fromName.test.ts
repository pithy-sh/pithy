// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { email } from "@pithy-sh/email/src/capability";
import { describe, expect, test } from "vitest";
import { support } from "../capability";
import { SupportConfig } from "../config/config";
import { claimedSenders, replyFromName } from "./fromName";

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
