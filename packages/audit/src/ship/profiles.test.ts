// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { AUDIT_CHAIN_FORMAT } from "@pithy-sh/core/src/audit/chain";
import { describe, expect, test } from "vitest";
import { AUDIT_SHIP_FORMAT, ShippedAuditEvent } from "./event";
import { SHIP_SOURCE, SPLUNK_SOURCETYPE, sinkDelivery } from "./profiles";

const HASH = "a".repeat(64);

const event: ShippedAuditEvent = ShippedAuditEvent.parse({
  format: AUDIT_SHIP_FORMAT,
  chain: AUDIT_CHAIN_FORMAT,
  eventId: "evt-1",
  occurredAt: 1_761_600_000_123,
  action: "auth/login",
  outcome: "success",
  severity: "info",
  actorType: "user",
  actorId: "u1",
  actorKind: null,
  sessionId: null,
  resourceType: null,
  resourceId: null,
  requestId: null,
  tenant: "acme",
  project: "shop",
  environment: "prod",
  worker: "api",
  version: null,
  ipCommitment: HASH,
  userAgentCommitment: null,
  metadataCommitment: null,
  seq: 4,
  prev: HASH,
  hash: HASH,
});

const url = "https://collector.example.com/in";

describe("sinkDelivery", () => {
  test("splunk-hec: one HEC event object per event, a Splunk token, time in seconds", () => {
    const delivery = sinkDelivery({ profile: "splunk-hec", url }, "hec-token", [event, { ...event, eventId: "evt-2" }]);
    expect(delivery.url).toBe(url);
    expect(delivery.init.headers).toEqual({ "content-type": "application/json", authorization: "Splunk hec-token" });
    const lines = delivery.init.body.split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      time: 1_761_600_000.123,
      source: SHIP_SOURCE,
      sourcetype: SPLUNK_SOURCETYPE,
      host: "api",
      event,
    });
    expect(lines[1].event.eventId).toBe("evt-2");
  });

  test("datadog-logs: a JSON array of logs, the API key header, tags and the event under audit", () => {
    const delivery = sinkDelivery({ profile: "datadog-logs", url }, "dd-key", [event]);
    expect(delivery.init.headers).toEqual({ "content-type": "application/json", "dd-api-key": "dd-key" });
    expect(JSON.parse(delivery.init.body)).toEqual([
      {
        ddsource: SHIP_SOURCE,
        service: "shop",
        hostname: "api",
        ddtags: "env:prod,action:auth/login,outcome:success",
        message: "auth/login success",
        audit: event,
      },
    ]);
  });

  test("webhook: one JSON document naming its format, a bearer token", () => {
    const delivery = sinkDelivery({ profile: "webhook", url }, "hook-token", [event]);
    expect(delivery.init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer hook-token" });
    expect(JSON.parse(delivery.init.body)).toEqual({ format: AUDIT_SHIP_FORMAT, events: [event] });
  });

  test("every profile carries the event id and its chain hash", () => {
    for (const profile of ["splunk-hec", "datadog-logs", "webhook"] as const) {
      const sent = sinkDelivery({ profile, url }, "t", [event]).init.body;
      expect(sent, profile).toContain('"eventId":"evt-1"');
      expect(sent, profile).toContain(`"hash":"${HASH}"`);
    }
  });
});
