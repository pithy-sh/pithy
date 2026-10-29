// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useAction } from "@pithy-sh/ui-core/src/action";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { useCallback, useRef, useState } from "react";
import {
  type AllowancesView,
  type EntitlementView,
  getAllowances,
  getEntitlements,
  openBillingPortal,
  openStoreSubscriptions,
  PAYMENTS_UNREADABLE,
  type PaddleCheckoutHandoff,
  type PaymentsClientOptions,
  type PaymentsClientRail,
  type PaymentsFailure,
  type PaymentsHostedRail,
  type PaymentsResult,
  type PurchaseView,
  restorePurchases,
  resumeCheckout,
  startCheckout,
  submitPurchase,
} from "./api";
import { openPaddleCheckout, type PaddleCheckoutOptions } from "./checkout";
import {
  loadPaddle,
  type PaddleJs,
  type PaddleOptions,
  type PaddlePriceQuery,
  type PaddleSetup,
  type PricePreview,
  previewPrices,
  priceQueryKey,
} from "./paddle";
import { readPaddleLinkTransaction } from "./paddleLink";

/**
 * The headless client surface: six hooks a paywall, a pricing page, a subscription screen, and a route
 * guard are built out of.
 *
 * **They live here rather than in a scaffolded `.tsx` on purpose.** `pithy ui add` writes a file once and
 * may never rewrite it, which is the right ownership rule and is exactly why a frozen paywall ages badly:
 * store rules move — price-change consent prompts, external purchase link entitlements, subscription
 * management requirements — and a purchase flow living in the adopter's repo is one Pithy cannot fix for
 * them. So the hook owns the calls, the redirect-and-return dance, the error mapping and the entitlement
 * reads, and upgrades with a minor release; the stub renders and styles, calling these rather than
 * reimplementing them. Principle 3, applied to the client.
 *
 * `react` is an **optional** peer dependency, and this module is reachable only by its own deep path
 * (`@pithy-sh/payments/src/client/hooks`). It is deliberately absent from `src/index.ts` — that is what
 * keeps React out of a Worker bundle that composes payments.
 *
 * The transport is whatever the options name, because `./api` decides it: with no `origin`, same-origin
 * with `credentials: "include"` and no token in web storage; with an `origin` and the bearer session's
 * `fetch`, a native app's request that sends no cookie. These hooks hold no credential either way.
 *
 * **Nothing here throws, and nothing here is a security boundary.** A refusal is a message to render, and
 * the server's `requireEntitlement()` is the gate; these exist so a user is sent to the paywall rather than
 * shown a 403.
 *
 * **A failed read is not an answer, and each hook says so in the way its caller needs.** `useEntitlement`
 * is a lock, so it fails closed — `entitled` stays false — and reports `readFailure` beside it so a screen
 * can tell "you don't have Pro" from "we couldn't check". `useSubscription` *names the plan*, where failing
 * closed would be a lie: an empty entitlement list is a positive claim that the account is on the free
 * floor, so it reports the failure instead of rendering one.
 */

/**
 * Hold the newest value without making it a dependency.
 *
 * Every hook below takes an options object, and a caller writing `useEntitlement("pro", { basePath })` inline
 * creates a new object every render. So each read is keyed on the one thing that can actually change the
 * request — `basePath`, a string — and reads the rest through this.
 */
function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** A refusal carried as a thrown failure through `useRead` and `useAction`, so the last answer survives it. */
class Refused extends Error {
  constructor(readonly failure: PaymentsFailure) {
    super(failure.message);
  }
}

/** The value of a result, or its refusal thrown as {@link Refused}. */
function unwrap<T>(result: PaymentsResult<T>): T {
  if (result.ok) return result.value;
  throw new Refused(result.failure);
}

/** The refusal behind a failure. The calls here resolve rather than throw, so anything else is unreadable. */
function refusalOf(failure: Error | null): PaymentsFailure | null {
  if (failure === null) return null;
  return failure instanceof Refused ? failure.failure : PAYMENTS_UNREADABLE;
}

/** What {@link useEntitlement} gives a screen. */
export interface UseEntitlement {
  /** Whether the caller holds the key right now. `false` while loading — a paywall fails closed. */
  entitled: boolean;
  /** Whether the first read is still in flight. */
  loading: boolean;
  /**
   * Why the last read could not be made, or null.
   *
   * Distinct from `entitled: false`, which is an answer. This is the absence of one, and a screen that
   * says "you don't have Pro" and one that says "we couldn't check" are different screens. `entitled`
   * still fails closed while this is set — the lock holds, it just admits it is guessing.
   */
  readFailure: PaymentsFailure | null;
  /** Re-read. Call it after a purchase completes. */
  refresh: () => void;
}

/**
 * Whether the caller holds `key`.
 *
 * Starts `false`, always. Starting `true` would flash the paid screen to everyone for one frame, which is
 * both a leak and worse to look at than a spinner. An unreachable Worker reads as not entitled for the
 * same reason: the server check is the boundary, so failing closed here costs nothing.
 *
 * The failing-closed happens *here*, visibly, rather than inside {@link getEntitlements} — a lock is a
 * refusal and can carry an escape route on it, which is what `readFailure` is. A caller that names the
 * plan instead of locking it must not inherit this choice; see {@link useSubscription}.
 */
export function useEntitlement(key: string, options?: PaymentsClientOptions): UseEntitlement {
  const latest = useLatest(options);
  const basePath = options?.basePath;
  // The result itself is the value, so a failed read replaces the last answer: a lock fails closed on it.
  const read = useRead(`entitlements:${basePath ?? ""}`, () => getEntitlements({ ...latest.current, basePath }));
  const result = read.value;
  return {
    entitled: result?.ok === true && result.value.some((entitlement) => entitlement.key === key && entitlement.granted),
    loading: read.loading,
    readFailure: result?.ok === false ? result.failure : refusalOf(read.failure),
    refresh: read.refresh,
  };
}

/** What {@link useAllowances} gives a paywall screen. */
export interface UseAllowances {
  /** The caller's resolved quotas and features, or null until a read has landed. Never guessed. */
  allowances: AllowancesView | null;
  /** Whether a read is in flight. */
  loading: boolean;
  /** Why the last read could not be made, or null. `allowances` keeps its last answer while this is set. */
  readFailure: PaymentsFailure | null;
  /** Re-read. Call it after a purchase or an upgrade completes. */
  refresh: () => void;
}

/**
 * What the caller's holder may have — "3 of 10 seats", "SSO included" — for a screen to show.
 *
 * **Null until it knows, never zero.** A paywall that rendered `0 of 0` from a read still in flight would tell
 * a paying customer they have nothing. And it is a UX affordance, never a boundary: the server's `quota()` and
 * the kit's meters are what refuse.
 */
export function useAllowances(options?: PaymentsClientOptions): UseAllowances {
  const latest = useLatest(options);
  const basePath = options?.basePath;
  const read = useRead(`allowances:${basePath ?? ""}`, async () =>
    unwrap(await getAllowances({ ...latest.current, basePath })),
  );
  return {
    allowances: read.value ?? null,
    loading: read.loading,
    readFailure: refusalOf(read.failure),
    refresh: read.refresh,
  };
}

/** What {@link useSubscription} gives a subscription screen. */
export interface UseSubscription {
  /** Every entitlement the caller holds, as the server resolved it. */
  entitlements: readonly EntitlementView[];
  /** Whether any entitlement grants right now — the "is this account paid" answer, without naming a key. */
  subscribed: boolean;
  /** Whether the read is in flight. */
  loading: boolean;
  /** Re-read. */
  refresh: () => void;
  /** Open Stripe's Billing Portal for this caller. Resolves once the browser has been sent, or refused. */
  manage: () => Promise<void>;
  /** Send the visitor to a store's own subscription page — the only management a web page can offer there. */
  manageStore: (rail: "apple" | "google") => void;
  /** Whether a portal session is being created. */
  managing: boolean;
  /** The last refusal of something the subscriber *asked for* — opening the portal — or null. */
  failure: PaymentsFailure | null;
  /**
   * Why the entitlements could not be read, or null. Kept apart from `failure` deliberately.
   *
   * This screen names the plan, and free is the floor of every ladder: an empty `entitlements` is a
   * positive claim that the account is on the cheapest tier. Rendering that from a read that never
   * happened tells a paying customer they are on Free and offers to sell them what they have. So a
   * failed read leaves `entitlements` empty *and* says so here, and a screen must consult this before
   * it renders a tier name. Collapsing it into `failure` would let a stale portal refusal mask it.
   */
  readFailure: PaymentsFailure | null;
}

const NO_ENTITLEMENTS: readonly EntitlementView[] = [];

/**
 * The caller's standing entitlements, and the one action a subscriber needs.
 *
 * Managing a subscription is the store's job, not Pithy's — Stripe's Billing Portal owns cancellation,
 * card changes and plan moves, under Stripe's own rules and its own compliance. Apple and Google
 * subscriptions are managed in their own apps, which a web screen can only link to.
 */
export function useSubscription(options?: PaymentsClientOptions): UseSubscription {
  const latest = useLatest(options);
  const basePath = options?.basePath;
  // A refusal leaves the previous list alone rather than blanking it. What a screen must not do is read the
  // untouched list as this account's current plan, which is what `readFailure` is there to stop.
  const read = useRead(`subscription:${basePath ?? ""}`, async () =>
    unwrap(await getEntitlements({ ...latest.current, basePath })),
  );
  const portal = useAction(async () => {
    const refused = await openBillingPortal(latest.current);
    if (refused) throw new Refused(refused);
  });
  const run = portal.run;
  const manage = useCallback(async () => {
    await run();
  }, [run]);

  const manageStore = useCallback(
    (rail: "apple" | "google") => {
      // Synchronous, and it can only fail by there being no browser — nothing to await and nothing to
      // report that a screen could act on.
      openStoreSubscriptions(rail, latest.current);
    },
    [latest],
  );

  const entitlements = read.value ?? NO_ENTITLEMENTS;
  return {
    entitlements,
    subscribed: entitlements.some((entitlement) => entitlement.granted),
    loading: read.loading,
    refresh: read.refresh,
    manage,
    manageStore,
    managing: portal.pending,
    failure: refusalOf(portal.failure),
    readFailure: refusalOf(read.failure),
  };
}

/** What {@link useCheckout} gives a paywall's buy button. */
export interface UseCheckout {
  /**
   * Start checkout for a product.
   *
   * `rail` is only needed for a product sold on **more than one** hosted rail, where the server refuses to
   * choose on the buyer's behalf. A product sold on one needs no argument.
   */
  start: (productId: string, options?: { rail?: PaymentsHostedRail; discountCode?: string }) => Promise<void>;
  /** Whether a session is being created. Disable the button on it — a double click is a double session. */
  starting: boolean;
  /** The last refusal, or null. Cleared at the start of every attempt. */
  failure: PaymentsFailure | null;
  /**
   * The handoff to open with Paddle.js, or null — set only on a rail with nowhere to navigate to.
   *
   * Null on a redirect rail, because the browser has already left and there is nothing for a screen to
   * hold. Pass it to {@link usePaddleCheckout}, which opens it; a screen that never composes Paddle reads
   * null forever and never needs to read it.
   */
  handoff: PaddleCheckoutHandoff | null;
}

/**
 * The web purchase path: start a checkout, and go wherever that rail goes.
 *
 * Apple and Google purchases happen inside a store SDK before any server hears of them, so there is no
 * session for Pithy to create and no browser flow to start — a web paywall lists those products, it does
 * not sell them. Stripe's and Lemon Squeezy's hosted checkouts need no SDK script and no publishable key
 * in the page: the server mints a session, this navigates to it, and the store owns everything in between.
 *
 * Paddle is the one that does not leave. This hook does the same work for it — the server call, the
 * refusal — and stops at the handoff, because opening it belongs where the container is. That is
 * {@link usePaddleCheckout}.
 */
export function useCheckout(options?: PaymentsClientOptions): UseCheckout {
  const latest = useLatest(options);
  const checkout = useAction(
    async (_signal, productId: string, choices?: { rail?: PaymentsHostedRail; discountCode?: string }) => {
      const outcome = await startCheckout(
        { productId, rail: choices?.rail, discountCode: choices?.discountCode },
        latest.current,
      );
      // Exhaustive on `kind` rather than truthiness. `left` is the browser already going; `paddle` is the
      // one outcome a screen must act on; `refused` is the only one that is a failure. Reading any of the
      // three as another is how a buyer ends up on a page whose button did nothing.
      if (outcome.kind === "refused") throw new Refused(outcome.failure);
      return outcome.kind === "paddle" ? outcome.handoff : null;
    },
  );
  const run = checkout.run;
  const start = useCallback(
    async (productId: string, choices?: { rail?: PaymentsHostedRail; discountCode?: string }) => {
      await run(productId, choices);
    },
    [run],
  );

  return {
    start,
    starting: checkout.pending,
    failure: refusalOf(checkout.failure),
    // Each attempt mints a new transaction, so the last one's handoff is nobody's while the next is out.
    handoff: checkout.pending || checkout.failure !== null ? null : (checkout.value ?? null),
  };
}

/** What {@link usePaddleCheckout} gives the screen that composes Paddle. */
export interface UsePaddleCheckout {
  /**
   * Whether this handoff needs a container on the page.
   *
   * Read it to render one, and render it unconditionally beside the button rather than deciding for
   * yourself: the mode is `paddle.checkout` in the project's config, resolved by the server, so a project
   * that switches from `overlay` to `inline` must not also have to edit a screen it was given a year ago.
   */
  inline: boolean;
  /** Whether the checkout is being opened — the script may still be loading. */
  opening: boolean;
  /** Why it could not be opened, or null. */
  failure: PaymentsFailure | null;
}

/**
 * Open the handoff {@link useCheckout} produced, with Paddle.js, over this page or inside it.
 *
 * **After the render that revealed the container, which is why this is a hook rather than a line in a click
 * handler.** Inline checkout renders into an element the screen provides, and Paddle finds it by class name at
 * the moment `open` is called. Called from the handler that starts the checkout, the container React is about
 * to render does not exist yet — and what Paddle does then is throw `TypeError: Cannot read properties of
 * undefined (reading 'appendChild')` out of the click, which is not a sentence anyone can act on. A read runs
 * after the commit, so the element is there.
 *
 * One open per handoff, keyed on its transaction id and run once per key, so a re-render, a second mount under
 * `StrictMode` (the mode `pithy ui add` scaffolds) and an inline handoff object all open one checkout. A buyer who
 * closed the overlay and clicked Buy again arrives with a new transaction, and that one opens.
 */
export function usePaddleCheckout(
  handoff: PaddleCheckoutHandoff | null,
  options?: PaddleCheckoutOptions,
): UsePaddleCheckout {
  const latest = useLatest(options);
  const latestHandoff = useLatest(handoff);
  const transactionId = handoff?.transactionId;
  const opened = useRead(
    `paddle-open:${transactionId ?? ""}`,
    async () => {
      const current = latestHandoff.current;
      return current === null ? null : openPaddleCheckout(current, latest.current);
    },
    { skip: transactionId === undefined, once: true },
  );

  return {
    inline: handoff?.displayMode === "inline",
    opening: opened.loading,
    failure: transactionId === undefined || opened.loading ? null : (opened.value ?? refusalOf(opened.failure)),
  };
}

/** What {@link usePaddleLink} gives the screen a Paddle payment link lands on. */
export interface UsePaddleLink {
  /**
   * The handoff to open, or null.
   *
   * Null covers three different facts and deliberately reads as one: there was no `_ptxn` in the URL, there
   * was one and it was not a transaction id, or the server has not answered yet. A screen renders its
   * ordinary state for all three.
   */
  handoff: PaddleCheckoutHandoff | null;
  /** Whether the resume read is in flight. A screen with nothing to show need not read it. */
  loading: boolean;
  /** The refusal, or null. A rail that is off, or a mode that cannot resume. */
  failure: PaymentsFailure | null;
}

/** The transaction a Paddle payment link put in this page's URL, or null — and null with no browser at all. */
function arrivedTransaction(): string | null {
  // Narrowly cast rather than read off a typed global, which is `checkout.ts`'s `documentOf` pattern and is
  // forced by the same thing: the build's tsconfig gives `globalThis` no DOM index signature, so
  // `globalThis.location` compiles under `typecheck` and fails the published build with TS7017.
  const search = (globalThis as { location?: { search?: string } }).location?.search;
  return search === undefined ? null : readPaddleLinkTransaction(search);
}

/**
 * Resume the checkout a Paddle payment link arrived for.
 *
 * **The inbound half of Paddle's *Default payment link*.** Paddle appends `?_ptxn=<transaction_id>` to it
 * and expects this page to open a checkout for that transaction. Those are the links Paddle sends rather
 * than ones this kit opened: a past-due dunning mail, a manually-collected invoice, the payment-method
 * update link minted for a subscription. `useCheckout` cannot serve them — it mints a transaction, and here
 * one already exists.
 *
 * **Pass the result to {@link usePaddleCheckout}, which opens it.** Nothing about opening is reimplemented
 * here, and that is the point: the one-open-per-transaction rule and the `PADDLE_NO_CONTAINER` refusal when
 * an inline container is missing are inherited by going through the same hook the minted path goes through.
 *
 * **In inline mode the page must already render the container.** Paddle finds it by class name when `open`
 * is called, so a Default payment link pointing at a page that does not render one produces a refusal
 * rather than a checkout — which makes the choice of landing page part of configuring this, not a detail.
 * `docs/paddle.md` says so where an adopter sets the link.
 *
 * Reads `location.search` once, on mount, and asks the server once per transaction, `StrictMode` included. A
 * link is a navigation, so there is no later arrival to watch for.
 */
export function usePaddleLink(options?: PaymentsClientOptions): UsePaddleLink {
  const latest = useLatest(options);
  const [transactionId] = useState(arrivedTransaction);
  const resumed = useRead(
    `paddle-link:${transactionId ?? ""}`,
    async () => (transactionId === null ? null : unwrap(await resumeCheckout(transactionId, latest.current))),
    { skip: transactionId === null, once: true },
  );

  return { handoff: resumed.value ?? null, loading: resumed.loading, failure: refusalOf(resumed.failure) };
}

/** What {@link usePurchase} gives the screen that submits receipts. */
export interface UsePurchase {
  /**
   * Submit one receipt for verification. Resolves `true` when the Worker accepted it: a native app finishes the
   * store's transaction only then, so a refused one stays with the store to be submitted again.
   */
  submit: (rail: PaymentsClientRail, receipt: string) => Promise<boolean>;
  /** Submit a store account's whole history on one rail — Restore Purchases. Resolves `true` when accepted. */
  restore: (rail: PaymentsClientRail, receipts: readonly string[]) => Promise<boolean>;
  /** The purchase the last successful submission projected, or null. */
  purchase: PurchaseView | null;
  /** The caller's entitlements as of the last successful write. */
  entitlements: readonly EntitlementView[];
  /** Whether a submission is in flight. */
  busy: boolean;
  /** The last refusal, or null. */
  failure: PaymentsFailure | null;
}

/**
 * Submitting receipts — the path that exists so a buyer sees their entitlement now rather than when the
 * webhook lands.
 *
 * On the web that is the Stripe return: the success URL carries the Checkout Session id, and posting it
 * here projects the purchase at once. On a native client it is the store SDK's transaction, and `restore`
 * is Restore Purchases. Dropping either call costs nothing — the webhook produces the identical row, and
 * the write is idempotent on `(rail, providerTransactionId)`.
 *
 * A refusal leaves `purchase` and `entitlements` exactly as they were. Clearing them would flicker a
 * paywall back over a feature the user already owns, on nothing more than a failed second submission.
 */
export function usePurchase(options?: PaymentsClientOptions): UsePurchase {
  const latest = useLatest(options);
  // One action for both calls, so the last success of either is what the screen shows.
  const write = useAction(
    async (
      _signal,
      call:
        | { kind: "submit"; rail: PaymentsClientRail; receipt: string }
        | {
            kind: "restore";
            rail: PaymentsClientRail;
            receipts: readonly string[];
          },
    ): Promise<{ purchase: PurchaseView | null; entitlements: readonly EntitlementView[] }> => {
      if (call.kind === "submit") {
        const written = unwrap(await submitPurchase({ rail: call.rail, receipt: call.receipt }, latest.current));
        return { purchase: written.purchase, entitlements: written.entitlements };
      }
      const restored = unwrap(await restorePurchases({ rail: call.rail, receipts: call.receipts }, latest.current));
      return { purchase: restored.purchases[0] ?? null, entitlements: restored.entitlements };
    },
  );
  const run = write.run;
  const submit = useCallback(
    async (rail: PaymentsClientRail, receipt: string) => (await run({ kind: "submit", rail, receipt })) !== undefined,
    [run],
  );
  const restore = useCallback(
    async (rail: PaymentsClientRail, receipts: readonly string[]) =>
      (await run({ kind: "restore", rail, receipts })) !== undefined,
    [run],
  );

  return {
    submit,
    restore,
    purchase: write.value?.purchase ?? null,
    entitlements: write.value?.entitlements ?? NO_ENTITLEMENTS,
    busy: write.pending,
    failure: refusalOf(write.failure),
  };
}

/** What {@link usePaddle} gives a screen that has to talk to Paddle.js directly. */
export interface UsePaddle {
  /** The initialized Paddle.js, or null while it loads and after it fails. */
  paddle: PaddleJs | null;
  /** Whether the load is in flight. False forever when there is no Paddle rail to load. */
  loading: boolean;
  /** Why it could not load, or null. */
  failure: PaymentsFailure | null;
}

/**
 * Paddle.js, loaded once per page.
 *
 * `setup` takes null so a screen never has to guard a hook: `paymentsConfig.paddle` is null when the
 * rail is off, and passing that through reads as "nothing to load" rather than as a failure. A pricing
 * page for a project that does not sell through Paddle renders its own empty state; it does not show an
 * error about a provider it never asked for.
 *
 * Loading is the module's job, not this hook's — mounting two components that both call it produces one
 * script and one `Initialize`, because {@link loadPaddle} remembers the page's one load. This is the
 * React-shaped view of it: a state a screen can render.
 */
export function usePaddle(setup: PaddleSetup | null, options?: PaddleOptions): UsePaddle {
  const latest = useLatest(options);
  // The two fields, not the object: a screen writing an object literal must not restart the load every render.
  const clientToken = setup?.clientToken;
  const environment = setup?.environment;
  const loaded = useRead(
    `paddle:${environment ?? ""}:${clientToken ?? ""}`,
    () =>
      clientToken === undefined || environment === undefined
        ? Promise.resolve(null)
        : loadPaddle({ clientToken, environment }, latest.current),
    { skip: clientToken === undefined || environment === undefined },
  );
  const result = loaded.value;

  return {
    paddle: result?.ok === true ? result.value : null,
    loading: loaded.loading,
    failure: result?.ok === false ? result.failure : refusalOf(loaded.failure),
  };
}

/** What {@link usePricePreview} gives a pricing screen. */
export interface UsePricePreview {
  /**
   * What Paddle quoted this visitor, or null.
   *
   * Null while the first quote is in flight and null after a failure — **never a fallback figure.** A
   * hardcoded price behind a failed lookup is the exact defect this hook exists to remove: it is wrong
   * in every country whose tax convention differs from the one it was written in, and it is wrong
   * silently. A page with no price and an honest sentence is worse than a right price and better than a
   * wrong one.
   */
  preview: PricePreview | null;
  /** Whether a quote is in flight. True on the first render, so a screen can hold the space. */
  loading: boolean;
  /** Why the last quote could not be made, or null. */
  failure: PaymentsFailure | null;
  /** Ask again. */
  refresh: () => void;
}

/**
 * What this visitor pays, read from Paddle for this visitor.
 *
 * **No price string appears in any screen this kit ships.** That is the whole contract. The figures come
 * from Paddle, rendered by Paddle for the visitor's country — which is the only way one page can quote
 * $5.44 in New York, $5.75 in Chicago, $5.00 in Berlin including €0.80 of VAT, and ¥725 in Tokyo without
 * a table of tax rates aging in somebody's repository.
 *
 * `query` may be written inline. The read is keyed on {@link priceQueryKey} rather than on the object, so an
 * object literal re-created on every render re-quotes when the request changed and not before.
 *
 * A failure clears the previous quote rather than leaving it, because a re-quote happens when the *request*
 * changed, so the value it would be keeping is a price for something else.
 *
 * **Only the latest quote is rendered, whichever answers first.** A slower quote for an address the visitor
 * has left — an anonymous visitor's location resolving under the query, or a country picker moving — is
 * discarded rather than rendered, and so is a superseded refusal.
 */
export function usePricePreview(
  setup: PaddleSetup | null,
  query: PaddlePriceQuery,
  options?: PaddleOptions,
): UsePricePreview {
  const latest = useLatest(options);
  const latestQuery = useLatest(query);
  const clientToken = setup?.clientToken;
  const environment = setup?.environment;
  const quoted = useRead(
    `price:${environment ?? ""}:${clientToken ?? ""}:${priceQueryKey(query)}`,
    () =>
      clientToken === undefined || environment === undefined
        ? Promise.resolve(null)
        : previewPrices({ clientToken, environment }, latestQuery.current, latest.current),
    { skip: clientToken === undefined || environment === undefined },
  );
  const result = quoted.value;

  return {
    preview: result?.ok === true ? result.value : null,
    loading: quoted.loading,
    failure: result?.ok === false ? result.failure : refusalOf(quoted.failure),
    refresh: quoted.refresh,
  };
}
