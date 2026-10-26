// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { leavesIn, unpublishedIn } from "@pithy-sh/core/src/projection/published";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import type { PaymentsRail } from "../data/rail";
import { PAYMENTS_WEBHOOK_EVENTS_TABLE, paymentsDatabase } from "../data/tables";
import { PaymentsWebhookEvent, type PaymentsWebhookEventTargets } from "../data/webhookEvent";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_allowances } from "../migrations/0002_allowances";
import { payments_0003_webhook_targets } from "../migrations/0003_webhook_targets";
import { PaymentsAdminWebhookEventsResponse, PaymentsAdminWebhookEventView } from "./responses";
import { registerPaymentsRoutes } from "./routes";
import { PAYMENTS_PURCHASES_READ_SCOPE, PAYMENTS_RECONCILE_READ_SCOPE, PAYMENTS_WEBHOOKS_READ_SCOPE } from "./scopes";

/**
 * The webhook-event read (#830), executed — real D1, the real control-plane seam, a real Ed25519 token.
 *
 * **The read that explains the other two findings.** A purchase that is paid and not entitled, or entitled and
 * not paid, is usually a notification that arrived and never projected. This is where a management client
 * sees that notification: arrived, still pending with its attempts, or given up on — and what it changed when
 * it did project. What it never sees is the provider's document, or the store's sentence about a failure.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONNECTION_ID = "8a2f1c3e-5b4d-4e6f-9a7b-1c2d3e4f5a6b";
const CONTROL_PLANE_ISSUER = "https://dashboard.example";
const CONTROL_PLANE_KEY_ID = "key-1";
const ENVIRONMENT = "prod";

const CONFIG = PaymentsConfig.parse({
  billingSubject: "user",
  entitlements: { pro: { name: "pro" } },
  rails: { stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    pro_monthly: { type: "subscription", name: "Pro", entitlements: ["pro"], stripe: { priceId: "price_1Pro" } },
  },
});

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: CONTROL_PLANE_ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
    scopes: [...scopes],
    keys: [
      {
        keyId: CONTROL_PLANE_KEY_ID,
        publicKey: await exportPublicJwk(keys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function verifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const spent = new Set<string>();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (spent.has(jti)) return false;
        spent.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

function makeApp(scopes: readonly ControlPlaneScope[], basePath?: string) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerPaymentsRoutes({ config: CONFIG, now: () => NOW, ...(basePath === undefined ? {} : { basePath }) })(app);
  return app;
}

/** A GET carrying a freshly minted, single-use control-plane token bound to one scope. */
async function call(app: Hono<PithyHonoEnv>, path: string, scope: ControlPlaneScope): Promise<Response> {
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method: "GET", headers: { [CONTROL_PLANE_HEADER]: token } },
    { ...env, ENVIRONMENT },
  );
}

/** The body exactly as it left the Worker — what a disclosure gate is about. */
async function readRaw(query = ""): Promise<unknown> {
  const response = await call(
    makeApp([PAYMENTS_WEBHOOKS_READ_SCOPE]),
    `/payments/admin/webhook-events${query}`,
    PAYMENTS_WEBHOOKS_READ_SCOPE,
  );
  expect(response.status).toBe(200);
  return await response.json();
}

/** The same body through the schema a dashboard parses it with. */
async function read(query = ""): Promise<PaymentsAdminWebhookEventsResponse> {
  return PaymentsAdminWebhookEventsResponse.parse(await readRaw(query));
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

/**
 * A payload carrying everything a store's document carries that must not cross: the customer's email and
 * name, a card's last four, and a receipt-shaped secret. Every value is a sentinel nothing else here produces.
 */
const SENTINEL_PAYLOAD = {
  id: "evt_sentinel",
  type: "invoice.payment_failed",
  data: {
    object: {
      customer_email: "ada.sentinel@example.com",
      customer_name: "Ada Sentinel",
      payment_method_details: { card: { last4: "4242" } },
      receipt: "s3cret-receipt-sentinel",
    },
  },
};

/** The store's own sentence about a failure — a transaction id and an amount, nothing a client should read. */
const SENTINEL_ERROR =
  'payments/product_not_found: No catalog product maps the stripe SKU "price_SentinelSku" on in_Sentinel for 9900.';

/** One recorded delivery, written through the row schema exactly as the guard writes one. */
async function event(options: {
  id: string;
  minute: number;
  rail?: PaymentsRail;
  payload?: Record<string, unknown>;
  processed?: boolean;
  abandoned?: boolean;
  error?: string | null;
  attempts?: number;
  targets?: PaymentsWebhookEventTargets | null;
}): Promise<void> {
  const at = new Date(NOW.getTime() - (60 - options.minute) * 60_000);
  await paymentsDatabase(env.DB)
    .insertInto(PAYMENTS_WEBHOOK_EVENTS_TABLE)
    .values(
      PaymentsWebhookEvent.encode({
        id: options.id,
        rail: options.rail ?? "stripe",
        providerEventId: `evt_${options.id}`,
        payload: options.payload ?? SENTINEL_PAYLOAD,
        receivedAt: at,
        processedAt: options.processed ? at : null,
        abandonedAt: options.abandoned ? at : null,
        error: options.error ?? null,
        attempts: options.attempts ?? 0,
        projectedTargets: options.targets ?? null,
        createdAt: at,
      }),
    )
    .execute();
}

const receivedAt = (minute: number) => new Date(NOW.getTime() - (60 - minute) * 60_000).toISOString();

beforeEach(async () => {
  for (const table of [
    "pithy_payments_webhook_events",
    "pithy_payments_reconcile_runs",
    "pithy_payments_sync_cursors",
    "pithy_payments_overrides",
    "pithy_payments_meter_counters",
    "pithy_payments_usage_reports",
    "pithy_payments_usage_runs",
    "pithy_payments_provider_accounts",
    "pithy_payments_entitlements",
    "pithy_payments_purchases",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await payments_0001_purchases.up(db);
  await payments_0002_allowances.up(db);
  await payments_0003_webhook_targets.up(db);
  emitted = [];
});

describe("GET /payments/admin/webhook-events", () => {
  test("pages every notification newest received first, each with the fields a client reads", async () => {
    await event({ id: "e1", minute: 1, processed: true, targets: { purchaseIds: [], subscriptionIds: ["s1"] } });
    await event({ id: "e2", minute: 2, error: "projection failed", attempts: 2 });
    await event({ id: "e3", minute: 3, abandoned: true, error: "quarantined: after 3 attempts", attempts: 3 });

    const first = await read("?limit=2");
    expect(first.events.map((each) => each.id)).toEqual(["e3", "e2"]);
    expect(first.nextCursor).not.toBeNull();
    const rest = await read(`?limit=2&cursor=${first.nextCursor}`);
    expect(rest.events.map((each) => each.id)).toEqual(["e1"]);
    expect(rest.nextCursor).toBeNull();

    expect(first.events[0]).toEqual({
      id: "e3",
      rail: "stripe",
      providerEventId: "evt_e3",
      eventType: "invoice.payment_failed",
      receivedAt: receivedAt(3),
      state: "abandoned",
      attempts: 3,
      errorCode: "quarantined",
      targets: null,
    });
    expect(rest.events[0]).toMatchObject({
      state: "projected",
      attempts: 0,
      errorCode: null,
      targets: { purchaseIds: [], subscriptionIds: ["s1"] },
    });
  });

  test("an event that arrived and never projected reads as pending or abandoned, never as missing", async () => {
    // The finding the dashboard's revenue-integrity pane exists for. Never tried, tried and failed, and given
    // up on are all on the page, each with its state and its count.
    await event({ id: "never-tried", minute: 1 });
    await event({ id: "tried", minute: 2, error: "orphaned: no subject could be resolved", attempts: 0 });
    await event({ id: "given-up", minute: 3, abandoned: true, error: "quarantined: after 3", attempts: 3 });
    const states = Object.fromEntries((await read()).events.map((each) => [each.id, [each.state, each.attempts]]));
    expect(states).toEqual({ "never-tried": ["pending", 0], tried: ["pending", 0], "given-up": ["abandoned", 3] });
    const pending = await read("?state=pending");
    expect(pending.events.map((each) => each.id)).toEqual(["tried", "never-tried"]);
  });

  test("filters by rail, by state, and by a received window", async () => {
    await event({ id: "stripe-old", minute: 1, processed: true });
    await event({ id: "paddle", minute: 2, rail: "paddle", payload: { event_type: "subscription.activated" } });
    await event({ id: "stripe-new", minute: 3, processed: true });

    expect((await read("?rail=paddle")).events.map((each) => each.id)).toEqual(["paddle"]);
    expect((await read("?state=projected")).events.map((each) => each.id)).toEqual(["stripe-new", "stripe-old"]);
    const window = await read(`?since=${encodeURIComponent(receivedAt(2))}&until=${encodeURIComponent(receivedAt(3))}`);
    expect(window.events.map((each) => each.id)).toEqual(["paddle"]);
    expect(window.events[0]?.eventType).toBe("subscription.activated");
  });

  test("a window that ends before it starts, or a state that does not exist, is a 400", async () => {
    const app = makeApp([PAYMENTS_WEBHOOKS_READ_SCOPE]);
    const backwards = await call(
      app,
      `/payments/admin/webhook-events?since=${encodeURIComponent(receivedAt(3))}&until=${encodeURIComponent(receivedAt(1))}`,
      PAYMENTS_WEBHOOKS_READ_SCOPE,
    );
    expect(backwards.status).toBe(400);
    expect(await errorCode(backwards)).toBe("validation/invalid_input");
    const unknown = await call(app, "/payments/admin/webhook-events?state=failed", PAYMENTS_WEBHOOKS_READ_SCOPE);
    expect(unknown.status).toBe(400);
  });

  test("an event projected before targets were recorded reads as unrecorded, not as having changed nothing", async () => {
    await event({ id: "older", minute: 1, processed: true });
    await event({ id: "nothing", minute: 2, processed: true, targets: { purchaseIds: [], subscriptionIds: [] } });
    const byId = Object.fromEntries((await read()).events.map((each) => [each.id, each.targets]));
    expect(byId).toEqual({ older: null, nothing: { purchaseIds: [], subscriptionIds: [] } });
  });

  test("a connection without the scope is refused, not handed the log", async () => {
    const response = await call(
      makeApp([PAYMENTS_PURCHASES_READ_SCOPE]),
      "/payments/admin/webhook-events",
      PAYMENTS_PURCHASES_READ_SCOPE,
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
  });

  test("the scope confers nothing elsewhere, and the reconcile log's scope confers nothing here", async () => {
    // `scopeCovers` matches exactly. A health monitor on the run log must not acquire every customer's
    // notifications, and a tool reading notifications must not acquire the purchase log.
    expect(
      (await call(makeApp([PAYMENTS_WEBHOOKS_READ_SCOPE]), "/payments/admin/purchases", PAYMENTS_WEBHOOKS_READ_SCOPE))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          makeApp([PAYMENTS_RECONCILE_READ_SCOPE]),
          "/payments/admin/webhook-events",
          PAYMENTS_RECONCILE_READ_SCOPE,
        )
      ).status,
    ).toBe(403);
  });

  test("mounted where payments is mounted", async () => {
    await event({ id: "e1", minute: 1 });
    const response = await call(
      makeApp([PAYMENTS_WEBHOOKS_READ_SCOPE], "/billing"),
      "/billing/admin/webhook-events",
      PAYMENTS_WEBHOOKS_READ_SCOPE,
    );
    expect(response.status).toBe(200);
  });

  test("the read is audited, naming the operator, the connection and the filters", async () => {
    await event({ id: "e1", minute: 1 });
    await read("?rail=stripe&state=pending");
    const audited = emitted.find((each) => each.action === "payments/webhook_events_read");
    expect(audited?.actorType).toBe("control-plane");
    expect(audited?.actorId).toBe("operator-1");
    expect(audited?.metadata?.connectionId).toBe(CONNECTION_ID);
    expect(audited?.metadata?.returned).toBe(1);
    expect(audited?.metadata?.filters).toEqual({ rail: "stripe", state: "pending", since: null, until: null });
  });
});

/**
 * **No payload, and no error sentence, crosses** — asserted against an event that has both.
 *
 * The sweep is `@pithy-sh/core`'s {@link unpublishedIn} over the **raw** body, with the permitted keys written
 * out by hand and the permitted leaves listed from the row: every value in the response must be one of the
 * facts this read publishes, and every key one of the names below. A gate derived from the schema it polices
 * cannot fail when the schema widens, which is how the catalog's own sweep once passed while widening (#308).
 */
describe("what the webhook-event read discloses", () => {
  const PERMITTED_KEYS = [
    "events",
    "nextCursor",
    "id",
    "rail",
    "providerEventId",
    "eventType",
    "receivedAt",
    "state",
    "attempts",
    "errorCode",
    "targets",
    "purchaseIds",
    "subscriptionIds",
  ];

  const TARGETS = { purchaseIds: ["p-sentinel"], subscriptionIds: ["s-sentinel"] };

  /** Every fact the one event legitimately discloses, plus the envelope's null end-of-page. */
  const PUBLISHED = [
    "w-sentinel",
    "stripe",
    "evt_w-sentinel",
    "invoice.payment_failed",
    receivedAt(5),
    "projected",
    4,
    "payments/product_not_found",
    "p-sentinel",
    "s-sentinel",
    null,
  ];

  async function sentinel(): Promise<void> {
    // Finished after four tries, with the store's sentence still on the row — the case where both the
    // payload and an error are present and neither may cross.
    await event({ id: "w-sentinel", minute: 5, processed: true, error: SENTINEL_ERROR, attempts: 4, targets: TARGETS });
  }

  test("nothing but the published facts can cross it, whatever a field is called", async () => {
    await sentinel();
    const raw = await readRaw();
    const escaped = unpublishedIn(raw, { leaves: PUBLISHED, keys: PERMITTED_KEYS });
    expect(
      escaped,
      `These crossed the webhook-event read and are neither a key it publishes nor a fact it records:\n  ${escaped.join("\n  ")}`,
    ).toEqual([]);
    const body = JSON.stringify(raw);
    for (const secret of [
      "ada.sentinel@example.com",
      "Ada Sentinel",
      "4242",
      "s3cret-receipt-sentinel",
      "price_SentinelSku",
      "in_Sentinel",
      "9900",
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  test("the sweep is running against an event that really carries all of it", async () => {
    // A gate over nothing passes perfectly: every permitted fact is genuinely a leaf of the row it read.
    await sentinel();
    const raw = (await readRaw()) as { events: Record<string, unknown>[] };
    expect(raw.events).toHaveLength(1);
    const carried = leavesIn(raw.events[0]);
    for (const fact of PUBLISHED) {
      if (fact === null) continue;
      expect(carried, `the event does not carry ${JSON.stringify(fact)}`).toContain(fact);
    }
    // And the row the gate read genuinely holds the payload and the sentence it withheld.
    const stored = await paymentsDatabase(env.DB)
      .selectFrom(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      .select(["payload", "error"])
      .executeTakeFirst();
    expect(stored?.payload).toContain("ada.sentinel@example.com");
    expect(stored?.error).toBe(SENTINEL_ERROR);
  });

  test("the response schema declares nothing the hand-written key list does not name", () => {
    const declared = [
      "events",
      "nextCursor",
      ...Object.keys(PaymentsAdminWebhookEventView.shape),
      "purchaseIds",
      "subscriptionIds",
    ];
    expect(declared.filter((key) => !PERMITTED_KEYS.includes(key))).toEqual([]);
    expect(PERMITTED_KEYS.filter((key) => !declared.includes(key))).toEqual([]);
  });
});
