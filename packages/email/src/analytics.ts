import { EmailEventType } from "./data/enums";
import type { EmailDatabase } from "./data/tables";

/**
 * Per-batch email analytics, read from `pithy_email_events` in the app database. A "batch" is a
 * `campaignId` (set on marketing sends and any send that passes one), so a single grouped query yields
 * how many were sent, opened, clicked, bounced, complained, and unsubscribed.
 *
 * Events live in the **per-environment** app DB and are written where the action happens: `sent` by the
 * send Workflow, `open`/`click`/`unsubscribe` by the callbacks (whose links point at the sending
 * environment's worker), and `bounce`/`complaint` by the inbound handler. So a production campaign's
 * full funnel lands in production's app DB; cross-environment bounce attribution is platform-limited
 * (one inbound worker per domain), so feature/staging see their own opens/clicks/unsubscribes but not
 * asynchronously-routed bounces.
 */

/** Event counts for a campaign, one per `EmailEventType`. Types with no events are `0`. */
export type CampaignStats = Record<EmailEventType, number>;

/** Every event type at zero — derived from the enum so a new `EmailEventType` can't be forgotten here. */
const ZERO: CampaignStats = Object.fromEntries(EmailEventType.options.map((type) => [type, 0])) as CampaignStats;

/** Aggregate the events recorded for one campaign into per-type counts. */
export async function campaignStats(db: EmailDatabase, campaignId: string): Promise<CampaignStats> {
  const rows = await db
    .selectFrom("pithyEmailEvents")
    .select(["type"])
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("campaignId", "=", campaignId)
    .groupBy("type")
    .execute();

  const stats: CampaignStats = { ...ZERO };
  for (const row of rows) stats[row.type as EmailEventType] = Number(row.count);
  return stats;
}
