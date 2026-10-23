// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { OrganizationConfig } from "../config/config";
import type { EnqueueInvitation } from "./invitation";
import { MEMBERSHIP_NOTICE_TEMPLATES, sendMembershipNotice } from "./membership";

/**
 * The three notices an operator's act sends. What each sends, that each can be turned off, and that none
 * of them can undo the act it reports by failing.
 */

const CONFIG = OrganizationConfig.parse({});

function recording(): { enqueue: EnqueueInvitation; sent: Parameters<EnqueueInvitation>[0][] } {
  const sent: Parameters<EnqueueInvitation>[0][] = [];
  return {
    sent,
    enqueue: async (input) => {
      sent.push(input);
      return { jobId: "job-1", status: "queued" };
    },
  };
}

describe("sendMembershipNotice", () => {
  test("all three send by default, through the kit template named for each", async () => {
    expect(CONFIG.operatorEmails).toEqual({ memberAdded: true, memberRemoved: true, ownershipTransferred: true });
    const { enqueue, sent } = recording();
    for (const notice of ["memberAdded", "memberRemoved", "ownershipTransferred"] as const) {
      expect(
        await sendMembershipNotice(CONFIG, enqueue, {
          notice,
          to: { email: "sam@example.com" },
          organizationName: "Acme",
        }),
      ).toBe("queued");
    }
    expect(sent.map((input) => input.template)).toEqual(Object.values(MEMBERSHIP_NOTICE_TEMPLATES));
  });

  test("an add names the role, in the recipient's own language, with their name when they gave one", async () => {
    const { enqueue, sent } = recording();
    await sendMembershipNotice(CONFIG, enqueue, {
      notice: "memberAdded",
      to: { email: "sam@example.com", name: "  Sam ", locale: "es" },
      organizationName: "Acme",
      role: "admin",
    });
    expect(sent[0]).toEqual({
      to: "sam@example.com",
      template: "organizationMemberAdded",
      payload: { organizationName: "Acme", name: "Sam", role: "admin" },
      locale: "es",
    });
  });

  test("a removal says nothing about a role, and a blank name is no name", async () => {
    const { enqueue, sent } = recording();
    await sendMembershipNotice(CONFIG, enqueue, {
      notice: "memberRemoved",
      to: { email: "sam@example.com", name: "   " },
      organizationName: "Acme",
      role: "admin",
    });
    expect(sent[0]?.payload).toEqual({ organizationName: "Acme" });
    expect(sent[0]).not.toHaveProperty("locale");
  });

  test("each is switchable off, one at a time", async () => {
    const quiet = OrganizationConfig.parse({ operatorEmails: { memberRemoved: false } });
    expect(quiet.operatorEmails).toEqual({ memberAdded: true, memberRemoved: false, ownershipTransferred: true });
    const { enqueue, sent } = recording();
    expect(
      await sendMembershipNotice(quiet, enqueue, {
        notice: "memberRemoved",
        to: { email: "sam@example.com" },
        organizationName: "Acme",
      }),
    ).toBeNull();
    expect(sent).toHaveLength(0);
  });

  test("with no email composed nothing is sent, and nothing is refused", async () => {
    expect(
      await sendMembershipNotice(CONFIG, undefined, {
        notice: "ownershipTransferred",
        to: { email: "sam@example.com" },
        organizationName: "Acme",
      }),
    ).toBeNull();
  });

  test("an enqueue that throws is reported as not sent, never as a failure of the act", async () => {
    const exploding: EnqueueInvitation = async () => {
      throw new Error("the email database is on fire");
    };
    await expect(
      sendMembershipNotice(CONFIG, exploding, {
        notice: "memberAdded",
        to: { email: "sam@example.com" },
        organizationName: "Acme",
      }),
    ).resolves.toBeNull();
  });
});
