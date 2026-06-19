import { normalizeIanaTimezone } from "@pithy-sh/core/src/data/codecs";
import { EmailInvalidPayloadError } from "../error/errors";

/**
 * Resolve a job's absolute send time from its mode. `immediate` is now; `scheduled` is the given
 * absolute instant; `timezone` resolves a recipient-local time-of-day (e.g. `10:00`) in their IANA
 * zone to the next absolute instant at or after now. The timezone math uses `Intl` only — no library —
 * by measuring the zone's offset at a candidate instant and correcting for it.
 */

/** The offset (ms) of a timezone at a given UTC instant: zone wall-clock minus UTC. */
function zoneOffsetMs(timezone: string, utcMs: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // `hour` can come back as 24 at midnight in some engines; normalize to 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - utcMs;
}

/** Parse `HH:MM` to `{ hour, minute }`, or throw `email/invalid_payload`. */
function parseLocalTime(localTime: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(localTime.trim());
  const hour = match ? Number(match[1]) : Number.NaN;
  const minute = match ? Number(match[2]) : Number.NaN;
  if (!match || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new EmailInvalidPayloadError({ detail: `invalid localTime '${localTime}' — expected HH:MM` });
  }
  return { hour, minute };
}

/**
 * The next absolute instant when the wall clock reads `hour:minute` in `timezone`, at or after `now`.
 * Computes the candidate for the zone-local date of `now`, advancing a day if it has already passed.
 */
export function resolveTimezoneSendAt(localTime: string, timezone: string, now: Date): Date {
  const zone = normalizeIanaTimezone(timezone);
  if (!zone) throw new EmailInvalidPayloadError({ detail: `invalid IANA timezone '${timezone}'` });
  const { hour, minute } = parseLocalTime(localTime);

  // The zone-local calendar date of `now`.
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string): number => Number(dateParts.find((p) => p.type === type)?.value ?? "0");

  const candidateFor = (dayOffset: number): Date => {
    const guessUtc = Date.UTC(part("year"), part("month") - 1, part("day") + dayOffset, hour, minute);
    // Correct the guess by the zone's offset at that instant so the wall clock lands on hour:minute.
    // A single correction is wrong when the offset at the guess differs from the offset at the corrected
    // instant (a DST boundary), so apply a second pass: if the offset there differs, re-correct from it.
    // (In the spring-forward gap, where hour:minute doesn't exist, this settles on the post-transition
    // instant rather than landing an hour off.)
    const first = guessUtc - zoneOffsetMs(zone, guessUtc);
    const secondOffset = zoneOffsetMs(zone, first);
    return new Date(guessUtc - secondOffset);
  };

  const today = candidateFor(0);
  return today.getTime() >= now.getTime() ? today : candidateFor(1);
}
