// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { chainHash, commitment } from "@pithy-sh/core/src/audit/chain";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { auditDatabase } from "../data/tables";
import { audit_0001_init } from "../migrations/0001_init";
import { audit_0002_actor_kind } from "../migrations/0002_actor_kind";
import { audit_0003_call_index } from "../migrations/0003_call_index";
import { audit_0004_request_index } from "../migrations/0004_request_index";
import { audit_0005_chain } from "../migrations/0005_chain";
import { audit_0006_sinks } from "../migrations/0006_sinks";
import { recordAuditEvent } from "../recorder";
import { auditShipConsumer, type ShipConsumerOptions } from "./consumer";
import { AUDIT_SHIP_FORMAT, type ShippedAuditEvent } from "./event";
import { AUDIT_SHIP_MAX_RETRIES, retryDelaySeconds } from "./queue";
import { AuditSinks } from "./sinks";
import { readSinkStates } from "./state";

/** The shipping consumer (#824), against a real D1 and recorded requests. */

const db = () => auditDatabase(env.DB);

beforeEach(async () => {
  for (const table of ["pithy_audit_events", "pithy_audit_sinks"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  for (const migration of [
    audit_0001_init,
    audit_0002_actor_kind,
    audit_0003_call_index,
    audit_0004_request_index,
    audit_0005_chain,
    audit_0006_sinks,
  ]) {
    await migration.up(db() as unknown as Kysely<unknown>);
  }
});

const SINKS = AuditSinks.parse({
  splunk: { profile: "splunk-hec", url: "https://splunk.example.com/services/collector/event", secret: "splunk-token" },
  datadog: { profile: "datadog-logs", url: "https://http-intake.logs.datadoghq.com/api/v2/logs", secret: "dd-key" },
  hook: { profile: "webhook", url: "https://hooks.example.com/audit", secret: "hook-token", detail: true },
});

const TOKENS: Record<string, string> = { "splunk-token": "S", "dd-key": "D", "hook-token": "H" };

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A network that records every request and answers each URL with the status the test sets. */
function network(status: (url: string) => number = () => 200) {
  const requests: Recorded[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response("receiver said something", { status: status(url) });
  });
  return { requests, fetch };
}

function consumer(fetch: ShipConsumerOptions["fetch"], extra: Partial<ShipConsumerOptions> = {}) {
  return auditShipConsumer({
    sinks: SINKS,
    database: () => db(),
    token: async (_env, secret) => {
      const token = TOKENS[secret];
      if (token === undefined) throw new Error(`no secret ${secret}`);
      return token;
    },
    ...(fetch ? { fetch } : {}),
    now: () => new Date(1_761_600_000_000),
    ...extra,
  });
}

function message(sink: string, eventId: string, attempts = 1) {
  return {
    id: `${sink}:${eventId}:${attempts}`,
    body: { capability: "audit", sink, eventId },
    attempts,
    timestamp: new Date(),
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

type FakeMessage = ReturnType<typeof message>;
const run = (handler: ReturnType<typeof consumer>, messages: FakeMessage[]) => handler(messages, {}, {} as never);

async function record(action = "auth/login") {
  await recordAuditEvent(db(), {
    action,
    outcome: "success",
    actorType: "user",
    actorId: "u1",
    tenant: "acme",
    ip: "203.0.113.9",
    userAgent: "Mozilla/5.0",
    metadata: { email: "ada@example.com" },
  });
  const row = await env.DB.prepare("select event_id from pithy_audit_events order by id desc limit 1").first<{
    event_id: string;
  }>();
  return row?.event_id as string;
}

function splunkEvents(request: Recorded): ShippedAuditEvent[] {
  return request.body.split("\n").map((line) => JSON.parse(line).event);
}

describe("auditShipConsumer", () => {
  test("each profile receives its events in its own documented format", async () => {
    const eventId = await record();
    const { requests, fetch } = network();
    const messages = [message("splunk", eventId), message("datadog", eventId), message("hook", eventId)];
    await run(consumer(fetch), messages);

    expect(requests.map((r) => r.url)).toEqual([SINKS.splunk?.url, SINKS.datadog?.url, SINKS.hook?.url]);
    const [splunk, datadog, hook] = requests as [Recorded, Recorded, Recorded];
    expect(splunk.headers.authorization).toBe("Splunk S");
    expect(JSON.parse(splunk.body)).toMatchObject({ source: "pithy", sourcetype: "pithy:audit", event: { eventId } });
    expect(datadog.headers["dd-api-key"]).toBe("D");
    expect(JSON.parse(datadog.body)).toMatchObject([
      { ddsource: "pithy", message: "auth/login success", audit: { eventId } },
    ]);
    expect(hook.headers.authorization).toBe("Bearer H");
    expect(JSON.parse(hook.body)).toMatchObject({ format: AUDIT_SHIP_FORMAT, events: [{ eventId }] });
    for (const m of messages) expect(m.ack).toHaveBeenCalled();
  });

  test("without detail, no IP, user-agent or metadata value leaves the Worker — their salted hashes do", async () => {
    const eventId = await record();
    const { requests, fetch } = network();
    await run(consumer(fetch), [message("splunk", eventId), message("datadog", eventId)]);
    for (const request of requests) {
      expect(request.body).not.toContain("203.0.113.9");
      expect(request.body).not.toContain("Mozilla");
      expect(request.body).not.toContain("ada@example.com");
    }
    const [shipped] = splunkEvents(requests[0] as Recorded) as [ShippedAuditEvent];
    expect(shipped.ip).toBeUndefined();
    expect(shipped.salt).toBeUndefined();
    expect(shipped.ipCommitment).toMatch(/^[0-9a-f]{64}$/);
    expect(shipped.userAgentCommitment).toMatch(/^[0-9a-f]{64}$/);
    expect(shipped.metadataCommitment).toMatch(/^[0-9a-f]{64}$/);
  });

  test("with detail, the values and their salt travel, and the commitments check against them", async () => {
    const eventId = await record();
    const { requests, fetch } = network();
    await run(consumer(fetch), [message("hook", eventId)]);
    const [shipped] = JSON.parse((requests[0] as Recorded).body).events as [ShippedAuditEvent];
    expect(shipped.ip).toBe("203.0.113.9");
    expect(shipped.userAgent).toBe("Mozilla/5.0");
    expect(await commitment(shipped.salt as string, shipped.ip ?? null)).toBe(shipped.ipCommitment);
  });

  test("each delivered event carries its id and chain hash, and a redelivery carries the same", async () => {
    const eventId = await record();
    const first = network();
    await run(consumer(first.fetch), [message("hook", eventId)]);
    const again = network();
    await run(consumer(again.fetch), [message("hook", eventId, 2)]);
    const [a] = JSON.parse((first.requests[0] as Recorded).body).events as [ShippedAuditEvent];
    const [b] = JSON.parse((again.requests[0] as Recorded).body).events as [ShippedAuditEvent];
    expect(a.eventId).toBe(eventId);
    expect(b).toEqual(a);
    const { format: _f, chain: _c, seq, prev, hash, salt: _s, ip: _i, userAgent: _u, metadata: _m, ...fields } = a;
    expect(seq).toBe(1);
    expect(await chainHash({ seq: seq as number, prev }, fields)).toBe(hash);
  });

  test("a failing sink backs off and fails alone; the others deliver", async () => {
    const eventId = await record();
    const { fetch } = network((url) => (url.includes("splunk") ? 503 : 200));
    const splunk = message("splunk", eventId);
    const hook = message("hook", eventId);
    await run(consumer(fetch), [splunk, hook]);
    expect(splunk.retry).toHaveBeenCalledWith({ delaySeconds: retryDelaySeconds(1) });
    expect(splunk.ack).not.toHaveBeenCalled();
    expect(hook.ack).toHaveBeenCalled();
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(30)).toBe(3600);

    const states = await readSinkStates(db(), ["splunk", "hook"]);
    expect(states.find((s) => s.sink === "splunk")).toMatchObject({
      retrying: 1,
      deadLettered: 0,
      lastDeliveredAt: null,
    });
    expect(states.find((s) => s.sink === "hook")).toMatchObject({ retrying: 0, lastFailedAt: null });
  });

  test.each([301, 302, 307, 308])(
    "a sink answering %i is a refusal, retried, and the redirect is never followed",
    async (status) => {
      // Following it would send the token and the batch to a host nobody declared, or over plain HTTP.
      const eventId = await record();
      const seen: RequestInit[] = [];
      const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(null, { status, headers: { location: "http://collector.internal/audit" } });
      });
      const m = message("datadog", eventId);
      await run(consumer(fetch), [m]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(seen[0]?.redirect).toBe("manual");
      expect(m.ack).not.toHaveBeenCalled();
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: retryDelaySeconds(1) });
      const [state] = await readSinkStates(db(), ["datadog"]);
      expect(state).toMatchObject({ retrying: 1, lastDeliveredAt: null });
    },
  );

  test("a token that will not resolve is a failure of that sink, retried like a refusal", async () => {
    const eventId = await record();
    const { requests, fetch } = network();
    const missing = auditShipConsumer({
      sinks: AuditSinks.parse({ lost: { profile: "webhook", url: "https://x.example.com/a", secret: "never-set" } }),
      database: () => db(),
      token: async () => {
        throw new Error("secret never-set is not set");
      },
      fetch,
    });
    const m = message("lost", eventId);
    await run(missing, [m]);
    expect(requests).toHaveLength(0);
    expect(m.retry).toHaveBeenCalled();
  });

  test("an exhausted message is dead-lettered and counted; a retry that lands leaves the backlog", async () => {
    const eventId = await record();
    const down = network(() => 500);
    await run(consumer(down.fetch), [message("splunk", eventId, 1)]);
    await run(consumer(down.fetch), [message("splunk", eventId, AUDIT_SHIP_MAX_RETRIES + 1)]);
    let [state] = await readSinkStates(db(), ["splunk"]);
    expect(state).toMatchObject({ retrying: 0, deadLettered: 1 });

    const other = await record("auth/logout");
    await run(consumer(down.fetch), [message("splunk", other, 1)]);
    const up = network();
    await run(consumer(up.fetch), [message("splunk", other, 2)]);
    [state] = await readSinkStates(db(), ["splunk"]);
    expect(state).toMatchObject({ retrying: 0, deadLettered: 1 });
    expect(state?.lastDeliveredAt).toEqual(new Date(1_761_600_000_000));
  });

  test("acknowledges without delivering a sink no longer declared, an event not in the trail, and a stray body", async () => {
    const { requests, fetch } = network();
    const gone = message("removed-sink", "evt-x");
    const missing = message("splunk", "evt-not-there");
    const stray = { ...message("splunk", "x"), body: { capability: "audit" } };
    await run(consumer(fetch), [gone, missing, stray as unknown as FakeMessage]);
    expect(requests).toHaveLength(0);
    for (const m of [gone, missing, stray]) {
      expect(m.ack).toHaveBeenCalled();
      expect(m.retry).not.toHaveBeenCalled();
    }
  });

  test("one request per sink per batch, each event once however many messages name it", async () => {
    const a = await record();
    const b = await record("auth/logout");
    const { requests, fetch } = network();
    await run(consumer(fetch), [message("splunk", a), message("splunk", b), message("splunk", a, 2)]);
    expect(requests).toHaveLength(1);
    expect(splunkEvents(requests[0] as Recorded).map((e) => e.eventId)).toEqual([a, b]);
  });
});
