// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { OrganizationConfig } from "../config/config";
import type { EnqueueInvitation } from "./invitation";
import { LIFECYCLE_NOTICE_TEMPLATES, notifyOwners, readableDate, sendLifecycleNotice } from "./lifecycle";

/** The three notices an organization's owners get when an operator acts on the organization itself (#623). */

const CONFIG = OrganizationConfig.parse({});
const UNTIL = new Date("2026-11-19T00:00:00.000Z");

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

describe("sendLifecycleNotice", () => {
  test("all three send by default, through the kit template named for each", async () => {
    expect(CONFIG.lifecycleEmails).toEqual({
      organizationSuspended: true,
      organizationReinstated: true,
      organizationDeletionScheduled: true,
    });
    const { enqueue, sent } = recording();
    for (const notice of Object.keys(LIFECYCLE_NOTICE_TEMPLATES) as (keyof typeof LIFECYCLE_NOTICE_TEMPLATES)[]) {
      expect(
        await sendLifecycleNotice(CONFIG, enqueue, {
          notice,
          to: { email: "ada@example.com" },
          organizationName: "Acme",
        }),
      ).toBe("queued");
    }
    expect(sent.map((input) => input.template)).toEqual(Object.values(LIFECYCLE_NOTICE_TEMPLATES));
  });

  test("a suspension carries the reason and its end, written in the owner's language", async () => {
    const { enqueue, sent } = recording();
    await sendLifecycleNotice(CONFIG, enqueue, {
      notice: "organizationSuspended",
      to: { email: "ada@example.com", name: " Ada ", locale: "es" },
      organizationName: "Acme",
      reason: "Unpaid invoice.",
      until: UNTIL,
    });
    expect(sent[0]).toEqual({
      to: "ada@example.com",
      template: "organizationSuspended",
      payload: { organizationName: "Acme", name: "Ada", reason: "Unpaid invoice.", until: readableDate(UNTIL, "es") },
      locale: "es",
    });
  });

  test("a deletion carries its purge date, and a reinstatement nothing but the name", async () => {
    const { enqueue, sent } = recording();
    await sendLifecycleNotice(CONFIG, enqueue, {
      notice: "organizationDeletionScheduled",
      to: { email: "ada@example.com" },
      organizationName: "Acme",
      purgeOn: UNTIL,
      reason: "not carried",
    });
    await sendLifecycleNotice(CONFIG, enqueue, {
      notice: "organizationReinstated",
      to: { email: "ada@example.com" },
      organizationName: "Acme",
      reason: "not carried",
    });
    expect(sent.map((input) => input.payload)).toEqual([
      { organizationName: "Acme", purgeOn: "November 19, 2026" },
      { organizationName: "Acme" },
    ]);
  });

  test("each one is switched off on its own, and no seam sends nothing", async () => {
    const { enqueue, sent } = recording();
    const off = OrganizationConfig.parse({ lifecycleEmails: { organizationSuspended: false } });
    expect(off.lifecycleEmails.organizationReinstated).toBe(true);
    expect(
      await sendLifecycleNotice(off, enqueue, {
        notice: "organizationSuspended",
        to: { email: "ada@example.com" },
        organizationName: "Acme",
      }),
    ).toBeNull();
    expect(
      await sendLifecycleNotice(CONFIG, undefined, {
        notice: "organizationReinstated",
        to: { email: "ada@example.com" },
        organizationName: "Acme",
      }),
    ).toBeNull();
    expect(sent).toEqual([]);
  });

  test("an enqueue that throws is reported as not sent, never thrown", async () => {
    const failing: EnqueueInvitation = async () => {
      throw new Error("binding gone");
    };
    expect(
      await sendLifecycleNotice(CONFIG, failing, {
        notice: "organizationReinstated",
        to: { email: "ada@example.com" },
        organizationName: "Acme",
      }),
    ).toBeNull();
  });
});

describe("notifyOwners", () => {
  test("sends one notice per owner and counts what was queued", async () => {
    const { enqueue, sent } = recording();
    const queued = await notifyOwners(CONFIG, enqueue, [{ email: "ada@example.com" }, { email: "bob@example.com" }], {
      notice: "organizationReinstated",
      organizationName: "Acme",
    });
    expect(queued).toBe(2);
    expect(sent.map((input) => input.to)).toEqual(["ada@example.com", "bob@example.com"]);
  });

  test("is null when the notice is off or nothing can send it, so the trail says not attempted", async () => {
    const off = OrganizationConfig.parse({ lifecycleEmails: { organizationReinstated: false } });
    const { enqueue } = recording();
    expect(
      await notifyOwners(off, enqueue, [{ email: "ada@example.com" }], {
        notice: "organizationReinstated",
        organizationName: "Acme",
      }),
    ).toBeNull();
    expect(
      await notifyOwners(CONFIG, undefined, [{ email: "ada@example.com" }], {
        notice: "organizationReinstated",
        organizationName: "Acme",
      }),
    ).toBeNull();
  });
});
