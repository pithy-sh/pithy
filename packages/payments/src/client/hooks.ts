// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type EntitlementView,
  getEntitlements,
  openBillingPortal,
  openStoreSubscriptions,
  type PaddleCheckoutHandoff,
  type PaymentsClientOptions,
  type PaymentsClientRail,
  type PaymentsFailure,
  type PaymentsHostedRail,
  type PurchaseView,
  restorePurchases,
  startCheckout,
  submitPurchase,
} from "./api";

/**
 * The headless client surface: four hooks a paywall, a subscription screen, and a route guard are built
 * out of.
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
 * Cookie/session throughout, because `./api` is: same-origin, `credentials: "include"`, no token in web
 * storage, no bearer header. Bearer stays the mobile path.
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
 * Every hook below takes an options object, and a caller writing `useEntitlement("pro", { basePath })`
 * inline creates a new object every render. Depending on it would re-run the effect forever. So the
 * effects depend on the one thing that can actually change the request — `basePath`, a string — and read
 * the rest through this.
 */
function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Whether a component is still mounted. Every async completion checks it before setting state. */
function useLive(): { current: boolean } {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return live;
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
  const [entitled, setEntitled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readFailure, setReadFailure] = useState<PaymentsFailure | null>(null);
  const latest = useLatest(options);
  const live = useLive();
  const basePath = options?.basePath;

  const refresh = useCallback(() => {
    setLoading(true);
    // `basePath` is read here rather than off the ref, so it is a real dependency: it is the one option
    // that changes the request, and a project that moved its routes must re-read. Everything else comes
    // through the ref, which is why an inline options object does not restart this on every render.
    void getEntitlements({ ...latest.current, basePath }).then((result) => {
      if (!live.current) return;
      // Fail closed on the answer, report the failure beside it. Both, not either.
      setEntitled(result.ok && result.value.some((entitlement) => entitlement.key === key && entitlement.granted));
      setReadFailure(result.ok ? null : result.failure);
      setLoading(false);
    });
  }, [key, basePath, latest, live]);

  useEffect(refresh, [refresh]);

  return { entitled, loading, readFailure, refresh };
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

/**
 * The caller's standing entitlements, and the one action a subscriber needs.
 *
 * Managing a subscription is the store's job, not Pithy's — Stripe's Billing Portal owns cancellation,
 * card changes and plan moves, under Stripe's own rules and its own compliance. Apple and Google
 * subscriptions are managed in their own apps, which a web screen can only link to.
 */
export function useSubscription(options?: PaymentsClientOptions): UseSubscription {
  const [entitlements, setEntitlements] = useState<readonly EntitlementView[]>([]);
  const [loading, setLoading] = useState(true);
  const [managing, setManaging] = useState(false);
  const [failure, setFailure] = useState<PaymentsFailure | null>(null);
  const [readFailure, setReadFailure] = useState<PaymentsFailure | null>(null);
  const latest = useLatest(options);
  const live = useLive();
  const basePath = options?.basePath;

  const refresh = useCallback(() => {
    setLoading(true);
    // `basePath` explicitly, for the reason `useEntitlement` gives: it is the option that changes the
    // request, so it has to be a dependency rather than something read off a ref.
    void getEntitlements({ ...latest.current, basePath }).then((result) => {
      if (!live.current) return;
      // A refusal leaves the previous list alone rather than blanking it — the same rule `usePurchase`
      // follows. What a screen must not do is read the untouched list as this account's current plan,
      // which is what `readFailure` is there to stop.
      if (result.ok) setEntitlements(result.value);
      setReadFailure(result.ok ? null : result.failure);
      setLoading(false);
    });
  }, [basePath, latest, live]);

  useEffect(refresh, [refresh]);

  const manage = useCallback(async () => {
    setManaging(true);
    setFailure(null);
    const refused = await openBillingPortal(latest.current);
    if (!live.current) return;
    setManaging(false);
    // On success the browser is already leaving; setting state is harmless and keeps the two paths one shape.
    if (refused) setFailure(refused);
  }, [latest, live]);

  const manageStore = useCallback(
    (rail: "apple" | "google") => {
      // Synchronous, and it can only fail by there being no browser — nothing to await and nothing to
      // report that a screen could act on.
      openStoreSubscriptions(rail, latest.current);
    },
    [latest],
  );

  return {
    entitlements,
    subscribed: entitlements.some((entitlement) => entitlement.granted),
    loading,
    refresh,
    manage,
    manageStore,
    managing,
    failure,
    readFailure,
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
   * hold. A screen composing Paddle watches this and opens the checkout; a screen that never composes it
   * reads null forever and renders exactly as it did before this field existed.
   */
  handoff: PaddleCheckoutHandoff | null;
}

/**
 * The web purchase path, which is Stripe's alone.
 *
 * Apple and Google purchases happen inside a store SDK before any server hears of them, so there is no
 * session for Pithy to create and no browser flow to start — a web paywall lists those products, it does
 * not sell them. Hosted Checkout needs no SDK script and no publishable key in the page: the server mints
 * a session, this navigates to it, and Stripe owns everything in between.
 */
export function useCheckout(options?: PaymentsClientOptions): UseCheckout {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<PaymentsFailure | null>(null);
  const [handoff, setHandoff] = useState<PaddleCheckoutHandoff | null>(null);
  const latest = useLatest(options);
  const live = useLive();

  const start = useCallback(
    async (productId: string, choices?: { rail?: PaymentsHostedRail; discountCode?: string }) => {
      setStarting(true);
      setFailure(null);
      setHandoff(null);
      const outcome = await startCheckout(
        { productId, rail: choices?.rail, discountCode: choices?.discountCode },
        latest.current,
      );
      if (!live.current) return;
      setStarting(false);
      // Exhaustive on `kind` rather than truthiness. `left` is the browser already going; `paddle` is the
      // one outcome a screen must act on; `refused` is the only one that is a failure. Reading any of the
      // three as another is how a buyer ends up on a page whose button did nothing.
      if (outcome.kind === "refused") setFailure(outcome.failure);
      else if (outcome.kind === "paddle") setHandoff(outcome.handoff);
    },
    [latest, live],
  );

  return { start, starting, failure, handoff };
}

/** What {@link usePurchase} gives the screen that submits receipts. */
export interface UsePurchase {
  /** Submit one receipt for verification. */
  submit: (rail: PaymentsClientRail, receipt: string) => Promise<void>;
  /** Submit a store account's whole history on one rail — Restore Purchases. */
  restore: (rail: PaymentsClientRail, receipts: readonly string[]) => Promise<void>;
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
  const [purchase, setPurchase] = useState<PurchaseView | null>(null);
  const [entitlements, setEntitlements] = useState<readonly EntitlementView[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PaymentsFailure | null>(null);
  const latest = useLatest(options);
  const live = useLive();

  const submit = useCallback(
    async (rail: PaymentsClientRail, receipt: string) => {
      setBusy(true);
      setFailure(null);
      const result = await submitPurchase({ rail, receipt }, latest.current);
      if (!live.current) return;
      setBusy(false);
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      setPurchase(result.value.purchase);
      setEntitlements(result.value.entitlements);
    },
    [latest, live],
  );

  const restore = useCallback(
    async (rail: PaymentsClientRail, receipts: readonly string[]) => {
      setBusy(true);
      setFailure(null);
      const result = await restorePurchases({ rail, receipts }, latest.current);
      if (!live.current) return;
      setBusy(false);
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      setPurchase(result.value.purchases[0] ?? null);
      setEntitlements(result.value.entitlements);
    },
    [latest, live],
  );

  return { submit, restore, purchase, entitlements, busy, failure };
}
