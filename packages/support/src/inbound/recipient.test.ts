// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { resolveInbox } from "./recipient";

/** Two inboxes on one Worker — enough to prove the resolver picks, rather than just answers yes. */
const INBOXES = ["support@help.example.com", "security@help.example.com"];

describe("resolveInbox", () => {
  test("the envelope recipient matching a configured address resolves to that address", () => {
    expect(
      resolveInbox({ inboundAddresses: INBOXES, envelopeTo: "support@help.example.com", headerRecipients: [] }),
    ).toBe("support@help.example.com");
  });

  test("two inboxes on one Worker stay apart — the envelope picks which one the thread belongs to", () => {
    expect(
      resolveInbox({ inboundAddresses: INBOXES, envelopeTo: "security@help.example.com", headerRecipients: [] }),
    ).toBe("security@help.example.com");
  });

  test("an envelope recipient outside the configured set returns undefined even when a header claims one", () => {
    // The security boundary of this file. The `To:`/`Cc:` headers are attacker-controlled — anyone can
    // put `To: support@` on a message routed to `hello@` — so falling through to them when the
    // envelope was usable would let a stranger inject threads into an inbox they were never routed
    // to, and into a mailbox a human reads and answers. The envelope decides, including deciding no.
    expect(
      resolveInbox({
        inboundAddresses: INBOXES,
        envelopeTo: "hello@help.example.com",
        headerRecipients: ["support@help.example.com", "security@help.example.com"],
      }),
    ).toBeUndefined();
  });

  test("a bounce handler's mail is not claimed, so each capability's email() handler keeps its own", () => {
    expect(
      resolveInbox({
        inboundAddresses: INBOXES,
        envelopeTo: "bounces@help.example.com",
        headerRecipients: ["support@help.example.com"],
      }),
    ).toBeUndefined();
  });

  test("with no usable envelope recipient, a configured address in the headers is accepted", () => {
    // The one documented fallback: the message still reached a Worker that only receives what a
    // routing rule sent it, so the headers are the best evidence left rather than an unvetted claim.
    expect(
      resolveInbox({
        inboundAddresses: INBOXES,
        envelopeTo: undefined,
        headerRecipients: ["someone@elsewhere.example", "security@help.example.com"],
      }),
    ).toBe("security@help.example.com");
  });

  test("with no envelope and no configured address in the headers, nothing is claimed", () => {
    expect(
      resolveInbox({
        inboundAddresses: INBOXES,
        envelopeTo: undefined,
        headerRecipients: ["someone@elsewhere.example", "list@lists.example.org"],
      }),
    ).toBeUndefined();
  });

  test("a malformed envelope address falls back to the headers rather than throwing", () => {
    // Inbound mail is attacker-controlled, so a garbage envelope is an expected input. An exception
    // here would take down the Worker's email() entry for every capability sharing it.
    for (const malformed of ["", "   ", "not-an-address", "@help.example.com", "support@", "a@b c@help.example.com"]) {
      expect(
        resolveInbox({
          inboundAddresses: INBOXES,
          envelopeTo: malformed,
          headerRecipients: ["support@help.example.com"],
        }),
        malformed,
      ).toBe("support@help.example.com");
    }
  });

  test("an empty inboundAddresses returns undefined for everything — the inbox is inert until configured", () => {
    expect(
      resolveInbox({
        inboundAddresses: [],
        envelopeTo: "support@help.example.com",
        headerRecipients: ["support@help.example.com"],
      }),
    ).toBeUndefined();
    expect(resolveInbox({ inboundAddresses: [], envelopeTo: undefined, headerRecipients: [] })).toBeUndefined();
  });

  test("matching is case-insensitive, so `Support@Help.Example.COM` lands in the same inbox", () => {
    // Normalization runs on the envelope before comparison; splitting one inbox across two casings
    // would put a customer's thread somewhere nobody is looking.
    expect(
      resolveInbox({ inboundAddresses: INBOXES, envelopeTo: "Support@Help.Example.COM", headerRecipients: [] }),
    ).toBe("support@help.example.com");
  });

  test("the header fallback normalizes too, angle brackets and display name included", () => {
    expect(
      resolveInbox({
        inboundAddresses: INBOXES,
        envelopeTo: undefined,
        headerRecipients: ["Pithy Support <Support@Help.Example.com>"],
      }),
    ).toBe("support@help.example.com");
  });

  test("the returned value is the normalized configured address, never the envelope string as sent", () => {
    // A thread's inbox is stored, so it has to be something that appears in `pithy.config.ts` — a raw
    // `  <SUPPORT@help.example.com> ` on the row would never match a filter written from the config.
    const resolved = resolveInbox({
      inboundAddresses: INBOXES,
      envelopeTo: "  <SUPPORT@help.example.com> ",
      headerRecipients: [],
    });
    expect(resolved).toBe("support@help.example.com");
    expect(INBOXES).toContain(resolved);
  });

  test("a header that only looks like a configured address is not a match", () => {
    // Substring or suffix matching would accept `support@help.example.com.attacker.example`.
    expect(
      resolveInbox({
        inboundAddresses: INBOXES,
        envelopeTo: undefined,
        headerRecipients: ["support@help.example.com.attacker.example", "x-support@help.example.com"],
      }),
    ).toBeUndefined();
  });
});
