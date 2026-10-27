// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { z } from "zod";

/**
 * **Where the trail is shipped: sinks, declared in `pithy.config.ts` (#824).**
 *
 * A sink is reviewed and deployed like code. No control-plane route adds, changes or removes one, so no management
 * credential can point the trail somewhere new — the same reason audit has no route that writes. Each sink names its
 * profile, its URL, the `@pithy-sh/secrets` name its token is read through, and optionally which actions it takes
 * and whether it ships personal values.
 *
 * Strict objects, so a misspelled key (`detial: true`) is refused at config load rather than read as the default
 * it was trying to change. A profile nobody wrote a format for, a URL that is not HTTPS, and a sink with no secret
 * name are refused the same way, before the Worker serves anything.
 */

/** The formats a sink speaks. One per receiver's own documented ingestion API, and a generic one for the rest. */
export const AuditSinkProfile = z
  .enum(["splunk-hec", "datadog-logs", "webhook"])
  .describe(
    "How events are delivered: `splunk-hec` to a Splunk HTTP Event Collector, `datadog-logs` to the Datadog Logs intake, or `webhook` as a JSON document to any HTTPS endpoint — Elastic, Sumo Logic, or your own.",
  );
export type AuditSinkProfile = z.infer<typeof AuditSinkProfile>;

/** A sink's name: the key it is declared under, reported by `pithy doctor` and on the manifest's health. */
export const AUDIT_SINK_NAME = /^[a-z][a-z0-9-]*$/;

/** A secret name, as `@pithy-sh/secrets` stores one: kebab-case, never a keyspace member. */
const SECRET_NAME = /^[a-z][a-z0-9-]*$/;

export const AuditSink = z
  .strictObject({
    profile: AuditSinkProfile,
    url: z
      .url({ protocol: /^https$/, hostname: z.regexes.domain })
      .describe(
        "The HTTPS endpoint events are posted to — the collector's full URL, path included, e.g. `https://splunk.example.com:8088/services/collector/event`.",
      ),
    secret: z
      .string()
      .regex(SECRET_NAME, "A secret name is kebab-case: lowercase letters, digits and hyphens.")
      .describe(
        "The `@pithy-sh/secrets` name the sink's token is stored under — the HEC token, the Datadog API key, or the webhook's bearer token. Set it with `pithy secrets create <name> --env <env>`.",
      ),
    actions: z
      .array(z.string().min(1).describe("An action prefix, e.g. `auth/` or `controlplane/connection`."))
      .min(1)
      .readonly()
      .optional()
      .describe(
        "Ship only events whose action starts with one of these prefixes. Absent ships every event the trail records.",
      ),
    detail: z
      .boolean()
      .default(false)
      .describe(
        "Ship each event's IP, user-agent and metadata values. Off by default: the sink receives their salted hashes instead, which verify against the chain and disclose nothing.",
      ),
  })
  .describe("One destination the audit trail is shipped to as it is written.");
export type AuditSink = z.output<typeof AuditSink>;
export type AuditSinkInput = z.input<typeof AuditSink>;

export const AuditSinks = z
  .record(
    z.string().regex(AUDIT_SINK_NAME, "A sink name is kebab-case: lowercase letters, digits and hyphens."),
    AuditSink,
  )
  .describe("The sinks the trail is shipped to, by name. Empty ships nothing and binds no queue.");
export type AuditSinks = z.output<typeof AuditSinks>;

/** Whether a sink takes an event with this action — every action when it names no prefixes. */
export function sinkTakes(sink: Pick<AuditSink, "actions">, action: string): boolean {
  return sink.actions === undefined || sink.actions.some((prefix) => action.startsWith(prefix));
}

/** The sinks, by name, that take an event with this action, in declaration order. */
export function sinksFor(sinks: AuditSinks, action: string): string[] {
  return Object.entries(sinks).flatMap(([name, sink]) => (sinkTakes(sink, action) ? [name] : []));
}
