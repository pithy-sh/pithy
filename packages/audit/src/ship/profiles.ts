// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { ShippedAuditEvent } from "./event";
import { AUDIT_SHIP_FORMAT } from "./event";
import type { AuditSink, AuditSinkProfile } from "./sinks";

/**
 * **One delivery, in the receiver's own documented format (#824).**
 *
 * - **`splunk-hec`** — Splunk's HTTP Event Collector: one JSON object per event, concatenated, with
 *   `Authorization: Splunk <token>`. Each carries `time` in epoch seconds, `source` and `sourcetype`, and the event
 *   under `event`. https://docs.splunk.com/Documentation/Splunk/latest/Data/FormateventsforHTTPEventCollector
 * - **`datadog-logs`** — the Datadog Logs intake (`/api/v2/logs`): a JSON array, with `DD-API-KEY: <key>`. Each log
 *   carries `ddsource`, `service`, `ddtags`, a one-line `message`, and the event under `audit`.
 *   https://docs.datadoghq.com/api/latest/logs/#send-logs
 * - **`webhook`** — a JSON document `{ format, events }` with `Authorization: Bearer <token>`, for Elastic, Sumo Logic,
 *   or anything else that takes HTTPS. `format` is `pithy-audit-ship/1`.
 *
 * Every profile carries the whole shipped event, so the chain hash and the event id reach every receiver.
 */

/** What one delivery sends: where, and the request. */
export interface SinkDelivery {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
}

/** Splunk's `source`, Datadog's `ddsource`: what the events are, at a glance, in the receiver's own search. */
export const SHIP_SOURCE = "pithy";

/** Splunk's `sourcetype` for the trail. */
export const SPLUNK_SOURCETYPE = "pithy:audit";

/** A Datadog tag value: its own allowed characters, lowercased. */
function tag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_./:-]/g, "_");
}

function body(profile: AuditSinkProfile, events: readonly ShippedAuditEvent[]): string {
  switch (profile) {
    case "splunk-hec":
      return events
        .map((event) =>
          JSON.stringify({
            time: event.occurredAt / 1000,
            source: SHIP_SOURCE,
            sourcetype: SPLUNK_SOURCETYPE,
            ...(event.worker === null ? {} : { host: event.worker }),
            event,
          }),
        )
        .join("\n");
    case "datadog-logs":
      return JSON.stringify(
        events.map((event) => ({
          ddsource: SHIP_SOURCE,
          service: event.project ?? SHIP_SOURCE,
          ...(event.worker === null ? {} : { hostname: event.worker }),
          ddtags: [
            ...(event.environment === null ? [] : [`env:${tag(event.environment)}`]),
            `action:${tag(event.action)}`,
            `outcome:${tag(event.outcome)}`,
          ].join(","),
          message: `${event.action} ${event.outcome}`,
          audit: event,
        })),
      );
    case "webhook":
      return JSON.stringify({ format: AUDIT_SHIP_FORMAT, events });
  }
}

function authorization(profile: AuditSinkProfile, token: string): Record<string, string> {
  switch (profile) {
    case "splunk-hec":
      return { authorization: `Splunk ${token}` };
    case "datadog-logs":
      return { "dd-api-key": token };
    case "webhook":
      return { authorization: `Bearer ${token}` };
  }
}

/** The request that delivers these events to this sink. */
export function sinkDelivery(
  sink: Pick<AuditSink, "profile" | "url">,
  token: string,
  events: readonly ShippedAuditEvent[],
): SinkDelivery {
  return {
    url: sink.url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", ...authorization(sink.profile, token) },
      body: body(sink.profile, events),
    },
  };
}
