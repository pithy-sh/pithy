import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { campaignStats } from "./analytics";
import { emailDatabase } from "./data/tables";
import { email_0001_init } from "./migrations/0001_init";
import { recordEvent } from "./send/events";

const now = new Date("2026-06-18T12:00:00.000Z");

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await email_0001_init.up(emailDatabase(env.DB));
});

describe("campaignStats", () => {
  test("aggregates a campaign's events into per-type counts", async () => {
    const db = emailDatabase(env.DB);
    const events: { type: Parameters<typeof recordEvent>[1]["type"]; campaignId: string }[] = [
      { type: "sent", campaignId: "spring" },
      { type: "sent", campaignId: "spring" },
      { type: "open", campaignId: "spring" },
      { type: "click", campaignId: "spring" },
      { type: "click", campaignId: "spring" },
      { type: "bounce", campaignId: "spring" },
      { type: "unsubscribe", campaignId: "spring" },
      { type: "sent", campaignId: "other" }, // a different campaign — must not bleed in
    ];
    for (const e of events)
      await recordEvent(db, { jobId: "j", recipient: "u@example.com", type: e.type, campaignId: e.campaignId }, now);

    const stats = await campaignStats(db, "spring");
    expect(stats).toEqual({
      sent: 2,
      open: 1,
      click: 2,
      bounce: 1,
      complaint: 0,
      unsubscribe: 1,
      suppressed: 0,
      failed: 0,
    });
  });

  test("an unknown campaign is all zeros", async () => {
    const stats = await campaignStats(emailDatabase(env.DB), "nope");
    expect(stats).toEqual({
      sent: 0,
      open: 0,
      click: 0,
      bounce: 0,
      complaint: 0,
      unsubscribe: 0,
      suppressed: 0,
      failed: 0,
    });
  });
});
