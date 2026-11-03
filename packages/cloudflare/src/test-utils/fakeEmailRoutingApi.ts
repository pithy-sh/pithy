// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Cloudflare API's zones and Email Routing endpoints, answering in the shapes the live API
 * returns: `GET /zones`, a zone's Email Routing settings and DNS check, and its routing rules (list, create,
 * update, delete). The SDK honors `CLOUDFLARE_BASE_URL`, so a test points it at {@link FakeEmailRoutingApi.baseUrl}
 * and every call it makes lands here, recorded.
 *
 * Every zone carries the catch-all rule Cloudflare puts on every zone (no name, `matchers: [{ type: "all" }]`), so
 * a caller that counts or matches rules meets the one it must skip.
 */

/** One zone on the fake account. */
export interface FakeZone {
  /** The zone id. */
  id: string;
  /** The zone name, e.g. `example.com`. */
  name: string;
  /** The zone's lifecycle status. Defaults to `active`. */
  status?: string;
  /** Whether the zone's own Email Routing is enabled — what its settings answer with. */
  zoneRouting: boolean;
  /** The subdomains Email Routing is set up for, whose DNS check lists no missing record. */
  routedSubdomains: string[];
  /**
   * How the DNS check answers for a subdomain: `object` is the documented `{ errors, record }`; `array` and `null` are
   * the other shape the endpoint has, a bare record list or a null `result`. Defaults to `object`.
   */
  dnsShape?: "object" | "array" | "null";
  /** Answer every Email Routing read on this zone with a 403, as a token without Zone Settings Read gets. */
  forbidSettings?: boolean;
}

/** One stored rule, in the shape the API returns. */
export interface FakeRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
}

/** The running fake. */
export interface FakeEmailRoutingApi {
  /** The base URL to hand the SDK, ending in `/client/v4`. */
  baseUrl: string;
  /** Every request, as `METHOD path?query`. */
  requests: string[];
  /** Each zone's rules, by zone id, the catch-all included. */
  rules: Map<string, FakeRule[]>;
  /** Stop the server. */
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function ok(res: ServerResponse, result: unknown, resultInfo?: unknown): void {
  send(res, 200, {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  });
}

function notFound(res: ServerResponse): void {
  send(res, 404, {
    success: false,
    errors: [{ code: 7003, message: "Could not route to the path." }],
    messages: [],
    result: null,
  });
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function catchAll(zoneId: string): FakeRule {
  return {
    id: `${zoneId}-catch-all`,
    name: "",
    enabled: false,
    priority: 2147483647,
    matchers: [{ type: "all" }],
    actions: [{ type: "drop" }],
  };
}

/** Start the fake for `accountId`, holding `zones` and any `rules` already on them. */
export function startFakeEmailRoutingApi(options: {
  accountId: string;
  zones: FakeZone[];
  rules?: Record<string, Omit<FakeRule, "priority">[]>;
}): Promise<FakeEmailRoutingApi> {
  const requests: string[] = [];
  const rules = new Map<string, FakeRule[]>();
  for (const zone of options.zones) {
    rules.set(zone.id, [
      ...(options.rules?.[zone.id] ?? []).map((rule) => ({ ...rule, priority: 0 })),
      catchAll(zone.id),
    ]);
  }
  let nextId = 1;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      const path = url.pathname.replace(/^\/client\/v4/, "");

      if (req.method === "GET" && path === "/zones") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "20");
        const owned = url.searchParams.get("account.id") === options.accountId ? options.zones : [];
        const result = owned
          .slice((page - 1) * perPage, page * perPage)
          .map(({ id, name, status }) => ({ id, name, status: status ?? "active" }));
        ok(res, result, {
          page,
          per_page: perPage,
          count: result.length,
          total_count: owned.length,
          total_pages: Math.max(1, Math.ceil(owned.length / perPage)),
        });
        return;
      }

      const zoneMatch = /^\/zones\/([^/]+)\/email\/routing(\/dns|\/rules(?:\/([^/]+))?)?$/.exec(path);
      const zone = options.zones.find((candidate) => candidate.id === zoneMatch?.[1]);
      if (!zoneMatch || !zone) {
        notFound(res);
        return;
      }
      const [, , sub, ruleId] = zoneMatch;
      const zoneRules = rules.get(zone.id) ?? [];

      if (zone.forbidSettings && req.method === "GET" && sub !== "/rules") {
        send(res, 403, {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          messages: [],
          result: null,
        });
        return;
      }

      if (sub === undefined && req.method === "GET") {
        const enabled = zone.zoneRouting;
        ok(res, {
          id: `${zone.id}-settings`,
          tag: `${zone.id}-settings`,
          name: zone.name,
          enabled,
          status: enabled ? "ready" : "unconfigured",
          skip_wizard: true,
          created: "2026-01-01T00:00:00Z",
          modified: "2026-01-01T00:00:00Z",
        });
        return;
      }

      if (sub === "/dns" && req.method === "GET") {
        const domain = url.searchParams.get("subdomain") ?? zone.name;
        const record = { type: "MX", name: domain, content: "route1.mx.cloudflare.net", priority: 13, ttl: 1 };
        if (zone.dnsShape === "array") {
          ok(res, [record]);
          return;
        }
        if (zone.dnsShape === "null") {
          ok(res, null);
          return;
        }
        const enabled = zone.routedSubdomains.includes(domain);
        ok(res, { errors: enabled ? [] : [{ code: "mx.missing", missing: record }], record: [record] });
        return;
      }

      if (sub === "/rules" && req.method === "GET") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "20");
        const slice = zoneRules.slice((page - 1) * perPage, page * perPage);
        ok(res, slice, { page, per_page: perPage, count: slice.length, total_count: zoneRules.length });
        return;
      }

      if (sub === "/rules" && req.method === "POST") {
        const input = await body(req);
        const rule: FakeRule = {
          id: `rule-${nextId++}`,
          name: String(input.name ?? ""),
          enabled: input.enabled !== false,
          priority: Number(input.priority ?? 0),
          matchers: (input.matchers ?? []) as FakeRule["matchers"],
          actions: (input.actions ?? []) as FakeRule["actions"],
        };
        zoneRules.splice(zoneRules.length - 1, 0, rule);
        ok(res, rule);
        return;
      }

      const index = zoneRules.findIndex((rule) => rule.id === ruleId);
      if (sub?.startsWith("/rules/") && index !== -1) {
        if (req.method === "PUT") {
          const input = await body(req);
          const current = zoneRules[index] as FakeRule;
          const rule: FakeRule = {
            ...current,
            name: input.name === undefined ? current.name : String(input.name),
            enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
            matchers: (input.matchers ?? current.matchers) as FakeRule["matchers"],
            actions: (input.actions ?? current.actions) as FakeRule["actions"],
          };
          zoneRules[index] = rule;
          ok(res, rule);
          return;
        }
        if (req.method === "DELETE") {
          const [removed] = zoneRules.splice(index, 1);
          ok(res, removed);
          return;
        }
      }
      notFound(res);
    })().catch((error: unknown) => send(res, 500, { success: false, errors: [{ code: 1, message: String(error) }] }));
  });

  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      done({
        baseUrl: `http://127.0.0.1:${address.port}/client/v4`,
        requests,
        rules,
        close: () => new Promise<void>((closed) => server.close(() => closed())),
      });
    });
  });
}
