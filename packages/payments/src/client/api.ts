// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The framework-free half of the client surface: five calls against this project's own payments routes,
 * and the guards that make their answers safe to read.
 *
 * **This module lives in the package on purpose.** `pithy ui add` writes a screen once and may never
 * rewrite it, and a frozen paywall ages badly — store rules move under it, so price-change consent
 * prompts, external purchase link entitlements, and subscription-management requirements all arrive
 * after the file was written. So the calls, the error mapping, and the redirect-and-return dance ship
 * here and upgrade with a minor release; the scaffolded stub renders and styles, and calls these.
 *
 * **Cookie/session, same origin.** Every request carries `credentials: "include"` and nothing else. No
 * token in `localStorage` or `sessionStorage`, no `Authorization` header, no refresh rotation. The SPA
 * and its Worker share an origin, so the session rides an httpOnly cookie that JavaScript cannot read
 * and the server's same-origin check covers CSRF. Bearer is the mobile path — supported by the same
 * routes, documented rather than scaffolded.
 *
 * **Nothing here throws, and nothing here hides a failure either.** An unreachable Worker, an HTML error
 * page from a proxy, a 500 — each becomes a renderable {@link PaymentsFailure} on a `PaymentsResult`, and
 * every reader answers one. Failing shut is a decision for a caller to make and to write down: a route
 * guard does `result.ok && result.value.some(…)`, a screen that names the plan reports the failure
 * instead. A reader that collapsed the two would make the choice for callers that must not have it made
 * for them, which is what `api.test.ts` now holds the module to.
 *
 * The server's `requireEntitlement()` is still the security boundary. Nothing on this side of the wire
 * protects a feature; it only decides what a screen shows.
 *
 * **No absolute URL literals, and no schema library.** Paths are relative, so the calls follow whatever
 * origin the bundle is served from. Answers are narrowed by hand-written `is…(value: unknown): value is T`
 * guards rather than Zod: this file is compiled into a browser bundle, and it must not drag the server's
 * schema graph in behind it.
 */

/** Where the payments routes mount by default — the same default `PaymentsConfig.basePath` carries. */
export const PAYMENTS_BASE_PATH = "/payments";

/**
 * The query parameter a returning Stripe buyer carries the Checkout Session id in.
 *
 * It is a default, not a rule: `config.stripe.successUrl` is the adopter's own URL, and the documented
 * shape puts `{CHECKOUT_SESSION_ID}` in `?session=`. A project that named it something else passes the
 * name to {@link returnedCheckoutSession}.
 */
export const CHECKOUT_SESSION_PARAM = "session";

/**
 * The wire unions, declared literally rather than imported from `../data/*`.
 *
 * Those modules pull core's codecs and Zod into whatever TypeScript program typechecks this file, and
 * this file is typechecked inside an adopter's DOM-typed *browser* program, where the Worker's type
 * graph does not belong. `api.test.ts` pins each of these against the schema it mirrors, so the
 * duplication cannot drift.
 */
export type PaymentsClientRail = "apple" | "google" | "stripe" | "lemonSqueezy" | "paddle";

/**
 * The rails that create a hosted checkout a browser can be sent to.
 *
 * A strict subset of {@link PaymentsClientRail}: Apple and Google purchases happen inside a store SDK, so
 * there is no page to send anyone to. Nameable from a browser because a rail decides *who takes the money*,
 * not how much or on whose behalf — a paywall for a product sold on both can put two buttons on the page,
 * and a product sold on one needs no field at all.
 */
export type PaymentsHostedRail = "stripe" | "lemonSqueezy" | "paddle";

/**
 * The runtime mirror of {@link PaymentsHostedRail} — and the one list a screen gates a billing button on.
 *
 * Exported rather than private, because the screens need it. A scaffolded subscription page shows
 * "Manage billing" when any hosted rail is on, and a scaffolded paywall offers to sell on any hosted
 * rail a product is listed on: both are the same question, and both were open-coding the answer. A rail
 * added to the package now reaches a template that was copied into an adopter's repo a year ago,
 * because the template imports this rather than repeating it.
 *
 * Selling and portal-minting are one list, not two that agree — `CheckoutRail` declares both methods
 * together, so a rail cannot have one without the other. `../data/rail.ts` carries the argument in full,
 * and `providers.test.ts` holds this list to the rails that actually implement the interface.
 */
export const PAYMENTS_HOSTED_RAILS: readonly PaymentsHostedRail[] = ["stripe", "lemonSqueezy", "paddle"];

/** Which Paddle account a handoff belongs to. `Paddle.Environment.set` takes it verbatim. */
export type PaymentsPaddleEnvironment = "sandbox" | "production";

/** Whether a Paddle checkout opens over the page or inside a container the screen provides. */
export type PaymentsPaddleDisplayMode = "overlay" | "inline";

/** The runtime mirrors of the two unions above, for the guards. */
const PADDLE_ENVIRONMENTS: readonly PaymentsPaddleEnvironment[] = ["sandbox", "production"];
const PADDLE_DISPLAY_MODES: readonly PaymentsPaddleDisplayMode[] = ["overlay", "inline"];

/**
 * How the browser reaches checkout — a page to go to, or a transaction to open in place.
 *
 * A union rather than `{ url }`, because one rail has no URL to give: Paddle's overlay and inline modes
 * never leave this page. A screen narrows on `kind`, which is a compile error where it is missing rather
 * than a runtime navigation to an empty string.
 */
export type PaymentsCheckoutHandoff = { kind: "redirect"; url: string } | PaddleCheckoutHandoff;

/**
 * The handoff a Paddle checkout returns: a transaction, and what a browser needs to open it.
 *
 * Named rather than inlined because a screen holds one — `useCheckout` exposes it, and a `Paddle.Checkout
 * .open` call site needs a type to write against.
 */
export interface PaddleCheckoutHandoff {
  /** Discriminates this from a redirect. */
  kind: "paddle";
  /** The transaction the server created — `txn_…`. */
  transactionId: string;
  /** Paddle's publishable client token, which is designed to reach a browser. */
  clientToken: string;
  /** Which Paddle account the token belongs to. */
  environment: PaymentsPaddleEnvironment;
  /** Whether the checkout opens over the page or inside a container. */
  displayMode: PaymentsPaddleDisplayMode;
}

/** One subscription's authenticated portal deep links. */
export interface PaymentsPortalSubscription {
  /** The store's own subscription id. */
  subscriptionId: string;
  /** Where this subscription is cancelled. */
  cancel: string;
  /** Where this subscription's payment method is changed. */
  updatePaymentMethod: string;
}

/**
 * The caller's billing portal: an overview page, and any per-subscription deep links the store minted.
 *
 * **Every URL here is a bearer credential for that customer's billing.** Paddle's overview link carries a
 * token good for 24 hours with scopes covering subscription updates and transaction creation, so a screen
 * navigates to one and never stores it, logs it, or puts it in a query string something else will read.
 */
export interface PaymentsPortalHandoff {
  /** The portal's overview page. */
  url: string;
  /** Per-subscription deep links, for the store that offers them. */
  subscriptions?: readonly PaymentsPortalSubscription[];
}

/** What kind of thing a product is, as a browser reads it. */
export type PaymentsClientProductType = "consumable" | "non_consumable" | "subscription";

/** The normalized purchase status, as a browser reads it. */
export type PaymentsClientStatus =
  | "active"
  | "in_grace"
  | "on_hold"
  | "canceled"
  | "expired"
  | "never_paid"
  | "refunded"
  | "revoked"
  | "paused";

/** Which store environment a purchase happened in, as a browser reads it. */
export type PaymentsClientEnvironment = "production" | "sandbox";

/** One entitlement as `GET /payments/entitlements` returns it. */
export interface EntitlementView {
  /** The entitlement key gating code names — `pro`, never a SKU. */
  key: string;
  /** Whether it grants access right now. The server rechecks expiry on every read. */
  granted: boolean;
  /** When it lapses, as an ISO string, or null for one that never does. */
  expiresAt: string | null;
}

/** One purchase as the write routes return it. Deliberately not the row — a client has no use for its own receipt. */
export interface PurchaseView {
  /** The purchase's id. */
  id: string;
  /** Which store it came from. */
  rail: PaymentsClientRail;
  /** The logical catalog product id. */
  productId: string;
  /** What kind of product it is. */
  type: PaymentsClientProductType;
  /** The normalized status. */
  status: PaymentsClientStatus;
  /** Which store environment it happened in. */
  environment: PaymentsClientEnvironment;
  /** When the store recorded it, as an ISO string. */
  purchasedAt: string;
  /** When access lapses, as an ISO string, or null. */
  expiresAt: string | null;
  /** What this submission did to the projection. `ignored` is a replay, and a replay is a success. */
  outcome: "created" | "updated" | "ignored";
}

/** A refusal a screen can render: the namespaced code, the public message, and what to do next. */
export interface PaymentsFailure {
  /** The namespaced code — `payments/product_not_found`, or a `client/*` sentinel this module minted. */
  code: string;
  /** The public message. The server's `detail` never crosses the HTTP codec, so this is all there is. */
  message: string;
  /** What to do next, when the server offered one. */
  action: string | null;
}

/** Either the value, or a failure to render. Never a throw. */
export type PaymentsResult<T> = { ok: true; value: T } | { ok: false; failure: PaymentsFailure };

/** What `POST /payments/purchases` answers with. */
export interface PurchaseReceipt {
  /** The purchase as it now stands. */
  purchase: PurchaseView;
  /** The caller's entitlements after the write, so a screen needs no second round trip. */
  entitlements: readonly EntitlementView[];
}

/** What `POST /payments/restore` answers with. */
export interface RestoredPurchases {
  /** Every purchase the batch projected. */
  purchases: readonly PurchaseView[];
  /** The caller's entitlements after the restore. */
  entitlements: readonly EntitlementView[];
}

/**
 * The slice of `fetch` this module uses, declared structurally.
 *
 * Not `typeof fetch`: the package compiles against `@cloudflare/workers-types`, whose `RequestInit` has
 * no `credentials` — and `credentials: "include"` is the entire cookie story. Declaring the shape keeps
 * one signature true in a Worker-typed program, in a browser, and in a test that injects a stub.
 */
export interface PaymentsRequestInit {
  /** The HTTP method. Absent means GET. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** The JSON body, already serialized. */
  body?: string;
  /** Cookie policy. Always `include` here — same-origin, httpOnly session cookie. */
  credentials?: "include" | "same-origin" | "omit";
}

/** The slice of `Response` this module reads. */
export interface PaymentsResponse {
  /** Whether the status was 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The parsed body, or a rejection when it was not JSON. */
  json(): Promise<unknown>;
}

/** A fetch this module can call. */
export type PaymentsFetch = (input: string, init?: PaymentsRequestInit) => Promise<PaymentsResponse>;

/** Leaving the page for a hosted Stripe flow. */
export type Navigate = (url: string) => void;

/**
 * The browser globals this module reaches for, as an injectable seam.
 *
 * Reached through an object rather than `window` because the package compiles in a program with no DOM
 * lib, alongside the Worker code — the same collision `@pithy-sh/ui-react` keeps a second tsconfig to
 * avoid. Injecting it is also what lets a test prove the no-browser path without a DOM.
 */
export interface PaymentsGlobal {
  /** The browser's fetch. */
  fetch?: PaymentsFetch;
  /** The browser's location — read for the return query string, called to leave for a hosted page. */
  location?: { search?: string; assign?: (url: string) => void };
}

/** What every call takes: where the routes are, and the seams a test replaces. */
export interface PaymentsClientOptions {
  /** Where the payments routes mount. Defaults to {@link PAYMENTS_BASE_PATH}. */
  basePath?: string;
  /** The fetch to use. Defaults to the one on {@link PaymentsClientOptions.global}. */
  fetch?: PaymentsFetch;
  /** How to leave for a hosted page. Defaults to the browser's own `location.assign`. */
  navigate?: Navigate;
  /** The global object the defaults come off. Defaults to `globalThis`. */
  global?: PaymentsGlobal;
}

/** The worker could not be reached at all. Offline, or a DNS failure, or a hard CORS refusal. */
export const PAYMENTS_UNREACHABLE: PaymentsFailure = {
  code: "client/unreachable",
  message: "We couldn't reach the store.",
  action: "Check your connection, then try again.",
};

/** The worker answered with something this client cannot read. A proxy's HTML page, or a shape change. */
export const PAYMENTS_UNREADABLE: PaymentsFailure = {
  code: "client/unreadable",
  message: "The store answered with something we couldn't read.",
  action: "Try again. If it keeps happening, the app and the backend are out of step.",
};

/** There is no browser here to send anywhere — server-side rendering, or a test with no DOM. */
export const PAYMENTS_NO_BROWSER: PaymentsFailure = {
  code: "client/no_browser",
  message: "There's no browser to send you to the payment page.",
  action: "Start checkout from the page in the browser, not before it has loaded.",
};

/** Whether a value is a plain record — the first step of every guard below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a string, or explicitly null. The shape every nullable timestamp arrives in. */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Whether a value is one of a fixed set of strings. */
function isMember<T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === "string" && (members as readonly string[]).includes(value);
}

const RAILS: readonly PaymentsClientRail[] = ["apple", "google", "stripe", "lemonSqueezy", "paddle"];
const PRODUCT_TYPES: readonly PaymentsClientProductType[] = ["consumable", "non_consumable", "subscription"];
const STATUSES: readonly PaymentsClientStatus[] = [
  "active",
  "in_grace",
  "on_hold",
  "canceled",
  "expired",
  "never_paid",
  "refunded",
  "revoked",
  "paused",
];
const ENVIRONMENTS: readonly PaymentsClientEnvironment[] = ["production", "sandbox"];
const OUTCOMES: readonly PurchaseView["outcome"][] = ["created", "updated", "ignored"];

/** Whether a value is one entitlement as the route returns it. */
export function isEntitlementView(value: unknown): value is EntitlementView {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.granted === "boolean" &&
    isNullableString(value.expiresAt)
  );
}

/** Whether a value is one purchase as the write routes return it. */
export function isPurchaseView(value: unknown): value is PurchaseView {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isMember(value.rail, RAILS) &&
    typeof value.productId === "string" &&
    isMember(value.type, PRODUCT_TYPES) &&
    isMember(value.status, STATUSES) &&
    isMember(value.environment, ENVIRONMENTS) &&
    typeof value.purchasedAt === "string" &&
    isNullableString(value.expiresAt) &&
    isMember(value.outcome, OUTCOMES)
  );
}

/** Every element, or nothing. A half-read list is worse than none — a screen renders the gap as absence. */
function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

/**
 * Whether a string is a URL this client may navigate to.
 *
 * The scheme check is the point. Such a URL is handed straight to `location.assign`, and
 * `javascript:` there executes in the current page — the same guard the scaffolded sign-in screen makes
 * on a social redirect, made here because here is where the value is read.
 */
function isNavigable(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Whether a value is a checkout handoff this client can act on.
 *
 * Two shapes, and each is checked for what acting on it would do. A `redirect` is navigated to, so its
 * URL goes through {@link isNavigable}. A `paddle` handoff is passed to `Paddle.Checkout.open`, so every
 * field it carries has to be a string of the right kind — an environment or a display mode this client
 * does not know is a server it does not understand, and guessing would open a checkout in the wrong
 * Paddle account.
 */
function isCheckoutHandoff(value: unknown): value is PaymentsCheckoutHandoff {
  if (!isRecord(value)) return false;
  if (value.kind === "redirect") return isNavigable(value.url);
  if (value.kind !== "paddle") return false;
  return (
    isNonEmpty(value.transactionId) &&
    isNonEmpty(value.clientToken) &&
    isMember(value.environment, PADDLE_ENVIRONMENTS) &&
    isMember(value.displayMode, PADDLE_DISPLAY_MODES)
  );
}

/** Whether a value is a portal handoff: an overview page, and any per-subscription deep links. */
function isPortalHandoff(value: unknown): value is PaymentsPortalHandoff {
  if (!isRecord(value) || !isNavigable(value.url)) return false;
  if (value.subscriptions === undefined) return true;
  return isArrayOf(value.subscriptions, isPortalSubscription);
}

/** Whether a value is one subscription's deep links. Every URL is navigated to, so every URL is checked. */
function isPortalSubscription(value: unknown): value is PaymentsPortalSubscription {
  return (
    isRecord(value) &&
    isNonEmpty(value.subscriptionId) &&
    isNavigable(value.cancel) &&
    isNavigable(value.updatePaymentMethod)
  );
}

/** A non-empty string. */
function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** The globals to use — the injected ones, else the real ones. */
function globals(options: PaymentsClientOptions | undefined): PaymentsGlobal {
  return options?.global ?? (globalThis as PaymentsGlobal);
}

/** A failure read off `{ error: { code, message, action } }`, or the generic one when the body is not that. */
function readFailure(body: unknown): PaymentsFailure {
  if (!isRecord(body) || !isRecord(body.error)) return PAYMENTS_UNREADABLE;
  const { code, message, action } = body.error;
  if (typeof code !== "string" || typeof message !== "string") return PAYMENTS_UNREADABLE;
  return { code, message, action: typeof action === "string" ? action : null };
}

/**
 * One call: same-origin, cookie-carrying, never throwing.
 *
 * The body is read before the status is judged, because a refusal's body is the failure a screen renders.
 * A body that will not parse is the generic failure rather than a crash — a corporate proxy's HTML page
 * reaches a browser far more often than anyone expects.
 */
async function call<T>(
  path: string,
  init: PaymentsRequestInit,
  options: PaymentsClientOptions | undefined,
  guard: (value: unknown) => value is T,
): Promise<PaymentsResult<T>> {
  const fetcher = options?.fetch ?? globals(options).fetch;
  if (!fetcher) return { ok: false, failure: PAYMENTS_UNREACHABLE };

  const base = options?.basePath ?? PAYMENTS_BASE_PATH;
  let response: PaymentsResponse;
  try {
    response = await fetcher(`${base}${path}`, { ...init, credentials: "include" });
  } catch {
    return { ok: false, failure: PAYMENTS_UNREACHABLE };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Success or refusal, an unparseable body says the same thing: whatever answered was not this Worker.
    return { ok: false, failure: PAYMENTS_UNREADABLE };
  }

  if (!response.ok) return { ok: false, failure: readFailure(body) };
  return guard(body) ? { ok: true, value: body } : { ok: false, failure: PAYMENTS_UNREADABLE };
}

/** A JSON POST body, serialized once so the request signature stays one shape. */
function jsonPost(body: unknown): PaymentsRequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Whether a value is the entitlements envelope. */
function isEntitlementsBody(value: unknown): value is { entitlements: EntitlementView[] } {
  return isRecord(value) && isArrayOf(value.entitlements, isEntitlementView);
}

/** Whether a value is the purchase envelope both write routes' single-purchase form returns. */
function isPurchaseBody(value: unknown): value is { purchase: PurchaseView; entitlements: EntitlementView[] } {
  return isRecord(value) && isPurchaseView(value.purchase) && isArrayOf(value.entitlements, isEntitlementView);
}

/** Whether a value is the restore envelope. */
function isRestoreBody(value: unknown): value is { purchases: PurchaseView[]; entitlements: EntitlementView[] } {
  return (
    isRecord(value) && isArrayOf(value.purchases, isPurchaseView) && isArrayOf(value.entitlements, isEntitlementView)
  );
}

/**
 * The caller's own entitlements. Always the caller's — the id comes from the session, never from here.
 *
 * **A failure is not an empty list**, and the distinction is the whole point of the return type. Failing
 * shut is still the right default for a *lock*, because a lock is a refusal and the caller can carry an
 * escape route on it. It is wrong for a caller that **names** the plan: free is the floor of every ladder,
 * carrying no entitlement key and matching unconditionally, so `[]` is a positive assertion that this
 * customer is on the cheapest tier. A screen rendering that from a failed read tells an Enterprise
 * customer they are on Free and offers to sell them what they already pay for.
 *
 * So the failure `call` already built travels out intact, and a caller that wants fail-shut writes
 * `result.ok ? result.value : []` — one line, and it reads as the decision it is rather than as the
 * absence of one. {@link useEntitlement} does exactly that; {@link useSubscription} reports the failure.
 */
export async function getEntitlements(
  options?: PaymentsClientOptions,
): Promise<PaymentsResult<readonly EntitlementView[]>> {
  const result = await call("/entitlements", {}, options, isEntitlementsBody);
  return result.ok ? { ok: true, value: result.value.entitlements } : result;
}

/**
 * Submit one receipt for verification, so the buyer sees their entitlement without waiting for the webhook.
 *
 * On the web this is the Stripe return path: `successUrl` carries the Checkout Session id, and posting it
 * here projects the purchase at once. On a native client it is the store SDK's transaction. A replay by
 * its own owner is a 200 with `outcome: "ignored"` — the write path is idempotent, so repeating is free.
 */
export function submitPurchase(
  input: { rail: PaymentsClientRail; receipt: string },
  options?: PaymentsClientOptions,
): Promise<PaymentsResult<PurchaseReceipt>> {
  return call("/purchases", jsonPost(input), options, isPurchaseBody);
}

/**
 * Restore Purchases — rebind a store account's history to the signed-in user.
 *
 * Native only in practice: only the device can enumerate what its store account owns. One bad receipt
 * fails the whole batch by design, and every receipt that did project stays projected.
 */
export function restorePurchases(
  input: { rail: PaymentsClientRail; receipts: readonly string[] },
  options?: PaymentsClientOptions,
): Promise<PaymentsResult<RestoredPurchases>> {
  return call("/restore", jsonPost(input), options, isRestoreBody);
}

/** Create a checkout for a product, and say how the browser reaches it. */
export function createCheckout(
  input: { productId: string; rail?: PaymentsHostedRail; discountCode?: string },
  options?: PaymentsClientOptions,
): Promise<PaymentsResult<PaymentsCheckoutHandoff>> {
  return call("/checkout", jsonPost(input), options, isCheckoutHandoff);
}

/**
 * Create a Billing Portal session for the caller's own store account.
 *
 * No body, and that is the request contract: there is exactly one customer this caller may manage, and
 * the server resolves it from the provider-account map. A `customer` field here would be the whole
 * vulnerability.
 */
export function createPortal(options?: PaymentsClientOptions): Promise<PaymentsResult<PaymentsPortalHandoff>> {
  return call("/portal", { method: "POST" }, options, isPortalHandoff);
}

/** How to leave the page, from the injected navigator or the browser's own. */
function navigator(options: PaymentsClientOptions | undefined): Navigate | undefined {
  if (options?.navigate) return options.navigate;
  const location = globals(options).location;
  return location?.assign ? (url) => location.assign?.(url) : undefined;
}

/** Go to a URL a guard has already vetted. Null means the browser left; anything else is a failure. */
function leaveFor(url: string, options: PaymentsClientOptions | undefined): PaymentsFailure | null {
  const go = navigator(options);
  if (!go) return PAYMENTS_NO_BROWSER;
  go(url);
  return null;
}

/**
 * What starting a checkout did. Three outcomes, and a screen must tell them apart.
 *
 * `left` is a redirect rail: the browser is already going, and there is nothing to render. `paddle` is a
 * rail with nowhere to go — the screen opens the handoff with Paddle.js, over its own page. `refused` is
 * a failure worth showing.
 *
 * Deliberately not `PaymentsFailure | null` any more. That shape could only say "went" or "did not", and
 * a Paddle handoff is neither: collapsing it into `null` would leave a buyer on a paywall whose button
 * silently did nothing.
 */
export type PaymentsCheckoutStart =
  | { kind: "left" }
  | { kind: "paddle"; handoff: PaddleCheckoutHandoff }
  | { kind: "refused"; failure: PaymentsFailure };

/**
 * Buy a product: create the checkout, and either hand the browser over or hand the caller the handoff.
 *
 * A redirect rail needs no SDK script and no client-side key — the server mints a session and answers
 * with a URL, and a full page load is the whole integration. Paddle's overlay and inline modes need
 * Paddle.js and the publishable token the server returned, and opening it is the screen's job because
 * that is where the container lives. Pithy never owns payment UI, SCA, tax, or proration either way.
 */
export async function startCheckout(
  input: { productId: string; rail?: PaymentsHostedRail; discountCode?: string },
  options?: PaymentsClientOptions,
): Promise<PaymentsCheckoutStart> {
  const result = await createCheckout(input, options);
  if (!result.ok) return { kind: "refused", failure: result.failure };
  if (result.value.kind === "paddle") return { kind: "paddle", handoff: result.value };
  const refused = leaveFor(result.value.url, options);
  return refused === null ? { kind: "left" } : { kind: "refused", failure: refused };
}

/** Open the billing portal — where a subscriber changes a card, or cancels, under the store's own rules. */
export async function openBillingPortal(options?: PaymentsClientOptions): Promise<PaymentsFailure | null> {
  const result = await createPortal(options);
  return result.ok ? leaveFor(result.value.url, options) : result.failure;
}

/**
 * Where a store sends a subscriber to manage a subscription they bought in an app.
 *
 * These live in the package rather than in a scaffolded screen for the reason the whole client surface
 * does: they are Apple's and Google's URLs, not the adopter's, and when a store moves one the fix should
 * be a minor release rather than an edit to a file Pithy may never rewrite. It is also what keeps the
 * scaffolded templates free of absolute URLs, which the CLI's own scaffold check enforces.
 *
 * There is no Stripe entry. Stripe's equivalent is a *session* the server mints per caller — see
 * {@link openBillingPortal} — and a static URL there would be a link to nobody's account.
 */
export const STORE_SUBSCRIPTION_URLS: Readonly<Record<"apple" | "google", string>> = {
  apple: "https://apps.apple.com/account/subscriptions",
  google: "https://play.google.com/store/account/subscriptions",
};

/**
 * Send the browser to a store's own subscription-management page.
 *
 * Returns false only when there is no browser to send. A web page cannot cancel a StoreKit or Play
 * Billing subscription — the store owns that, by its own rules — so linking there is the whole of what a
 * web screen can honestly offer.
 */
export function openStoreSubscriptions(rail: "apple" | "google", options?: PaymentsClientOptions): boolean {
  const go = navigator(options);
  if (!go) return false;
  go(STORE_SUBSCRIPTION_URLS[rail]);
  return true;
}

/** What {@link returnedCheckoutSession} reads, and where from. */
export interface CheckoutReturnOptions {
  /** The query string to read. Defaults to the browser's own `location.search`. */
  search?: string;
  /** The parameter carrying the session id. Defaults to {@link CHECKOUT_SESSION_PARAM}. */
  param?: string;
  /** The global object `location` comes off. Defaults to `globalThis`. */
  global?: PaymentsGlobal;
}

/**
 * The Checkout Session id a returning buyer arrived with, or null.
 *
 * This is the second half of the redirect-and-return dance. Stripe substitutes the real id into the
 * `{CHECKOUT_SESSION_ID}` token in the adopter's `successUrl`, and posting it to `/payments/purchases`
 * projects the purchase immediately instead of waiting for the webhook. The webhook is still
 * authoritative and still arrives — this only decides whether the buyer sees their entitlement now or in
 * a few seconds.
 */
export function returnedCheckoutSession(options?: CheckoutReturnOptions): string | null {
  const search = options?.search ?? (options?.global ?? (globalThis as PaymentsGlobal)).location?.search ?? "";
  if (search === "") return null;
  const value = new URLSearchParams(search).get(options?.param ?? CHECKOUT_SESSION_PARAM);
  return value === null || value === "" ? null : value;
}
