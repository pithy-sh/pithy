import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { EmailEventType } from "../data/enums";
import type { EmailDatabase } from "../data/tables";

/** A per-recipient event to append to `pithy_email_events`. */
export interface EventInput {
  jobId: string;
  recipient: string;
  type: EmailEventType;
  linkLabel?: string | null;
  linkUrl?: string | null;
  campaignId?: string | null;
  detail?: string | null;
}

/** Append one event row. The history/attribution log written by the send path, callbacks, and bounce handler. */
export async function recordEvent(db: EmailDatabase, event: EventInput, now: Date): Promise<void> {
  await db
    .insertInto("pithyEmailEvents")
    .values({
      jobId: event.jobId,
      recipient: event.recipient,
      type: event.type,
      linkLabel: event.linkLabel ?? null,
      linkUrl: event.linkUrl ?? null,
      campaignId: event.campaignId ?? null,
      detail: event.detail ?? null,
      createdAt: SQLiteDate.encode(now),
    })
    .execute();
}
