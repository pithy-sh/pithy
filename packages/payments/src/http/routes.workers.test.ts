import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/http/verify";
import type { ReplayGuard } from "@pithy-sh/core/src/controlPlane/kv/replay";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { openLedger } from "@pithy-sh/ledger/src/ledger";
import { ledger_0001_accounts } from "@pithy-sh/ledger/src/migrations/0001_accounts";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PaymentsAuditActions } from "../audit/actions";
import { PaymentsConfig, type PaymentsConfigInput } from "../config/config";
import { paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { linkProviderAccount } from "../projection/owner";
import { projectPurchase } from "../projection/writer";
import {
  type MintedChain,
  mintChain,
  type NotificationFixture,
  signJws,
  signNotification,
} from "../rails/apple/fixtures/chain";
import didFailToRenewGrace from "../rails/apple/fixtures/did-fail-to-renew-grace.json" with { type: "json" };
import didRenew from "../rails/apple/fixtures/did-renew.json" with { type: "json" };
import oneTimeCharge from "../rails/apple/fixtures/one-time-charge.json" with { type: "json" };
import refundFixture from "../rails/apple/fixtures/refund.json" with { type: "json" };
import subscribedSandbox from "../rails/apple/fixtures/subscribed-initial-buy-sandbox.json" with { type: "json" };
import testFixture from "../rails/apple/fixtures/test.json" with { type: "json" };
import playProduct from "../rails/google/fixtures/play-product-purchased.json" with { type: "json" };
import playSubscription from "../rails/google/fixtures/play-subscription-active.json" with { type: "json" };
import {
  type MintedOidcKey,
  type MintedServiceAccountKey,
  mintOidcKey,
  mintServiceAccountKey,
  pushBody,
  signOidcToken,
} from "../rails/google/fixtures/push";
import rtdnOneTime from "../rails/google/fixtures/rtdn-one-time-purchased.json" with { type: "json" };
import rtdnRenewed from "../rails/google/fixtures/rtdn-subscription-renewed.json" with { type: "json" };
import rtdnRevoked from "../rails/google/fixtures/rtdn-subscription-revoked.json" with { type: "json" };
import rtdnTest from "../rails/google/fixtures/rtdn-test.json" with { type: "json" };
import rtdnVoided from "../rails/google/fixtures/rtdn-voided-purchase.json" with { type: "json" };
import type { GoogleHttpFetch } from "../rails/google/http";
import { GOOGLE_JWKS_URL, resetGoogleJwksCache } from "../rails/google/oidc";
import { GOOGLE_TOKEN_URL } from "../rails/google/playApi";
import type { StripeHttpFetch } from "../rails/stripe/api";
import chargeRefunded from "../rails/stripe/fixtures/event-charge-refunded.json" with { type: "json" };
import stripeInvoicePaid from "../rails/stripe/fixtures/event-invoice-paid.json" with { type: "json" };
import stripeSessionPayment from "../rails/stripe/fixtures/event-session-completed-payment.json" with { type: "json" };
import stripeSessionSubscription from "../rails/stripe/fixtures/event-session-completed-subscription.json" with {
  type: "json",
};
import stripeSubscriptionCanceled from "../rails/stripe/fixtures/event-subscription-canceled.json" with {
  type: "json",
};
import stripeSubscriptionCreated from "../rails/stripe/fixtures/event-subscription-created.json" with { type: "json" };
import stripeSubscriptionDeleted from "../rails/stripe/fixtures/event-subscription-deleted.json" with { type: "json" };
import {
  STRIPE_TEST_SECRET_KEY,
  STRIPE_TEST_WEBHOOK_SECRET,
  type StripeRecordedCall,
  stripeSignatureHeader,
} from "../rails/stripe/fixtures/events";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "../secret/registry";
import {
  PAYMENTS_CONTROL_PLANE_SCOPES,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
} from "./guards";
import { registerPaymentsRoutes } from "./routes";

const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
];

/**
 * The ledger's own tables, in the same D1 — both capabilities bind `DB`.
 *
 * They are here because the suite's catalog sells a coin pack with a `grants` clause, which is the realistic
 * shape: a project that credits a balance composes the ledger. Their presence is also what lets the routes
 * prove fulfillment end to end rather than only up to the projection.
 */
const LEDGER_TABLES = ["pithy_ledger_accounts", "pithy_ledger_transactions", "pithy_ledger_holds"];

const BUNDLE_ID = "com.acme.app";
/** Mid-period for the recorded transaction, which runs 2026-01-01 to 2026-02-01. */
const NOW = new Date("2026-01-15T00:00:00.000Z");
const APPLE_ACCOUNT = "3f6c1d20-8a4b-4f77-9c31-b0e5d2a91746";

const PACKAGE_NAME = "com.acme.app";
const PUBSUB_AUDIENCE = "https://acme.example/payments/webhooks/google";
const GOOGLE_SERVICE_ACCOUNT = "pithy-rtdn@acme-42.iam.gserviceaccount.com";
const GOOGLE_ACCOUNT = "b7e1c94f2a6d4c0e";

const STRIPE_CUSTOMER = "cus_PithyAda";
const STRIPE_RETURN_URLS = {
  successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
  cancelUrl: "https://acme.example/pricing",
  portalReturnUrl: "https://acme.example/account",
};

const CATALOG: PaymentsConfigInput = {
  rails: { apple: true, google: true, stripe: true },
  stripe: STRIPE_RETURN_URLS,
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
      google: { productId: "pro_monthly" },
      stripe: { priceId: "price_1Abc" },
    },
    coins_100: {
      type: "consumable",
      name: "100 coins",
      grants: { ledger: { currency: "coins", amount: 100 } },
      apple: { productId: "com.acme.coins100" },
      google: { productId: "coins_100" },
      stripe: { priceId: "price_1Coins" },
    },
  },
};

const CREDENTIALS = {
  apple: {
    bundleId: BUNDLE_ID,
    keyId: "2X9R4HXF34",
    issuerId: "57246542-96fe-1a63-e053-0824d011072a",
    privateKey: "-----BEGIN PRIVATE KEY-----\nMIG…\n-----END PRIVATE KEY-----",
  },
  google: {
    packageName: PACKAGE_NAME,
    serviceAccountEmail: GOOGLE_SERVICE_ACCOUNT,
    privateKey: "",
    pubsubAudience: PUBSUB_AUDIENCE,
  },
  stripe: {
    secretKey: STRIPE_TEST_SECRET_KEY,
    webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
  },
};

/** One chain for the suite. Real ECDSA keys, real certificates — just not Apple's. */
let chain: MintedChain;
/** Google's push signing key, and one nobody published. */
let googleKey: MintedOidcKey;
let unpublishedKey: MintedOidcKey;
/** The service-account key, so the assertion the Play lookup signs is a real one. */
let serviceAccountKey: MintedServiceAccountKey;
/** Every emitted audit event, so the trail is asserted rather than assumed. */
let emitted: AuditEventInput[];

/**
 * The control-plane connection this suite's Worker is connected to.
 *
 * The two admin routes are exercised through the **real** verification pipeline — a genuine Ed25519 signature
 * over genuine claims, checked by `createControlPlaneVerifier` against a registration that exists — rather than
 * through a stub that says yes. That is what makes the negative cases mean something: a call refused here is
 * refused by the same code that would refuse it in production, not by a fake.
 */
const CONNECTION_ID = "1f6b4d8e-5c02-4a37-9b41-0d7e3a91c8f5";
const CONTROL_PLANE_ISSUER = "https://app.pithy.sh";
const CONTROL_PLANE_KEY_ID = "k-2026-01";
/** The connection's environment, matched against the Worker's own. `production`, like every request below. */
const CONTROL_PLANE_ENVIRONMENT = "production";

/** The management client's signing key. Only the public half is ever registered. */
let controlPlaneKeys: CryptoKeyPair;

beforeAll(async () => {
  chain = await mintChain();
  googleKey = await mintOidcKey();
  unpublishedKey = await mintOidcKey("nobody-published-this");
  serviceAccountKey = await mintServiceAccountKey();
  CREDENTIALS.google.privateKey = serviceAccountKey.pem;
  controlPlaneKeys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

/** The registration the adopter stored, with whatever scopes a case wants granted. */
async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: CONTROL_PLANE_ENVIRONMENT,
    issuer: CONTROL_PLANE_ISSUER,
    workerUrl: "https://acme.example",
    scopes: [...scopes],
    keys: [
      {
        keyId: CONTROL_PLANE_KEY_ID,
        publicKey: await exportPublicJwk(controlPlaneKeys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

/** A replay set per app, so one token is spendable once and a second presentation is refused for real. */
function memoryReplayGuard(): ReplayGuard {
  const spent = new Set<string>();
  return {
    async claim(jti) {
      if (spent.has(jti)) return false;
      spent.add(jti);
      return true;
    },
  };
}

/**
 * The verifier the seam's own middleware would publish, over one in-memory connection.
 *
 * The registration is resolved lazily inside `loadConnection` — exporting a JWK is async and `makeApp` is not,
 * and a verifier that awaits its own registration on first use is closer to the real one (which reads D1)
 * than a suite-wide fixture would be. `countConnections` answers 1 always, so an unknown `aud` reads as a
 * credential failure rather than as "nothing is connected here".
 */
function controlPlaneVerifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const replay = memoryReplayGuard();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay,
    environment: CONTROL_PLANE_ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

beforeEach(async () => {
  for (const table of [...TABLES, ...LEDGER_TABLES]) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  const migrationDb = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  await payments_0001_purchases.up(migrationDb);
  await ledger_0001_accounts.up(migrationDb);
  emitted = [];
  stripeCalls = [];
  // Google's published keys are cached per isolate, which is right in a Worker and wrong across tests.
  resetGoogleJwksCache();
  // The routes read credentials through the shared per-invocation accessor, so it is configured with payments'
  // own slice. With no `ENVIRONMENT` var, the reader takes the local-dev path and resolves each secret from its
  // injected string binding — so no secrets D1 and no master key are needed here.
  configureSharedSecrets({ registry: paymentsSecretsRegistry });
});

afterEach(() => resetSharedSecrets());

/**
 * The routes, with a fake auth middleware and a recording audit seam, so guards and the trail are exercised
 * without depending on `@pithy-sh/auth` or `@pithy-sh/audit`.
 *
 * The suite's own certificate root is added to the trust set, which is what lets these cases reach the happy
 * path with genuinely-signed artifacts rather than a stubbed verifier. The extension is **additive** — Apple's
 * pinned roots are always trusted — and `trustedApple: false` below drops it, which is how the tests prove
 * production's default refuses a chain Apple did not issue.
 */
interface AppOptions {
  /** Drop the suite's certificate root, so Apple's default trust set is what decides. */
  trustedApple?: boolean;
  /** Drop the suite's push key from the configured set, so Google's published keys are what decides. */
  trustedGoogle?: boolean;
  /** What Play answers. Absent bodies are 404s; `status` makes every lookup fail with that code. */
  play?: { subscription?: unknown; product?: unknown; status?: number };
  /** What Stripe's API answers. Absent bodies are 404s; `status` makes every call fail with that code. */
  stripe?: { checkout?: unknown; portal?: unknown; session?: unknown; status?: number };
  /**
   * The control-plane seam. Absent means composed with both payments scopes granted; a shorter list narrows
   * the grant; **`null` means the seam is not composed at all** — a Worker that never added `controlplane()`,
   * where `createBackend` seeds the verifier as null and every admin route must therefore deny.
   */
  controlPlane?: readonly ControlPlaneScope[] | null;
}

/** Every call the Stripe rail made, so a test can assert what left the Worker and not only what came back. */
let stripeCalls: StripeRecordedCall[];

/**
 * A Stripe transport that answers the three endpoints hosted checkout needs.
 *
 * No signature is involved on this side — Stripe's API is reached with the secret key, and the suite asserts
 * that the key travels and that nothing else does. The webhook direction is where real cryptography is
 * exercised, and that runs against a genuine HMAC.
 */
function stripeTransport(options: AppOptions): StripeHttpFetch {
  return async (url, init) => {
    stripeCalls.push({ url, init });
    if (options.stripe?.status !== undefined) {
      return { ok: false, status: options.stripe.status, text: async () => "{}" };
    }
    const body = url.includes("/billing_portal/sessions")
      ? options.stripe?.portal
      : url.includes("/checkout/sessions/")
        ? options.stripe?.session
        : options.stripe?.checkout;
    if (body === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

/**
 * A Google transport that publishes the suite's push key, mints access tokens, and answers Play lookups.
 *
 * Publishing the key at Google's own JWKS URL is what makes the negative cases real: a token signed by
 * {@link unpublishedKey} is refused because Google does not publish that key, not because a stub said no.
 */
function googleTransport(options: AppOptions): GoogleHttpFetch {
  return async (url) => {
    if (url === GOOGLE_JWKS_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ keys: [googleKey.jwk] }) };
    }
    if (url === GOOGLE_TOKEN_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "ya29.test" }) };
    }
    if (options.play?.status !== undefined) {
      return { ok: false, status: options.play.status, text: async () => "{}" };
    }
    const body = url.includes("/subscriptionsv2/") ? options.play?.subscription : options.play?.product;
    if (body === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

function makeApp(input: PaymentsConfigInput = CATALOG, options: AppOptions = {}) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  // Built once per app, so a replay set spans the requests one test makes.
  const verifier =
    options.controlPlane === null ? null : controlPlaneVerifier(options.controlPlane ?? PAYMENTS_CONTROL_PLANE_SCOPES);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    const scopes = c.req.header("x-scopes")?.split(",").filter(Boolean) ?? [];
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes } : null);
    // Null, not absent, when the seam is not composed — the shape `createBackend` seeds either way.
    c.set("controlPlaneVerifier", verifier);
    c.set("emit", async (event) => {
      emitted.push(event);
    });
    await next();
  });
  registerPaymentsRoutes({
    config: PaymentsConfig.parse(input),
    now: () => NOW,
    trust: {
      ...(options.trustedApple === false ? {} : { appleTrustedRoots: [chain.root] }),
      ...(options.trustedGoogle === false ? {} : { googleTrustedKeys: [googleKey.jwk] }),
      googleTransport: googleTransport(options),
      stripeTransport: stripeTransport(options),
    },
  })(app);
  return app;
}

interface RequestOptions {
  user?: string;
  scopes?: string;
  body?: unknown;
  /** A raw body, for the unparseable-JSON cases. */
  raw?: string;
  /** This deployment's environment. `production` unless a case says otherwise. */
  environment?: string | null;
  /** The credential bundle on the env. Defaults to a provisioned Apple and Google block. */
  credentials?: unknown;
  /** The `Authorization` header — where a Pub/Sub push carries its OIDC token. */
  authorization?: string;
  /**
   * Present a control-plane credential: a real Ed25519 token, minted over the exact bytes this request sends
   * and for the one operation named here. Absent means no credential, which is what every negative case wants.
   */
  controlPlane?: {
    /** The single operation the token is minted for. Not necessarily the one the route requires. */
    scope: string;
    /** Who, in the management client's own id space, is acting. Lands on the audit event as `actorId`. */
    subject?: string;
    /** The connection the token addresses. Bend it to prove an unknown `aud` is refused. */
    connectionId?: string;
    /** A fixed `jti`, so two requests can present the same token and the replay guard can refuse the second. */
    tokenId?: string;
  };
}

async function request(app: Hono<PithyHonoEnv>, method: string, path: string, options: RequestOptions = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.user) headers["x-user"] = options.user;
  if (options.scopes) headers["x-scopes"] = options.scopes;
  if (options.authorization) headers.authorization = options.authorization;
  const body =
    options.raw ?? (method !== "GET" && options.body !== undefined ? JSON.stringify(options.body) : undefined);
  if (options.controlPlane) {
    headers[CONTROL_PLANE_HEADER] = await mintControlPlaneToken({
      privateKey: controlPlaneKeys.privateKey,
      keyId: CONTROL_PLANE_KEY_ID,
      issuer: CONTROL_PLANE_ISSUER,
      connectionId: options.controlPlane.connectionId ?? CONNECTION_ID,
      subject: options.controlPlane.subject ?? "support-1",
      scope: options.controlPlane.scope,
      // The digest covers these exact bytes, so a token cannot be lifted onto a different body.
      body: body === undefined ? undefined : new TextEncoder().encode(body),
      now: () => NOW,
      ...(options.controlPlane.tokenId === undefined ? {} : { tokenId: options.controlPlane.tokenId }),
    });
  }
  const bindings: Record<string, unknown> = {
    ...env,
    [PAYMENTS_PROVIDER_SECRET]: JSON.stringify(options.credentials ?? CREDENTIALS),
  };
  const environment = options.environment === undefined ? "production" : options.environment;
  if (environment !== null) bindings.ENVIRONMENT = environment;
  return app.request(`http://x${path}`, { method, headers, body }, bindings);
}

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

/** A signed Apple transaction — the artifact StoreKit 2 hands an app. */
const receipt = (overrides: Record<string, unknown> = {}) => signJws({ ...didRenew.transaction, ...overrides }, chain);

/** A signed Apple notification, nested JWS and all. */
const notification = (fixture: NotificationFixture = didRenew) => signNotification(fixture, chain);

/** A Pub/Sub push OIDC token, with whatever claims a case needs bent. */
async function pushToken(overrides: Record<string, unknown> = {}, key: MintedOidcKey = googleKey) {
  const seconds = Math.floor(NOW.getTime() / 1000);
  return `Bearer ${await signOidcToken(
    {
      aud: PUBSUB_AUDIENCE,
      email: GOOGLE_SERVICE_ACCOUNT,
      email_verified: true,
      exp: seconds + 3600,
      iat: seconds - 60,
      iss: "https://accounts.google.com",
      sub: "112233445566778899000",
      ...overrides,
    },
    key,
  )}`;
}

/** One Pub/Sub push, as Google delivers it: the envelope in the body, the proof in the header. */
async function push(
  app: Hono<PithyHonoEnv>,
  notificationPayload: unknown,
  options: RequestOptions & { messageId?: string; token?: string } = {},
) {
  return request(app, "POST", "/payments/webhooks/google", {
    ...options,
    raw: pushBody(notificationPayload, { messageId: options.messageId }),
    authorization: options.token === undefined ? await pushToken() : options.token,
  });
}

/** What Play Billing's `Purchase.getOriginalJson()` hands an app. */
const playReceipt = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    orderId: "GPA.3311-8452-9910-77301..0",
    packageName: PACKAGE_NAME,
    productId: "pro_monthly",
    purchaseToken: rtdnRenewed.subscriptionNotification.purchaseToken,
    purchaseState: 0,
    quantity: 1,
    acknowledged: false,
    ...overrides,
  });

const db = () => paymentsDatabase(env.DB);
const purchases = () => db().selectFrom("pithyPaymentsPurchases").selectAll().orderBy("createdAt").execute();
const entitlements = () => db().selectFrom("pithyPaymentsEntitlements").selectAll().orderBy("entitlement").execute();
const webhookEvents = () => db().selectFrom("pithyPaymentsWebhookEvents").selectAll().orderBy("receivedAt").execute();
const actions = () => emitted.map((event) => `${event.action}:${event.outcome}`);

describe("POST /payments/purchases", () => {
  test("verifies a receipt, projects it, and returns the entitlement it granted", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      purchase: {
        id: expect.any(String),
        rail: "apple",
        productId: "pro_monthly",
        type: "subscription",
        status: "active",
        environment: "production",
        purchasedAt: new Date(didRenew.transaction.purchaseDate).toISOString(),
        expiresAt: new Date(didRenew.transaction.expiresDate).toISOString(),
        outcome: "created",
      },
      entitlements: [
        { key: "pro", granted: true, expiresAt: new Date(didRenew.transaction.expiresDate).toISOString() },
      ],
    });
    expect(await purchases()).toHaveLength(1);
    expect(actions()).toEqual(["payments/purchase_verified:success"]);
  });

  test("links the store account, so the next webhook for this subscription is not orphaned", async () => {
    await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    const links = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ rail: "apple", providerAccountId: APPLE_ACCOUNT, userId: "ada" });
  });

  test("a replay by the same owner is a 200 with the existing purchase, not an error", async () => {
    // The write path is idempotent, so a client re-submitting on every launch is normal traffic.
    const app = makeApp();
    const submission = { rail: "apple", receipt: await receipt() };
    expect((await request(app, "POST", "/payments/purchases", { user: "ada", body: submission })).status).toBe(200);
    const again = await request(app, "POST", "/payments/purchases", { user: "ada", body: submission });
    expect(again.status).toBe(200);
    expect((await again.json<{ purchase: { outcome: string } }>()).purchase.outcome).toBe("ignored");
    expect(await purchases()).toHaveLength(1);
  });

  test("another user submitting the same receipt is a 409, never a silent rebind", async () => {
    // Cross-user receipt replay. `UNIQUE (rail, providerTransactionId)` plus the owner check is what makes a
    // stolen receipt worthless.
    const app = makeApp();
    const submission = { rail: "apple", receipt: await receipt() };
    await request(app, "POST", "/payments/purchases", { user: "ada", body: submission });
    const stolen = await request(app, "POST", "/payments/purchases", { user: "grace", body: submission });
    expect(stolen.status).toBe(409);
    expect(await errorCode(stolen)).toBe("payments/receipt_already_owned");
    const rows = await purchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("ada");
    // Grace holds nothing, and the refusal is on the trail next to Ada's success.
    expect(await entitlements()).toHaveLength(1);
    expect(actions()).toEqual(["payments/purchase_verified:success", "payments/purchase_verified:denied"]);
    // The account link stayed Ada's too. Grace's submission tried to write one before the projection refused
    // her, and `UNIQUE (rail, providerAccountId)` is what stops that capturing Ada's future notifications.
    const links = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(links).toHaveLength(1);
    expect(links[0]?.userId).toBe("ada");
  });

  test("a refused receipt mints no account link — squatting an identifier costs a real purchase", async () => {
    // The free half of a cross-user hijack, closed. `appAccountToken` is a value the *app* chooses, and the
    // link written from it is what attributes an orphaned notification. While the link was written before the
    // projection, an attacker could bind any number of identifiers with Sandbox receipts — free, and refused
    // by the environment check that runs *inside* the projection, so the refusal cost them nothing and the
    // binding survived. Now a binding requires a purchase this deployment actually projected.
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "mallory",
      body: { rail: "apple", receipt: await receipt({ environment: "Sandbox", appAccountToken: "ada-token" }) },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/environment_mismatch");
    // The whole point: nothing was bound, so Ada's notifications still resolve to Ada.
    expect(await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute()).toEqual([]);
  });

  test("a notification resolves to the owner of its projected purchase, not to whoever claimed the token", async () => {
    // The other half. Mallory makes a real purchase carrying Ada's token and submits it as herself, so the
    // link says Mallory. Ada's own subscription was submitted by Ada, so a purchase row for the family exists —
    // and the row outranks the link, because it is a fact this server established for an authenticated caller.
    const app = makeApp();
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt({ appAccountToken: "ada-token" }) },
    });
    await request(app, "POST", "/payments/purchases", {
      user: "mallory",
      body: {
        rail: "apple",
        receipt: await receipt({
          appAccountToken: "ada-token",
          transactionId: "txn-mallory",
          originalTransactionId: "orig-mallory",
        }),
      },
    });

    // Ada's renewal: a fresh transaction id chaining back to her original, carrying the token Mallory claimed.
    const renewal = await request(app, "POST", "/payments/webhooks/apple", {
      body: {
        signedPayload: await notification({
          ...didRenew,
          transaction: {
            ...didRenew.transaction,
            appAccountToken: "ada-token",
            transactionId: "txn-ada-renewal",
          },
        }),
      },
    });
    expect(renewal.status).toBe(200);

    const renewed = (await purchases()).find((purchase) => purchase.providerTransactionId === "txn-ada-renewal");
    expect(renewed?.userId).toBe("ada");
  });

  test("a sandbox receipt against a production deployment is a 400 and grants nothing", async () => {
    // The most common in-app-purchase security defect there is, refused before a row exists.
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt({ environment: "Sandbox" }) },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/environment_mismatch");
    expect(await purchases()).toEqual([]);
    expect(await entitlements()).toEqual([]);
  });

  test("a production receipt against a staging deployment is refused too — the isolation runs both ways", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      environment: "staging",
      body: { rail: "apple", receipt: await receipt() },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/environment_mismatch");
  });

  test("a deployment with no ENVIRONMENT var is sandbox, never production", async () => {
    // The default has to be the side that cannot grant a real entitlement.
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      environment: null,
      body: { rail: "apple", receipt: await receipt() },
    });
    expect(response.status).toBe(400);
    const sandbox = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      environment: null,
      body: { rail: "apple", receipt: await receipt({ environment: "Sandbox" }) },
    });
    expect(sandbox.status).toBe(200);
  });

  test("a SKU the catalog does not map is a 404 — the catalog is config, so it is a missing resource", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt({ productId: "com.acme.not.in.catalog" }) },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/product_not_found");
  });

  test("a consumable projects with no entitlement and no failure", async () => {
    // `coins_100` grants a balance, not a key. A product that grants nothing readable must still project.
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await signJws(oneTimeCharge.transaction, chain) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      purchase: { productId: "coins_100", type: "consumable" },
      entitlements: [],
    });
  });

  test("a receipt Apple did not sign is refused when the trust set is production's", async () => {
    // The same genuinely-signed artifact every happy case above uses, against the default trust set.
    const response = await request(makeApp(CATALOG, { trustedApple: false }), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/verification_failed");
    expect(await purchases()).toEqual([]);
    expect(actions()).toEqual(["payments/purchase_verified:denied"]);
  });

  test("a receipt for another app's bundle id is refused", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt({ bundleId: "com.someone.else" }) },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/verification_failed");
  });

  test("garbage in the receipt field is a 400, not a 500", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: "not-a-jws" },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/invalid_receipt");
  });

  test("no audit event carries the receipt", async () => {
    // The trail is queryable and long-lived, and a receipt is a bearer artifact.
    const submitted = await receipt();
    await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: submitted },
    });
    expect(JSON.stringify(emitted)).not.toContain(submitted);
  });

  test("no response carries a credential or the stored provider payload", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(CREDENTIALS.apple.privateKey);
    expect(body).not.toContain(CREDENTIALS.apple.keyId);
    // The purchase view is a projection, not the row: the whole verified payload stays server-side.
    expect(body).not.toContain("signedDate");
  });
});

describe("the guards, and their order relative to the validators", () => {
  test("every authed route denies an anonymous caller", async () => {
    const app = makeApp();
    expect(
      (await request(app, "POST", "/payments/purchases", { body: { rail: "apple", receipt: await receipt() } })).status,
    ).toBe(401);
    expect((await request(app, "GET", "/payments/entitlements")).status).toBe(401);
    expect(
      (await request(app, "POST", "/payments/restore", { body: { rail: "apple", receipts: [await receipt()] } }))
        .status,
    ).toBe(401);
  });

  test("the guards still win over the validators — unauthenticated plus malformed is 401, not 400", async () => {
    // A validator ahead of a guard would answer 400 here, telling an unauthenticated caller which of its
    // requests were well-formed. The route line's order is what makes that impossible.
    const app = makeApp();
    for (const [path, body] of [
      ["/payments/purchases", { rail: "not-a-rail" }],
      ["/payments/restore", { receipts: [] }],
    ] as const) {
      expect((await request(app, "POST", path, { body })).status, path).toBe(401);
    }
  });

  test("the guards still win over the validators — unauthenticated plus unparseable JSON is 401", async () => {
    expect((await request(makeApp(), "POST", "/payments/purchases", { raw: "{not json" })).status).toBe(401);
  });

  test("a malformed body on an unconfigured product is 400, not 404", async () => {
    // The request is rejected as unparseable before any catalog lookup runs.
    const response = await request(makeApp(), "POST", "/payments/purchases", { user: "ada", body: { rail: "apple" } });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
  });

  test("an over-long receipt is refused before it is parsed", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: "a".repeat(20_000) },
    });
    expect(response.status).toBe(400);
  });

  test("an empty restore list is a 400 — there is nothing to restore", async () => {
    const response = await request(makeApp(), "POST", "/payments/restore", {
      user: "ada",
      body: { rail: "apple", receipts: [] },
    });
    expect(response.status).toBe(400);
  });

  test("an ordinary user needs no scope for their own purchases — these are not control-plane routes", async () => {
    const app = makeApp();
    expect((await request(app, "GET", "/payments/entitlements", { user: "ada" })).status).toBe(200);
    // And a scope string on the AuthContext neither helps nor hinders here: the two vocabularies are separate,
    // and no route in this package reads a control-plane scope off `c.var.auth`.
    expect(
      (
        await request(app, "GET", "/payments/entitlements", {
          user: "ada",
          scopes: PAYMENTS_CONTROL_PLANE_SCOPES.join(","),
        })
      ).status,
    ).toBe(200);
  });
});

describe("the rail, and what a client is told about it", () => {
  test("a rail that is off in config is a 404", async () => {
    const app = makeApp({ rails: {}, products: {} });
    const response = await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/rail_not_configured");
  });

  test("a rail enabled in config but never provisioned is the same 404, on any rail", async () => {
    // Three causes — off in config, not implemented by this build, no credentials — and one public message. The
    // build cause has no rail left to demonstrate now that all three are implemented; `rails/providers.test.ts`
    // holds that branch.
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      credentials: { apple: CREDENTIALS.apple },
      body: { rail: "stripe", receipt: "cs_test_pithyPro" },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/rail_not_configured");
  });

  test("a rail with no provisioned credentials is a 404, and the detail never reaches the client", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      credentials: {},
      body: { rail: "apple", receipt: await receipt() },
    });
    expect(response.status).toBe(404);
    expect((await response.json<{ error: { detail?: string } }>()).error.detail).toBeUndefined();
  });

  test("a rail the schema does not know is a 400 — a shape failure, not a missing resource", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "amazon", receipt: "x" },
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /payments/entitlements", () => {
  test("is scoped to the caller — another user sees their own empty state", async () => {
    const app = makeApp();
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    expect(await (await request(app, "GET", "/payments/entitlements", { user: "ada" })).json()).toEqual({
      entitlements: [
        { key: "pro", granted: true, expiresAt: new Date(didRenew.transaction.expiresDate).toISOString() },
      ],
    });
    expect(await (await request(app, "GET", "/payments/entitlements", { user: "grace" })).json()).toEqual({
      entitlements: [],
    });
  });

  test("a lapsed row does not grant, even though it still says active", async () => {
    // The case the read-time recheck exists for: a subscription can lapse with no notification arriving, so
    // `expiresAt` is the truth and the stored flag is an optimization.
    await db()
      .insertInto("pithyPaymentsEntitlements")
      .values({
        id: "e1",
        userId: "ada",
        entitlement: "pro",
        active: 1,
        expiresAt: NOW.getTime() - 1,
        sourcePurchaseId: "p1",
        manual: 0,
        createdAt: NOW.getTime(),
        updatedAt: NOW.getTime(),
      })
      .execute();
    expect(await (await request(makeApp(), "GET", "/payments/entitlements", { user: "ada" })).json()).toEqual({
      entitlements: [{ key: "pro", granted: false, expiresAt: new Date(NOW.getTime() - 1).toISOString() }],
    });
  });

  test("the read writes nothing", async () => {
    const app = makeApp();
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    const before = await entitlements();
    await request(app, "GET", "/payments/entitlements", { user: "ada" });
    expect(await entitlements()).toEqual(before);
  });
});

describe("POST /payments/restore", () => {
  test("projects every receipt and returns the caller's resolved entitlements", async () => {
    const response = await request(makeApp(), "POST", "/payments/restore", {
      user: "ada",
      body: { rail: "apple", receipts: [await receipt(), await signJws(oneTimeCharge.transaction, chain)] },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ purchases: { productId: string }[]; entitlements: unknown[] }>();
    expect(body.purchases.map((purchase) => purchase.productId)).toEqual(["pro_monthly", "coins_100"]);
    expect(body.entitlements).toEqual([
      { key: "pro", granted: true, expiresAt: new Date(didRenew.transaction.expiresDate).toISOString() },
    ]);
    expect(actions()).toEqual(["payments/purchase_restored:success"]);
  });

  test("restoring twice changes nothing", async () => {
    const app = makeApp();
    const body = { rail: "apple", receipts: [await receipt()] };
    await request(app, "POST", "/payments/restore", { user: "ada", body });
    await request(app, "POST", "/payments/restore", { user: "ada", body });
    expect(await purchases()).toHaveLength(1);
    expect(await entitlements()).toHaveLength(1);
  });

  test("a receipt belonging to another account fails the whole restore", async () => {
    // A client submits its own history, so somebody else's receipt in the batch is an attack. Skipping it
    // would hide that; failing loudly does not, and every receipt that did project stays projected.
    const app = makeApp();
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    const response = await request(app, "POST", "/payments/restore", {
      user: "grace",
      body: { rail: "apple", receipts: [await signJws(oneTimeCharge.transaction, chain), await receipt()] },
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("payments/receipt_already_owned");
    // Grace's own consumable landed; Ada's subscription stayed Ada's.
    const rows = await purchases();
    expect(rows.map((row) => row.userId).sort()).toEqual(["ada", "grace"]);
  });
});

describe("POST /payments/webhooks/apple", () => {
  test("verifies, records, projects, and reports what changed", async () => {
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: true, outcome: "created" });

    const rows = await purchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "ada", productId: "pro_monthly", status: "active" });
    expect((await entitlements())[0]).toMatchObject({ userId: "ada", entitlement: "pro", active: 1 });

    const events = await webhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rail: "apple",
      providerEventId: didRenew.notification.notificationUUID,
      error: null,
    });
    expect(events[0]?.processedAt).not.toBeNull();
    expect(actions()).toEqual(["payments/webhook_received:success"]);
  });

  test("resolves the owner through a purchase already projected, with no account link at all", async () => {
    // A renewal follows its buyer: the first purchase was submitted by its owner, and the notification chains
    // back to it through `originalTransactionId`.
    const app = makeApp();
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt({ transactionId: didRenew.transaction.originalTransactionId }) },
    });
    await db().deleteFrom("pithyPaymentsProviderAccounts").execute();

    const response = await request(app, "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification() },
    });
    expect(response.status).toBe(200);
    expect((await purchases()).every((row) => row.userId === "ada")).toBe(true);
  });

  test("a redelivery is recognized rather than reprocessed", async () => {
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const app = makeApp();
    const signed = await notification();
    expect(
      await (await request(app, "POST", "/payments/webhooks/apple", { body: { signedPayload: signed } })).json(),
    ).toEqual({
      received: true,
      projected: true,
      outcome: "created",
    });
    // Apple delivers at-least-once and retries, so this is normal traffic, not an error.
    const again = await request(app, "POST", "/payments/webhooks/apple", { body: { signedPayload: signed } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(await webhookEvents()).toHaveLength(1);
    expect(await purchases()).toHaveLength(1);
  });

  test("a stale event arriving after a newer one does not revoke a paying subscriber", async () => {
    // Out-of-order delivery, end to end through the route. Apple does not guarantee delivery order, and
    // last-write-wins here would expire a subscription that had just renewed.
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const app = makeApp();
    await request(app, "POST", "/payments/webhooks/apple", { body: { signedPayload: await notification() } });

    const stale: NotificationFixture = {
      notification: {
        ...didRenew.notification,
        notificationType: "EXPIRED",
        subtype: undefined,
        notificationUUID: "aaaaaaaa-0000-4000-8000-000000000001",
        // A day before the renewal Apple signed.
        signedDate: didRenew.notification.signedDate - 86_400_000,
      },
      transaction: didRenew.transaction,
    };
    const response = await request(app, "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification(stale) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: true, outcome: "ignored" });
    expect((await purchases())[0]?.status).toBe("active");
    expect((await entitlements())[0]?.active).toBe(1);
  });

  test("a card retry keeps a paying subscriber's access to the end of the grace window", async () => {
    // The failure the whole capability exists to prevent, end to end. The paid period ended yesterday and
    // Apple is retrying the card, so the entitlement must stand — and the date it stands to is on the renewal
    // info, not on the transaction. A projection reading only the transaction records the grace period and
    // clears the entitlement in the same commit.
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const lapsed = NOW.getTime() - 86_400_000;
    const graceEnd = NOW.getTime() + 5 * 86_400_000;
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      body: {
        signedPayload: await notification({
          ...didFailToRenewGrace,
          notification: { ...didFailToRenewGrace.notification, signedDate: lapsed },
          transaction: { ...didFailToRenewGrace.transaction, expiresDate: lapsed, signedDate: lapsed },
          renewalInfo: { ...didFailToRenewGrace.renewalInfo, gracePeriodExpiresDate: graceEnd },
        }),
      },
    });

    expect(response.status).toBe(200);
    expect((await purchases())[0]).toMatchObject({ status: "in_grace", expiresAt: graceEnd });
    expect((await entitlements())[0]).toMatchObject({ entitlement: "pro", active: 1, expiresAt: graceEnd });
  });

  test("a refund revokes the entitlement", async () => {
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const app = makeApp();
    await request(app, "POST", "/payments/webhooks/apple", { body: { signedPayload: await notification() } });
    await request(app, "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification(refundFixture) },
    });
    expect((await purchases())[0]?.status).toBe("refunded");
    expect((await entitlements())[0]).toMatchObject({ active: 0, sourcePurchaseId: null });
  });

  test("a sandbox notification against a production deployment is acknowledged, recorded, and grants nothing", async () => {
    // Authentic but inapplicable. Answering 5xx would make Apple retry something that refuses identically every
    // time; the recorded error is what makes it visible instead.
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification(subscribedSandbox) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: false });
    expect(await purchases()).toEqual([]);
    expect((await webhookEvents())[0]?.error).toContain("payments/environment_mismatch");
    expect(actions()).toEqual(["payments/webhook_received:failure"]);
  });

  test("a notification with nobody to project it against is an acknowledged orphan", async () => {
    // The app set no account token and nothing in this subscription's family was ever submitted. Retrying will
    // not conjure a link, so the row is what makes the orphan queryable and replayable.
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: false });
    expect(await purchases()).toEqual([]);
    expect((await webhookEvents())[0]?.error).toContain("no Pithy user");
    expect(actions()).toEqual(["payments/webhook_received:failure"]);
  });

  test("a notification that reports no transaction state is recorded and changes nothing", async () => {
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification(testFixture) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: false });
    const events = await webhookEvents();
    expect(events[0]).toMatchObject({ providerEventId: testFixture.notification.notificationUUID, error: null });
    expect(events[0]?.processedAt).not.toBeNull();
    expect(actions()).toEqual(["payments/webhook_received:success"]);
  });

  test("a notification Apple did not sign is 401, and nothing is recorded", async () => {
    // A forgery must not be able to fill the webhook table, so verification comes before the insert.
    const response = await request(makeApp(CATALOG, { trustedApple: false }), "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification() },
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("payments/webhook_unverified");
    expect(await webhookEvents()).toEqual([]);
    expect(await purchases()).toEqual([]);
  });

  test("a notification for another app's bundle id is 401", async () => {
    const foreign: NotificationFixture = {
      ...didRenew,
      notification: { ...didRenew.notification, data: { ...didRenew.notification.data, bundleId: "com.someone.else" } },
    };
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification(foreign) },
    });
    expect(response.status).toBe(401);
    expect(await webhookEvents()).toEqual([]);
  });

  test("a body with no signedPayload is 401 — the guard runs before the validator", async () => {
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", { body: { hello: "world" } });
    expect(response.status).toBe(401);
  });

  test("unparseable JSON on the webhook is 401, not 400 or 500", async () => {
    expect((await request(makeApp(), "POST", "/payments/webhooks/apple", { raw: "{not json" })).status).toBe(401);
  });

  test("the webhook needs no session — proving authenticity is the strategy", async () => {
    // Not a `bearer` route: Apple has no Pithy session. An authenticated caller gets no more and no less.
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      user: "grace",
      body: { signedPayload: await notification() },
    });
    expect(response.status).toBe(200);
    // The purchase belongs to the account link, not to whoever happened to be signed in.
    expect((await purchases())[0]?.userId).toBe("ada");
  });

  test("a rail with no provisioned credentials is 404 before any signature work", async () => {
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      credentials: {},
      body: { signedPayload: await notification() },
    });
    expect(response.status).toBe(404);
    expect(await webhookEvents()).toEqual([]);
  });

  test("the body the guard read is the body the validator sees", async () => {
    // The guard reads the exact received bytes to check the signature. Reading them off `c.req.raw` would
    // consume the stream and leave the validator with nothing, which would surface as a 400 on a valid
    // notification — so a 200 here is the assertion.
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification() },
    });
    expect(response.status).toBe(200);
  });

  test("no webhook response carries a credential", async () => {
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    const response = await request(makeApp(), "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await notification() },
    });
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(CREDENTIALS.apple.privateKey);
    expect(body).not.toContain(CREDENTIALS.apple.issuerId);
  });
});

describe("POST /payments/webhooks/google", () => {
  /** An app whose Play answers a subscription lookup with the active fixture. */
  const withSubscription = (subscription: unknown = playSubscription) => makeApp(CATALOG, { play: { subscription } });

  test("a PKCS#1 service-account key is a 404 naming the misconfiguration, not a 401 naming a forgery", async () => {
    // The only case that reaches `webhookGuard`'s `payments/rail_not_configured` pass-through, and nothing
    // exercised it. Google's key parser refuses a PKCS#1 body from inside `parseNotification` — which is where
    // a *sender's* failure is normally rewritten to `payments/webhook_unverified`. Reporting an operator's
    // mis-pasted key as a forgery sends them hunting a rotated signing key instead of re-copying `private_key`
    // from the downloaded JSON. Drop the entry from `PASS_THROUGH_CODES` and this goes 401.
    const response = await push(withSubscription(), rtdnRenewed, {
      credentials: {
        ...CREDENTIALS,
        google: {
          ...CREDENTIALS.google,
          privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
        },
      },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/rail_not_configured");
  });

  test("verifies the push token, resolves the pointer at Play, and projects what Play said", async () => {
    // The whole rail end to end: an OIDC token in the header, a base64 pointer in the body, a Play lookup, and a
    // purchase row that says what Play reported rather than what the notification implied.
    await linkProviderAccount(env.DB, "google", GOOGLE_ACCOUNT, "ada", { now: NOW });
    const response = await push(withSubscription(), rtdnRenewed);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: true, outcome: "created" });

    const rows = await purchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rail: "google",
      userId: "ada",
      productId: "pro_monthly",
      status: "active",
      environment: "production",
      // The order id, not the token — each renewal is its own row.
      providerTransactionId: "GPA.3311-8452-9910-77301..0",
      originalTransactionId: rtdnRenewed.subscriptionNotification.purchaseToken,
    });
    expect((await entitlements())[0]).toMatchObject({ userId: "ada", entitlement: "pro", active: 1 });
    expect(actions()).toEqual(["payments/webhook_received:success"]);
  });

  test("the provider event time is Google's, not ours", async () => {
    // The monotonic write rule compares provider clocks, and Pub/Sub does not deliver in order.
    await linkProviderAccount(env.DB, "google", GOOGLE_ACCOUNT, "ada", { now: NOW });
    await push(withSubscription(), rtdnRenewed);
    expect((await purchases())[0]?.providerEventAt).toBe(Number(rtdnRenewed.eventTimeMillis));
  });

  test("a push with no Authorization header is 401, and nothing is recorded", async () => {
    // A Pub/Sub push body carries no signature at all, so the token is the whole proof. Without it there is
    // nothing to check and nothing may be written.
    const response = await request(withSubscription(), "POST", "/payments/webhooks/google", {
      raw: pushBody(rtdnRenewed),
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("payments/webhook_unverified");
    expect(await webhookEvents()).toEqual([]);
  });

  test("a token minted for another endpoint is 401 — the audience is the boundary", async () => {
    // Google signs push tokens for every subscription in the world with the same keys, so this token's signature
    // is perfectly valid. The audience is the only thing that says it was minted for us.
    const response = await push(withSubscription(), rtdnRenewed, {
      token: await pushToken({ aud: "https://evil.example/hook" }),
    });
    expect(response.status).toBe(401);
    expect(await webhookEvents()).toEqual([]);
    expect(await purchases()).toEqual([]);
  });

  test("a token signed by a key Google does not publish is 401", async () => {
    const response = await push(
      makeApp(CATALOG, { trustedGoogle: false, play: { subscription: playSubscription } }),
      rtdnRenewed,
      {
        token: await pushToken({}, unpublishedKey),
      },
    );
    expect(response.status).toBe(401);
    expect(await webhookEvents()).toEqual([]);
  });

  test("a token from another service account is 401", async () => {
    const response = await push(withSubscription(), rtdnRenewed, {
      token: await pushToken({ email: "someone-else@acme-42.iam.gserviceaccount.com" }),
    });
    expect(response.status).toBe(401);
  });

  test("an expired token is 401", async () => {
    const response = await push(withSubscription(), rtdnRenewed, {
      token: await pushToken({ exp: Math.floor(NOW.getTime() / 1000) - 3600 }),
    });
    expect(response.status).toBe(401);
  });

  test("a notification for another app is 401, however well signed the push", async () => {
    // The check the token cannot make: a valid token says Google delivered it, never what it is about.
    const response = await push(withSubscription(), { ...rtdnRenewed, packageName: "com.someone.else" });
    expect(response.status).toBe(401);
    expect(await webhookEvents()).toEqual([]);
  });

  test("a redelivery is recognized rather than reprocessed", async () => {
    // Pub/Sub delivers at-least-once and keeps the message id across redeliveries, which is what makes it the
    // dedupe key.
    await linkProviderAccount(env.DB, "google", GOOGLE_ACCOUNT, "ada", { now: NOW });
    const app = withSubscription();
    expect(await (await push(app, rtdnRenewed, { messageId: "m-42" })).json()).toEqual({
      received: true,
      projected: true,
      outcome: "created",
    });
    const again = await push(app, rtdnRenewed, { messageId: "m-42" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(await webhookEvents()).toHaveLength(1);
    expect(await purchases()).toHaveLength(1);
  });

  test("a revoked subscription is projected as revoked, not as a lapse", async () => {
    // Play reports a revoked subscription as EXPIRED, so without the notification type this refund would read as
    // an ordinary expiry and nothing downstream could tell that money went back.
    await linkProviderAccount(env.DB, "google", GOOGLE_ACCOUNT, "ada", { now: NOW });
    const app = makeApp(CATALOG, {
      play: { subscription: { ...playSubscription, subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" } },
    });
    await push(app, rtdnRevoked);
    const rows = await purchases();
    expect(rows[0]?.status).toBe("revoked");
    expect(rows[0]?.revokedAt).toBe(Number(rtdnRevoked.eventTimeMillis));
    expect((await entitlements())[0]).toMatchObject({ active: 0, sourcePurchaseId: null });
  });

  test("a one-time notification resolves through the products endpoint", async () => {
    await linkProviderAccount(env.DB, "google", GOOGLE_ACCOUNT, "ada", { now: NOW });
    const response = await push(makeApp(CATALOG, { play: { product: playProduct } }), rtdnOneTime);
    expect(response.status).toBe(200);
    expect((await purchases())[0]).toMatchObject({
      rail: "google",
      productId: "coins_100",
      type: "consumable",
      status: "active",
      expiresAt: null,
    });
  });

  test("a test purchase against a production deployment is acknowledged and grants nothing", async () => {
    // Sandbox isolation for the Google rail. Play marks a licence-test subscription with `testPurchase`, and the
    // writer refuses it — a 5xx would only make Pub/Sub retry something that refuses identically every time.
    await linkProviderAccount(env.DB, "google", GOOGLE_ACCOUNT, "ada", { now: NOW });
    const response = await push(withSubscription({ ...playSubscription, testPurchase: {} }), rtdnRenewed);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: false });
    expect(await purchases()).toEqual([]);
    expect((await webhookEvents())[0]?.error).toContain("payments/environment_mismatch");
    expect(actions()).toEqual(["payments/webhook_received:failure"]);
  });

  test("a test notification is recorded and changes nothing", async () => {
    const response = await push(withSubscription(), rtdnTest);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: false });
    const events = await webhookEvents();
    expect(events[0]).toMatchObject({ rail: "google", error: null });
    expect(events[0]?.processedAt).not.toBeNull();
    expect(actions()).toEqual(["payments/webhook_received:success"]);
  });

  test("a voided purchase revokes the entitlement it paid for", async () => {
    // Play's voided-purchase notification names no product, and Play's one-time lookup takes the product id as
    // a path segment — so there is no call the rail can make. It does not need one: an order id is exactly what
    // a Google purchase's `providerTransactionId` is, so the row is one read away and already knows its own
    // product. Before this, the delivery was recorded and dropped, and a refunded non-consumable kept granting
    // its entitlement forever — ranked NULLS FIRST above every dated purchase, so nothing lapsed it either.
    // A non-consumable on Play, which the shared catalog has no reason to carry — the refund case is the only
    // one that needs a product bought once and kept forever.
    const withRemoveAds: PaymentsConfigInput = {
      ...CATALOG,
      products: {
        ...CATALOG.products,
        remove_ads: {
          type: "non_consumable",
          name: "Remove ads",
          entitlements: ["ads_removed"],
          google: { productId: "remove_ads" },
        },
      },
    };
    const order = rtdnVoided.voidedPurchaseNotification.orderId;
    await projectPurchase(
      env.DB,
      {
        rail: "google",
        providerTransactionId: order,
        providerProductId: "remove_ads",
        userId: "ada",
        status: "active",
        environment: "production",
        purchasedAt: new Date(NOW.getTime() - 86_400_000),
        expiresAt: null,
        providerEventAt: new Date(NOW.getTime() - 86_400_000),
        payload: { orderId: order },
      },
      { config: PaymentsConfig.parse(withRemoveAds), environment: "production", now: NOW },
    );
    expect((await entitlements())[0]).toMatchObject({ entitlement: "ads_removed", active: 1 });

    const response = await push(makeApp(withRemoveAds, { play: { subscription: playSubscription } }), rtdnVoided);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, projected: true });

    const row = (await purchases()).find((purchase) => purchase.providerTransactionId === order);
    expect(row?.status).toBe("refunded");
    expect((await entitlements())[0]).toMatchObject({ entitlement: "ads_removed", active: 0 });
    expect(actions()).toEqual(["payments/webhook_received:success"]);
  });

  test("a void naming an order we never projected is recorded as orphaned, not silently dropped", async () => {
    // A purchase from before payments was installed, or one that never reached us. There is nothing to revoke,
    // and the row carrying the order id is what makes that findable rather than invisible.
    const response = await push(withSubscription(), rtdnVoided);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: false });
    const events = await webhookEvents();
    expect(events[0]?.error).toContain(rtdnVoided.voidedPurchaseNotification.orderId);
    expect(events[0]?.processedAt).not.toBeNull();
    expect(actions()).toEqual(["payments/webhook_received:failure"]);
  });

  test("an unreachable Play API is a 503, so Pub/Sub redelivers", async () => {
    // The one failure that must not be acknowledged. Answering 200 to a Play outage would drop a renewal for
    // good; a 503 leaves the delivery outstanding and Pub/Sub brings it back.
    await linkProviderAccount(env.DB, "google", GOOGLE_ACCOUNT, "ada", { now: NOW });
    const response = await push(makeApp(CATALOG, { play: { status: 503 } }), rtdnRenewed);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("payments/provider_unavailable");
    expect(await purchases()).toEqual([]);
  });

  test("a purchase Play has no record of is acknowledged with its reason", async () => {
    // Distinct from an outage: Play answered, and the answer is that it knows nothing about the token. Retrying
    // will not change that.
    const response = await push(makeApp(CATALOG, { play: {} }), rtdnRenewed);
    expect(response.status).toBe(200);
    expect((await webhookEvents())[0]?.error).toContain("Play has no subscription");
  });

  test("a notification with nobody to project it against is an acknowledged orphan", async () => {
    const response = await push(withSubscription(), rtdnRenewed);
    expect(response.status).toBe(200);
    expect(await purchases()).toEqual([]);
    expect((await webhookEvents())[0]?.error).toContain("no Pithy user");
  });

  test("resolves the owner through a purchase already projected, with no account link", async () => {
    // A renewal follows its buyer: the first purchase was submitted by its owner, and every row in the family
    // carries the purchase token as its `originalTransactionId`.
    const app = withSubscription();
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "google", receipt: playReceipt() },
    });
    await db().deleteFrom("pithyPaymentsProviderAccounts").execute();
    await push(app, rtdnRenewed);
    expect((await purchases()).every((row) => row.userId === "ada")).toBe(true);
  });

  test("a body that is not a Pub/Sub push is 401 — the guard decodes it before the validator", async () => {
    const response = await request(withSubscription(), "POST", "/payments/webhooks/google", {
      raw: JSON.stringify({ hello: "world" }),
      authorization: await pushToken(),
    });
    expect(response.status).toBe(401);
    expect(await webhookEvents()).toEqual([]);
  });

  test("no response carries a credential or a purchase token", async () => {
    await linkProviderAccount(env.DB, "google", GOOGLE_ACCOUNT, "ada", { now: NOW });
    const response = await push(withSubscription(), rtdnRenewed);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(serviceAccountKey.pem);
    expect(body).not.toContain(rtdnRenewed.subscriptionNotification.purchaseToken);
  });

  test("a rail that is off in config is a 404 before any token work", async () => {
    const app = makeApp(
      {
        rails: { apple: true },
        products: {
          pro_monthly: {
            type: "subscription",
            name: "Pro",
            entitlements: ["pro"],
            apple: { productId: "com.acme.pro.monthly" },
          },
        },
      },
      { play: { subscription: playSubscription } },
    );
    const response = await push(app, rtdnRenewed);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/rail_not_configured");
    expect(await webhookEvents()).toEqual([]);
  });
});

describe("POST /payments/purchases, on the Google rail", () => {
  test("verifies a Play purchase token at Play and projects it", async () => {
    const response = await request(
      makeApp(CATALOG, { play: { subscription: playSubscription } }),
      "POST",
      "/payments/purchases",
      {
        user: "ada",
        body: { rail: "google", receipt: playReceipt() },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      purchase: { rail: "google", productId: "pro_monthly", status: "active", outcome: "created" },
      entitlements: [{ key: "pro", granted: true }],
    });
    // The account link is written from Play's own identifier, so the next notification is not orphaned.
    const links = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(links[0]).toMatchObject({ rail: "google", providerAccountId: GOOGLE_ACCOUNT, userId: "ada" });
  });

  test("a product id the token does not belong to is refused by Play, not believed", async () => {
    // The escalation the design closes: the receipt's product id is a lookup key Play confirms or refuses, never
    // a claim. Play knows no subscription and no `pro_monthly` one-time purchase under this token.
    const response = await request(makeApp(CATALOG, { play: {} }), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "google", receipt: playReceipt() },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/verification_failed");
    expect(await purchases()).toEqual([]);
  });

  test("a Play outage is a 503, not a rejected purchase", async () => {
    // Telling a buyer their receipt is invalid because Google is down would send them to support over nothing.
    const response = await request(makeApp(CATALOG, { play: { status: 500 } }), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "google", receipt: playReceipt() },
    });
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("payments/provider_unavailable");
  });

  test("a receipt that is not a Play purchase is a 400", async () => {
    const response = await request(makeApp(CATALOG, { play: {} }), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "google", receipt: "not-json" },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/invalid_receipt");
  });

  test("another user submitting the same purchase token is a 409", async () => {
    const app = makeApp(CATALOG, { play: { subscription: playSubscription } });
    const body = { rail: "google", receipt: playReceipt() };
    await request(app, "POST", "/payments/purchases", { user: "ada", body });
    const stolen = await request(app, "POST", "/payments/purchases", { user: "grace", body });
    expect(stolen.status).toBe(409);
    expect(await errorCode(stolen)).toBe("payments/receipt_already_owned");
    expect((await purchases())[0]?.userId).toBe("ada");
  });

  test("no audit event carries the purchase token", async () => {
    await request(makeApp(CATALOG, { play: { subscription: playSubscription } }), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "google", receipt: playReceipt() },
    });
    expect(JSON.stringify(emitted)).not.toContain(rtdnRenewed.subscriptionNotification.purchaseToken);
  });
});

const CHECKOUT_SESSION = {
  id: "cs_test_pithyPro",
  object: "checkout.session",
  url: "https://checkout.stripe.com/c/pay/cs_test_pithyPro",
};
const PORTAL_SESSION = { id: "bps_1Pithy", object: "billing_portal.session", url: "https://billing.stripe.com/p/x" };

/** JSON imports are shared and frozen; a case that bends a nested field works on its own copy. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One event fixture with fields of its object replaced — the shape every negative Stripe case needs. */
function withObject<T extends { data: { object: object } }>(event: T, overrides: Record<string, unknown>) {
  const cloned = copy(event);
  return { ...cloned, data: { ...cloned.data, object: { ...cloned.data.object, ...overrides } } };
}

/** Deliver one Stripe event, signed the way Stripe signs it unless a case bends the header. */
async function stripeHook(
  app: Hono<PithyHonoEnv>,
  event: unknown,
  options: RequestOptions & { header?: string | null; signedAt?: Date; secret?: string } = {},
) {
  const body = options.raw ?? JSON.stringify(event);
  const header =
    options.header === undefined
      ? await stripeSignatureHeader(body, NOW, { timestamp: options.signedAt, secret: options.secret })
      : options.header;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header !== null) headers["stripe-signature"] = header;
  const bindings: Record<string, unknown> = {
    ...env,
    ENVIRONMENT: options.environment === undefined ? "production" : options.environment,
    [PAYMENTS_PROVIDER_SECRET]: JSON.stringify(options.credentials ?? CREDENTIALS),
  };
  return app.request("http://x/payments/webhooks/stripe", { method: "POST", headers, body }, bindings);
}

/** The form body of the last call the Stripe rail made, decoded for readable assertions. */
const lastStripeForm = () => decodeURIComponent(stripeCalls.at(-1)?.init?.body ?? "");

describe("POST /payments/webhooks/stripe", () => {
  test("a signed subscription event projects, and binds the customer to the user in one delivery", async () => {
    // The Stripe rail has no client-submission path in the common case, so the webhook is where a purchase and
    // its ownership both arrive. `/checkout` stamped the reference; this is where it becomes a link row.
    const response = await stripeHook(makeApp(), stripeSubscriptionCreated);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, projected: true, outcome: "created" });

    const rows = await purchases();
    expect(rows[0]).toMatchObject({
      rail: "stripe",
      userId: "ada",
      productId: "pro_monthly",
      status: "active",
      environment: "production",
      // The invoice, so each billing period is its own row; the subscription is the family key.
      providerTransactionId: "in_1PithyAdaJan",
      originalTransactionId: "sub_1PithyAdaPro",
      amountMinor: 999,
      currency: "usd",
    });
    expect((await entitlements())[0]).toMatchObject({ userId: "ada", entitlement: "pro", active: 1 });
    const links = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(links[0]).toMatchObject({ rail: "stripe", providerAccountId: STRIPE_CUSTOMER, userId: "ada" });
  });

  test("a completed checkout binds the customer even though it projects nothing", async () => {
    // Stripe may deliver `customer.subscription.created` before or after the session completes, and only the
    // session carries `client_reference_id`. So the pairing is written from a delivery with no transaction at
    // all, and the subscription event that follows resolves through it with no metadata of its own.
    const app = makeApp();
    const session = await stripeHook(app, stripeSessionSubscription);
    expect(await session.json()).toEqual({ received: true, projected: false });
    expect(await purchases()).toEqual([]);

    const bare = withObject(stripeSubscriptionCreated, { metadata: {} });
    expect((await (await stripeHook(app, bare)).json()) as unknown).toEqual({
      received: true,
      projected: true,
      outcome: "created",
    });
    expect((await purchases())[0]?.userId).toBe("ada");
  });

  test("a one-time purchase is keyed on its payment intent, and a refund lands on the same row", async () => {
    // Two events, one row. The refund names only the payment intent, which is exactly why the row is keyed on it.
    const app = makeApp();
    await stripeHook(app, stripeSessionPayment);
    expect((await purchases())[0]).toMatchObject({
      productId: "coins_100",
      type: "consumable",
      status: "active",
      providerTransactionId: "pi_1PithyCoins",
      expiresAt: null,
    });

    await stripeHook(app, chargeRefunded);
    const rows = await purchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "refunded", revokedAt: Number(chargeRefunded.created) * 1000 });
  });

  test("auto-renew turned off still grants, and the deletion that follows revokes", async () => {
    // The pair of mappings a subscriber notices. `canceled` keeps access to the end of the paid period; the
    // `customer.subscription.deleted` that arrives at the end of it is what ends the entitlement.
    const app = makeApp();
    await stripeHook(app, stripeSubscriptionCreated);
    await stripeHook(app, stripeSubscriptionCanceled);
    expect((await purchases())[0]?.status).toBe("canceled");
    expect((await entitlements())[0]).toMatchObject({ active: 1 });

    await stripeHook(app, stripeSubscriptionDeleted);
    expect((await purchases())[0]?.status).toBe("expired");
    expect((await entitlements())[0]).toMatchObject({ active: 0, sourcePurchaseId: null });
  });

  test("an unsigned delivery is 401, and nothing is recorded", async () => {
    const response = await stripeHook(makeApp(), stripeSubscriptionCreated, { header: null });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("payments/webhook_unverified");
    expect(await webhookEvents()).toEqual([]);
  });

  test("a tampered body is 401 — the signature covers the exact bytes", async () => {
    const app = makeApp();
    const authentic = JSON.stringify(stripeSubscriptionCreated);
    const forged = withObject(stripeSubscriptionCreated, { metadata: { pithy_account_reference: "grace" } });
    const response = await stripeHook(app, undefined, {
      raw: JSON.stringify(forged),
      header: await stripeSignatureHeader(authentic, NOW),
    });
    expect(response.status).toBe(401);
    expect(await purchases()).toEqual([]);
    expect(await webhookEvents()).toEqual([]);
  });

  test("a delivery signed with another endpoint's secret is 401", async () => {
    const response = await stripeHook(makeApp(), stripeSubscriptionCreated, { secret: "whsec_someoneElsesEndpoint" });
    expect(response.status).toBe(401);
    expect(await webhookEvents()).toEqual([]);
  });

  test("a captured delivery replayed outside the window is 401 — the replay window is real", async () => {
    // The signature is Stripe's own and still verifies; the timestamp it covers is an hour old. Without the
    // window a captured delivery would be replayable for as long as the signing secret lives.
    const response = await stripeHook(makeApp(), stripeSubscriptionCreated, {
      signedAt: new Date(NOW.getTime() - 3_600_000),
    });
    expect(response.status).toBe(401);
    expect(await webhookEvents()).toEqual([]);
  });

  test("a redelivery is recognized rather than reprocessed", async () => {
    // Stripe retries every non-2xx for three days, keeping the event id.
    const app = makeApp();
    await stripeHook(app, stripeSubscriptionCreated);
    const again = await stripeHook(app, stripeSubscriptionCreated);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(await webhookEvents()).toHaveLength(1);
    expect(await purchases()).toHaveLength(1);
  });

  test("a test-mode purchase against a production deployment grants nothing", async () => {
    // Sandbox isolation for the Stripe rail. `livemode: false` is every object made with a test key, and a test
    // subscription must never grant a real entitlement.
    const test = withObject(stripeSubscriptionCreated, { livemode: false });
    const response = await stripeHook(makeApp(), test);
    expect(response.status).toBe(200);
    expect(await purchases()).toEqual([]);
    expect((await webhookEvents())[0]?.error).toContain("payments/environment_mismatch");
  });

  test("an event type this build does not act on is recorded and changes nothing", async () => {
    const response = await stripeHook(makeApp(), stripeInvoicePaid);
    expect(response.status).toBe(200);
    const events = await webhookEvents();
    expect(events[0]).toMatchObject({ rail: "stripe", error: null });
    expect(events[0]?.processedAt).not.toBeNull();
    expect(actions()).toEqual(["payments/webhook_received:success"]);
  });

  test("a session this deployment did not create is recorded with its reason", async () => {
    // A Payment Link built in Stripe's dashboard carries neither our metadata nor line items, so there is no
    // price to resolve. Authentic, unresolvable, and repairable from the recorded payment intent.
    const link = withObject(stripeSessionPayment, { metadata: {} });
    const response = await stripeHook(makeApp(), link);
    expect(response.status).toBe(200);
    expect((await webhookEvents())[0]?.error).toContain("pi_1PithyCoins");
    expect(actions()).toEqual(["payments/webhook_received:failure"]);
  });

  test("a rail that is off in config is a 404 before any signature work", async () => {
    const app = makeApp({
      rails: { apple: true },
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          apple: { productId: "com.acme.pro.monthly" },
        },
      },
    });
    const response = await stripeHook(app, stripeSubscriptionCreated);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/rail_not_configured");
    expect(await webhookEvents()).toEqual([]);
  });

  test("no response carries a credential or a Stripe identifier", async () => {
    const response = await stripeHook(makeApp(), stripeSubscriptionCreated);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(STRIPE_TEST_WEBHOOK_SECRET);
    expect(body).not.toContain(STRIPE_TEST_SECRET_KEY);
    expect(body).not.toContain(STRIPE_CUSTOMER);
  });
});

describe("POST /payments/checkout", () => {
  const app = () => makeApp(CATALOG, { stripe: { checkout: CHECKOUT_SESSION } });

  test("creates a hosted session and returns where to send the browser", async () => {
    const response = await request(app(), "POST", "/payments/checkout", {
      user: "ada",
      body: { productId: "pro_monthly" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: CHECKOUT_SESSION.url });
    expect(actions()).toEqual(["payments/checkout_started:success"]);
  });

  test("names the authenticated caller, and takes the price from the catalog", async () => {
    // The two values a client must never decide. A client-named purchaser could attach a purchase to another
    // account; a client-named price could buy Pro for the price of a coin pack.
    await request(app(), "POST", "/payments/checkout", { user: "ada", body: { productId: "pro_monthly" } });
    const sent = lastStripeForm();
    expect(sent).toContain("client_reference_id=ada");
    expect(sent).toContain("line_items[0][price]=price_1Abc");
    expect(sent).toContain("mode=subscription");
    expect(sent).toContain("success_url=https://acme.example/thanks?session={CHECKOUT_SESSION_ID}");
  });

  test("ignores a price, a purchaser, and a return URL a caller tries to send", async () => {
    // The request schema names one field, so everything else is dropped before a handler sees it. Asserted at
    // the route rather than at the schema, because this is the escalation somebody will try.
    await request(app(), "POST", "/payments/checkout", {
      user: "ada",
      body: {
        productId: "coins_100",
        priceId: "price_1Abc",
        userId: "grace",
        successUrl: "https://evil.example/thanks",
        client_reference_id: "grace",
      },
    });
    const sent = lastStripeForm();
    expect(sent).toContain("line_items[0][price]=price_1Coins");
    expect(sent).toContain("client_reference_id=ada");
    expect(sent).not.toContain("evil.example");
    expect(sent).not.toContain("grace");
  });

  test("a one-time product buys in payment mode and asks Stripe to create a customer", async () => {
    await request(app(), "POST", "/payments/checkout", { user: "ada", body: { productId: "coins_100" } });
    expect(lastStripeForm()).toContain("mode=payment");
    expect(lastStripeForm()).toContain("customer_creation=always");
  });

  test("reuses the Stripe customer this buyer already has", async () => {
    // One buyer, one customer — otherwise their billing portal would show only the purchase that made it.
    await linkProviderAccount(env.DB, "stripe", STRIPE_CUSTOMER, "ada", { now: NOW });
    await request(app(), "POST", "/payments/checkout", { user: "ada", body: { productId: "pro_monthly" } });
    expect(lastStripeForm()).toContain(`customer=${STRIPE_CUSTOMER}`);
  });

  test("an unauthenticated caller is 401, and Stripe is never called", async () => {
    const response = await request(app(), "POST", "/payments/checkout", { body: { productId: "pro_monthly" } });
    expect(response.status).toBe(401);
    expect(stripeCalls).toEqual([]);
  });

  test("a product that is not in the catalog is a 404", async () => {
    const response = await request(app(), "POST", "/payments/checkout", {
      user: "ada",
      body: { productId: "pro_annual" },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/product_not_found");
  });

  test("a product that is not sold through Stripe is a 404 on the product, not on the rail", async () => {
    const mobileOnly = makeApp(
      {
        ...CATALOG,
        products: {
          remove_ads: {
            type: "non_consumable",
            name: "Remove ads",
            entitlements: ["ads_removed"],
            apple: { productId: "com.acme.removeads" },
          },
        },
      },
      { stripe: { checkout: CHECKOUT_SESSION } },
    );
    const response = await request(mobileOnly, "POST", "/payments/checkout", {
      user: "ada",
      body: { productId: "remove_ads" },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/product_not_found");
  });

  test("Stripe off in config reads as absent, not as broken", async () => {
    const noStripe = makeApp(
      {
        rails: { apple: true },
        products: {
          pro_monthly: {
            type: "subscription",
            name: "Pro",
            entitlements: ["pro"],
            apple: { productId: "com.acme.pro.monthly" },
          },
        },
      },
      { stripe: { checkout: CHECKOUT_SESSION } },
    );
    const response = await request(noStripe, "POST", "/payments/checkout", {
      user: "ada",
      body: { productId: "pro_monthly" },
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/rail_not_configured");
    // No credential read and no round-trip for a rail this project does not sell through.
    expect(stripeCalls).toEqual([]);
  });

  test("a Stripe refusal reaches the caller as an unavailable payment method, with the detail stripped", async () => {
    const response = await request(makeApp(CATALOG, { stripe: { status: 400 } }), "POST", "/payments/checkout", {
      user: "ada",
      body: { productId: "pro_monthly" },
    });
    expect(response.status).toBe(404);
    const body = await response.json<{ error: { message: string; detail?: string } }>();
    expect(body.error.detail).toBeUndefined();
    expect(body.error.message).toBe("That payment method is not available.");
  });

  test("no audit event carries the secret key", async () => {
    await request(app(), "POST", "/payments/checkout", { user: "ada", body: { productId: "pro_monthly" } });
    expect(JSON.stringify(emitted)).not.toContain(STRIPE_TEST_SECRET_KEY);
  });
});

describe("POST /payments/portal", () => {
  const app = () => makeApp(CATALOG, { stripe: { portal: PORTAL_SESSION } });

  test("opens a portal for the caller's own store account", async () => {
    await linkProviderAccount(env.DB, "stripe", STRIPE_CUSTOMER, "ada", { now: NOW });
    const response = await request(app(), "POST", "/payments/portal", { user: "ada" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: PORTAL_SESSION.url });
    expect(lastStripeForm()).toContain(`customer=${STRIPE_CUSTOMER}`);
    expect(lastStripeForm()).toContain("return_url=https://acme.example/account");
    expect(actions()).toEqual(["payments/portal_opened:success"]);
  });

  test("the customer comes from the account map, so nobody can open somebody else's billing", async () => {
    // The route takes no body at all. There is exactly one customer a caller may manage, and it is the one their
    // own purchases are filed under.
    await linkProviderAccount(env.DB, "stripe", STRIPE_CUSTOMER, "ada", { now: NOW });
    await linkProviderAccount(env.DB, "stripe", "cus_PithyGrace", "grace", { now: NOW });
    await request(app(), "POST", "/payments/portal", { user: "grace", body: { customer: STRIPE_CUSTOMER } });
    expect(lastStripeForm()).toContain("customer=cus_PithyGrace");
    expect(lastStripeForm()).not.toContain(STRIPE_CUSTOMER);
  });

  test("a caller who has never bought through Stripe gets a 404, not a broken session", async () => {
    const response = await request(app(), "POST", "/payments/portal", { user: "ada" });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("core/not_found");
    expect(stripeCalls).toEqual([]);
  });

  test("an unauthenticated caller is 401", async () => {
    expect((await request(app(), "POST", "/payments/portal")).status).toBe(401);
  });

  test("an unconfigured Billing Portal reaches the caller as an unavailable payment method", async () => {
    await linkProviderAccount(env.DB, "stripe", STRIPE_CUSTOMER, "ada", { now: NOW });
    const response = await request(makeApp(CATALOG, { stripe: { status: 400 } }), "POST", "/payments/portal", {
      user: "ada",
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("payments/rail_not_configured");
  });
});

describe("POST /payments/purchases, on the Stripe rail", () => {
  /** What Stripe answers a session retrieve with, expanded the way the rail asks for it. */
  const session = (overrides: Record<string, unknown> = {}) => ({
    ...copy(stripeSessionSubscription).data.object,
    subscription: copy(stripeSubscriptionCreated).data.object,
    ...overrides,
  });

  test("a returning buyer submits the session id and sees the entitlement at once", async () => {
    // Hosted Checkout returns the browser to `success_url` with the session id substituted in. Submitting it is
    // Stripe's client-submission path — worth nothing to correctness, because the webhook produces the identical
    // row, and everything to the buyer staring at a thank-you page.
    const app = makeApp(CATALOG, { stripe: { session: session() } });
    const response = await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "stripe", receipt: "cs_test_pithyPro" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      purchase: { rail: "stripe", productId: "pro_monthly", status: "active", outcome: "created" },
      entitlements: [{ key: "pro", granted: true }],
    });
    const links = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(links[0]).toMatchObject({ providerAccountId: STRIPE_CUSTOMER, userId: "ada" });
  });

  test("another user submitting the same session is a 409, and the row does not move", async () => {
    // A session id is not a secret. What makes submitting somebody else's worthless is that the session names
    // the purchaser this deployment sent to Checkout.
    const app = makeApp(CATALOG, { stripe: { session: session() } });
    const body = { rail: "stripe", receipt: "cs_test_pithyPro" };
    await request(app, "POST", "/payments/purchases", { user: "ada", body });
    const stolen = await request(app, "POST", "/payments/purchases", { user: "grace", body });
    expect(stolen.status).toBe(409);
    expect(await errorCode(stolen)).toBe("payments/receipt_already_owned");
    expect((await purchases())[0]?.userId).toBe("ada");
    expect(actions()).toEqual(["payments/purchase_verified:success", "payments/purchase_verified:denied"]);
  });

  test("a session id Stripe has never heard of is a 400", async () => {
    const response = await request(makeApp(CATALOG, { stripe: {} }), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "stripe", receipt: "cs_test_nothingHere" },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/verification_failed");
  });

  test("a receipt that is not a session id is refused without calling Stripe", async () => {
    const response = await request(makeApp(CATALOG, { stripe: {} }), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "stripe", receipt: "sub_1PithyAdaPro" },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("payments/invalid_receipt");
    expect(stripeCalls).toEqual([]);
  });

  test("the client submission and its webhook produce one purchase and one entitlement", async () => {
    // The claim the whole design rests on, on the third rail.
    const app = makeApp(CATALOG, { stripe: { session: session() } });
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "stripe", receipt: "cs_test_pithyPro" },
    });
    await stripeHook(app, stripeSubscriptionCreated);
    expect(await purchases()).toHaveLength(1);
    expect(await entitlements()).toHaveLength(1);
  });

  test("a refunded purchase cannot be resurrected by re-posting its own session id", async () => {
    // The exploit this dating exists to stop, end to end. A completed Checkout Session is a frozen snapshot:
    // `payment_status` reads `paid` for ever, refund or no refund. Dating that snapshot with our own clock let
    // the buyer re-post the `cs_…` id from her success URL after the refund had landed — every owner check
    // passes, because the session names her — and the write outranked the refund and re-granted for good.
    const app = makeApp(CATALOG, { stripe: { session: copy(stripeSessionPayment).data.object } });
    await stripeHook(app, stripeSessionPayment);
    await stripeHook(app, chargeRefunded);
    expect((await purchases())[0]).toMatchObject({ status: "refunded" });

    const response = await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "stripe", receipt: "cs_test_pithyCoins" },
    });
    expect(response.status).toBe(200);
    const rows = await purchases();
    expect(rows).toHaveLength(1);
    // Still refunded, still revoked at the refund's own time: the snapshot is dated by Stripe's clock, so it
    // cannot outrank a refund it predates.
    expect(rows[0]).toMatchObject({ status: "refunded", revokedAt: Number(chargeRefunded.created) * 1000 });
  });

  test("a retrieve reads the refund off the charge Stripe expanded, so a lost refund webhook still lands", async () => {
    // The other half of the same defect. The session says nothing about a refund, so the retrieve expands
    // `payment_intent.latest_charge` and the charge says what became of the money. Without it this path would
    // answer `active` for ever on a purchase Stripe has already given back.
    const refunded = {
      ...copy(stripeSessionPayment).data.object,
      payment_intent: {
        id: "pi_1PithyCoins",
        object: "payment_intent",
        created: copy(chargeRefunded).data.object.created,
        latest_charge: copy(chargeRefunded).data.object,
      },
    };
    const app = makeApp(CATALOG, { stripe: { session: refunded } });
    const response = await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "stripe", receipt: "cs_test_pithyCoins" },
    });
    expect(response.status).toBe(200);
    expect((await purchases())[0]).toMatchObject({
      providerTransactionId: "pi_1PithyCoins",
      status: "refunded",
      // News of a revocation is dated when we learned it: it can resurrect nothing, and dating it at the charge
      // would let the monotonic rule discard the repair.
      revokedAt: NOW.getTime(),
      providerEventAt: NOW.getTime(),
    });
  });
});

describe("one entitlement across two rails", () => {
  test("a purchase on Apple and a purchase on Google resolve to one entitlement", async () => {
    // The claim the capability exists for: buy Pro on iOS, be entitled on the web. Two rails, two purchase rows,
    // one `pro` — because gating code names an entitlement and only the catalog names a SKU.
    const app = makeApp(CATALOG, { play: { subscription: playSubscription } });
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "google", receipt: playReceipt() },
    });

    const rows = await purchases();
    expect(rows.map((row) => row.rail).sort()).toEqual(["apple", "google"]);
    const held = await entitlements();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ entitlement: "pro", active: 1 });
    expect(await (await request(app, "GET", "/payments/entitlements", { user: "ada" })).json()).toEqual({
      entitlements: [{ key: "pro", granted: true, expiresAt: new Date("2026-02-01T00:00:00Z").toISOString() }],
    });
  });
});

describe("one writer, three triggers", () => {
  test("a client submission and its webhook produce one purchase and one entitlement", async () => {
    // The claim the whole design rests on, asserted where both paths meet. Interleaved in both orders.
    const app = makeApp();
    const signedReceipt = await receipt();
    const signedNotification = await notification();

    await request(app, "POST", "/payments/purchases", { user: "ada", body: { rail: "apple", receipt: signedReceipt } });
    await request(app, "POST", "/payments/webhooks/apple", { body: { signedPayload: signedNotification } });
    expect(await purchases()).toHaveLength(1);
    expect(await entitlements()).toHaveLength(1);

    // And the other way round, from a clean table.
    for (const table of [...TABLES, ...LEDGER_TABLES]) await env.DB.exec(`DELETE FROM ${table}`);
    await request(app, "POST", "/payments/webhooks/apple", { body: { signedPayload: signedNotification } });
    await request(app, "POST", "/payments/purchases", { user: "ada", body: { rail: "apple", receipt: signedReceipt } });
    expect(await purchases()).toHaveLength(1);
    expect(await entitlements()).toHaveLength(1);
  });
});

/**
 * Fulfillment through the routes: the ledger credit a `grants` clause promised, on the two paths a purchase
 * actually arrives by.
 *
 * The unit-level guarantees are proved in `grants/*.workers.test.ts`. What is proved here is the wiring — that
 * both a client submission and a webhook reach the ledger, that the two together credit once, and that a
 * refund does nothing to a balance unless the catalog asked for it.
 */
const CLAWBACK_CATALOG: PaymentsConfigInput = {
  ...CATALOG,
  products: {
    ...CATALOG.products,
    coins_100: { ...CATALOG.products?.coins_100, type: "consumable", name: "100 coins", clawback: true },
  },
};

const ledger = () => openLedger(env.DB, () => NOW.getTime());
const coinBalance = async (userId: string) => (await ledger().balance(userId, "coins")).balance;

/** A signed Apple refund for the coin pack, dated after the charge so the projection accepts it. */
const coinsRefund = () =>
  signNotification(
    {
      notification: {
        ...refundFixture.notification,
        signedDate: (oneTimeCharge.transaction.signedDate as number) + 3_600_000,
      },
      transaction: {
        ...oneTimeCharge.transaction,
        revocationDate: (oneTimeCharge.transaction.purchaseDate as number) + 3_600_000,
        revocationReason: 0,
      },
    },
    chain,
  );

describe("ledger fulfillment", () => {
  test("a client-submitted coin pack credits the balance the catalog promised", async () => {
    const response = await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await signJws(oneTimeCharge.transaction, chain) },
    });
    expect(response.status).toBe(200);
    expect(await coinBalance("ada")).toBe(100);
  });

  test("the same purchase submitted twice credits once", async () => {
    const app = makeApp();
    const signed = await signJws(oneTimeCharge.transaction, chain);
    await request(app, "POST", "/payments/purchases", { user: "ada", body: { rail: "apple", receipt: signed } });
    await request(app, "POST", "/payments/purchases", { user: "ada", body: { rail: "apple", receipt: signed } });
    expect(await coinBalance("ada")).toBe(100);
  });

  test("the webhook path credits too, and interleaving it with the submission still credits once", async () => {
    const app = makeApp();
    await linkProviderAccount(env.DB, "apple", APPLE_ACCOUNT, "ada", { now: NOW });
    await request(app, "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await signNotification(oneTimeCharge, chain) },
    });
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await signJws(oneTimeCharge.transaction, chain) },
    });
    expect(await coinBalance("ada")).toBe(100);
  });

  test("a product that grants no balance never opens the ledger", async () => {
    // `pro_monthly` has no `grants` clause, so the optional peer must not be reached at all. The assertion a
    // test can make is the observable one: nothing was written to a ledger that exists but was never asked.
    await request(makeApp(), "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_ledger_transactions").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  test("a refund leaves the balance alone unless the catalog opted into clawback", async () => {
    const app = makeApp();
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await signJws(oneTimeCharge.transaction, chain) },
    });
    const response = await request(app, "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await coinsRefund() },
    });

    expect(response.status).toBe(200);
    expect((await purchases())[0]?.status).toBe("refunded");
    // Default off. The user may have spent it, and a store's refund is not automatically a fraud finding.
    expect(await coinBalance("ada")).toBe(100);
  });

  test("a clawback-enabled catalog reverses the credit on the refund", async () => {
    const app = makeApp(CLAWBACK_CATALOG);
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await signJws(oneTimeCharge.transaction, chain) },
    });
    expect(await coinBalance("ada")).toBe(100);

    const response = await request(app, "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await coinsRefund() },
    });
    expect(response.status).toBe(200);
    expect(await coinBalance("ada")).toBe(0);
  });

  test("a spent balance refuses the clawback, the refund still lands, and the shortfall is recorded", async () => {
    const app = makeApp(CLAWBACK_CATALOG);
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await signJws(oneTimeCharge.transaction, chain) },
    });
    await ledger().debit("ada", "coins", 70, "game:spend:1");
    emitted = [];

    const response = await request(app, "POST", "/payments/webhooks/apple", {
      body: { signedPayload: await coinsRefund() },
    });

    // The webhook is still a 200 — the delivery was processed, and Apple has nothing to redeliver.
    expect(response.status).toBe(200);
    expect((await purchases())[0]?.status).toBe("refunded");
    // Neither a negative balance nor a silent write-off.
    expect(await coinBalance("ada")).toBe(30);
    const failure = emitted.find((event) => event.action === PaymentsAuditActions.clawbackFailed);
    expect(failure?.severity).toBe("critical");
    expect(failure?.metadata).toMatchObject({
      userId: "ada",
      currency: "coins",
      amount: 100,
      reason: "payments/clawback_failed",
    });
  });
});

/**
 * The control plane: the only way an entitlement appears without money moving, and therefore the surface with
 * the most to prove. One gate — core's `requireControlPlane` — over a real signed credential, one scope per
 * operation, audited to the management client, and the subject named in the body rather than read from a seam.
 *
 * Every case below runs the genuine verification pipeline. A refusal here is the pipeline refusing, and a pass
 * is a real Ed25519 signature over the exact bytes the request carried.
 */
describe("POST /payments/entitlements/grant", () => {
  const path = "/payments/entitlements/grant";
  const body = { userId: "grace", entitlement: "pro" };
  /** A token minted for this route's own operation, by the support tool. */
  const granting = { controlPlane: { scope: PAYMENTS_ENTITLEMENT_GRANT_SCOPE, subject: "support-1" } };

  test("401 with no credential at all", async () => {
    const response = await request(makeApp(), "POST", path, { body });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("controlplane/invalid_credential");
    expect(await entitlements()).toEqual([]);
  });

  test("403 when the seam is not composed — the route is shut, not open", async () => {
    // A Worker that added payments and never added `controlplane()`. The gate it imports denies rather than
    // passing, which is the whole reason an admin route may import its authorization from core at all.
    const response = await request(makeApp(CATALOG, { controlPlane: null }), "POST", path, { ...granting, body });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/not_connected");
    expect(await entitlements()).toEqual([]);
  });

  test("an ordinary signed-in user opens nothing, even carrying the scope strings", async () => {
    // The interim gate read `c.var.auth.scopes`, so a user token spelling these used to pass. It is worth
    // nothing now: this route never looks at the AuthContext, and a management call never populates one.
    const response = await request(makeApp(), "POST", path, {
      user: "ada",
      scopes: `payments:admin,${PAYMENTS_CONTROL_PLANE_SCOPES.join(",")}`,
      body,
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("controlplane/invalid_credential");
    expect(await entitlements()).toEqual([]);
  });

  test("403 when the adopter granted the connection revoke and not grant", async () => {
    // The point of splitting the scope. A refund tool cannot comp, whatever its token asks for.
    const app = makeApp(CATALOG, { controlPlane: [PAYMENTS_ENTITLEMENT_REVOKE_SCOPE] });
    const response = await request(app, "POST", path, { ...granting, body });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
    expect(await entitlements()).toEqual([]);
  });

  test("403 when the token is minted for the other operation", async () => {
    // Both scopes granted, but one token exercises exactly one operation. The revoke token is refused here
    // even though the same connection could revoke with it — the token's scope must match the route's.
    const response = await request(makeApp(), "POST", path, {
      controlPlane: { scope: PAYMENTS_ENTITLEMENT_REVOKE_SCOPE },
      body,
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
    expect(await entitlements()).toEqual([]);
  });

  test("does not tell an unverified caller whether its body was well-formed", async () => {
    // The validator sits behind the gate. A 400 here would confirm the shape of a request the caller may not
    // send, which is what a validator ahead of a guard leaks.
    const response = await request(makeApp(), "POST", path, { body: { nonsense: true } });
    expect(response.status).toBe(401);
  });

  test("grants, and audits the write to the management client rather than to a user", async () => {
    const response = await request(makeApp(), "POST", path, { ...granting, body });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entitlement: { key: "pro", granted: true, expiresAt: null } });
    expect(await entitlements()).toMatchObject([
      { userId: "grace", entitlement: "pro", active: 1, sourcePurchaseId: null },
    ]);

    const recorded = emitted.find((event) => event.action === PaymentsAuditActions.entitlementGranted);
    expect(recorded?.outcome).toBe("success");
    expect(recorded?.severity).toBe("warning");
    // `control-plane`, not `user`: the trail must be able to answer "was this our customer or the dashboard".
    expect(recorded?.actorType).toBe("control-plane");
    expect(recorded?.actorId).toBe("support-1");
    // No session exists on a management call, so none is claimed.
    expect(recorded?.sessionId).toBeUndefined();
    expect(recorded?.metadata).toMatchObject({
      connectionId: CONNECTION_ID,
      userId: "grace",
      entitlement: "pro",
      expiresAt: null,
    });
  });

  test("takes an expiry, so a comp can end", async () => {
    const expiresAt = new Date(NOW.getTime() + 30 * 86_400_000);
    const response = await request(makeApp(), "POST", path, {
      ...granting,
      body: { ...body, expiresAt: expiresAt.toISOString() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entitlement: { expiresAt: expiresAt.toISOString() } });
  });

  test("refuses an entitlement key the seam would never accept", async () => {
    const response = await request(makeApp(), "POST", path, {
      ...granting,
      body: { userId: "grace", entitlement: "Pro Monthly!" },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("validation/invalid_input");
  });

  test("one token, one call — a replayed request is refused", async () => {
    // The guard reads the body to check the digest and the validator parses it afterwards, so the happy path
    // above already proves the clone. This proves the other half: the same token cannot be spent twice.
    const app = makeApp();
    const options = {
      controlPlane: { ...granting.controlPlane, tokenId: "aa5f0f8c-9d31-4a20-b0c7-3e2f5c9a1d64" },
      body,
    };
    expect((await request(app, "POST", path, options)).status).toBe(200);
    expect((await request(app, "POST", path, options)).status).toBe(401);
  });

  test("a comped account reads its entitlement back through the ordinary route", async () => {
    const app = makeApp();
    await request(app, "POST", path, { ...granting, body });
    const response = await request(app, "GET", "/payments/entitlements", { user: "grace" });
    expect(await response.json()).toEqual({ entitlements: [{ key: "pro", granted: true, expiresAt: null }] });
  });
});

describe("POST /payments/entitlements/revoke", () => {
  const path = "/payments/entitlements/revoke";
  const body = { userId: "ada", entitlement: "pro" };
  const revoking = { controlPlane: { scope: PAYMENTS_ENTITLEMENT_REVOKE_SCOPE, subject: "support-1" } };

  test("401 with no credential, 403 with the seam uncomposed", async () => {
    expect((await request(makeApp(), "POST", path, { body })).status).toBe(401);
    const uncomposed = await request(makeApp(CATALOG, { controlPlane: null }), "POST", path, { ...revoking, body });
    expect(uncomposed.status).toBe(403);
    expect(await errorCode(uncomposed)).toBe("controlplane/not_connected");
  });

  test("403 when the adopter granted the connection grant and not revoke", async () => {
    // The mirror of the grant route's case, and the other half of why one `payments:admin` flag was wrong: a
    // comp tool cannot take paid access away from a live customer.
    const app = makeApp(CATALOG, { controlPlane: [PAYMENTS_ENTITLEMENT_GRANT_SCOPE] });
    const response = await request(app, "POST", path, { ...revoking, body });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
  });

  test("an ordinary signed-in user opens nothing here either", async () => {
    const response = await request(makeApp(), "POST", path, {
      user: "ada",
      scopes: PAYMENTS_CONTROL_PLANE_SCOPES.join(","),
      body,
    });
    expect(response.status).toBe(401);
  });

  test("clears a purchase-derived entitlement immediately, and audits it", async () => {
    const app = makeApp();
    await request(app, "POST", "/payments/purchases", {
      user: "ada",
      body: { rail: "apple", receipt: await receipt() },
    });
    expect((await entitlements())[0]?.active).toBe(1);
    emitted = [];

    const response = await request(app, "POST", path, { ...revoking, body });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entitlement: { key: "pro", granted: false, expiresAt: null } });
    const read = await request(app, "GET", "/payments/entitlements", { user: "ada" });
    expect(await read.json()).toEqual({ entitlements: [{ key: "pro", granted: false, expiresAt: null }] });

    const recorded = emitted.find((event) => event.action === PaymentsAuditActions.entitlementRevoked);
    expect(recorded?.severity).toBe("warning");
    expect(recorded?.actorType).toBe("control-plane");
    expect(recorded?.actorId).toBe("support-1");
    expect(recorded?.metadata).toMatchObject({
      connectionId: CONNECTION_ID,
      userId: "ada",
      entitlement: "pro",
    });
  });

  test("is idempotent, and legal against an account that never held the key", async () => {
    const app = makeApp();
    const options = { ...revoking, body: { userId: "grace", entitlement: "pro" } };
    expect((await request(app, "POST", path, options)).status).toBe(200);
    expect((await request(app, "POST", path, options)).status).toBe(200);
    expect(await entitlements()).toHaveLength(1);
  });
});

describe("wiring", () => {
  test("a missing DB binding is a 500 that names the binding for an operator and not for a client", async () => {
    const app = makeApp();
    const response = await app.request(
      "http://x/payments/entitlements",
      { headers: { "x-user": "ada" } },
      { ENVIRONMENT: "production" },
    );
    expect(response.status).toBe(500);
    const body = await response.json<{ error: { message: string; detail?: string } }>();
    expect(body.error.detail).toBeUndefined();
    expect(body.error.message).toBe("Payments is not configured.");
  });

  test("mounting under another basePath moves the webhook too", async () => {
    const app = new Hono<PithyHonoEnv>();
    app.onError(pithyErrorHandler);
    registerPaymentsRoutes({ config: PaymentsConfig.parse({ ...CATALOG, basePath: "/billing" }), now: () => NOW })(app);
    expect((await app.request("http://x/payments/webhooks/apple", { method: "POST" }, { ...env })).status).toBe(404);
  });
});
