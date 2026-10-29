import { getSession } from "@pithy-sh/auth/src/client/api";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import {
  type EntitlementView,
  getEntitlements,
  PAYMENTS_UNREADABLE,
  type PaymentsClientOptions,
  type PaymentsFailure,
  restorePurchases,
  submitPurchase,
} from "@pithy-sh/payments/src/client/api";
import type { PaymentsClientProduct } from "@pithy-sh/payments/src/client/projection";
import { type PaymentsPurchasePath, purchasePathFor } from "@pithy-sh/payments/src/client/railChoice";
import type { PriceVisitor } from "@pithy-sh/payments/src/pricing/location";
import { fetchPriceVisitor, type PriceVisitorOptions } from "@pithy-sh/payments/src/pricing/visitor";
import { useAction } from "@pithy-sh/ui-core/src/action";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { randomUUID } from "expo-crypto";
import type { Purchase, RequestPurchaseProps } from "expo-iap";
import { useCallback, useRef } from "react";
import { loadStore, type StoreModule } from "./payments-store";
import { authConfig, paymentsConfig, platformRails } from "./pithy-config";
import { devicePlatform, onDevice, openExternal } from "./platform";
import { type PinnedCredential, secureStore, transport } from "./transport";

/**
 * The bridge between the narrowed projection and `@pithy-sh/payments`' client. Everything the purchase flow does
 * on the wire lives in that package and upgrades with it; this file binds it to this app.
 */

/**
 * Where the payments routes are and how to reach them, bound once. On a phone the calls carry the bearer
 * credential to the Worker's origin, and a hosted page (a checkout, the billing portal) opens in the system
 * browser; on the web they ride the page's cookie and the page itself leaves for the hosted page.
 */
export const paymentsClient: PaymentsClientOptions = {
  basePath: paymentsConfig.basePath,
  ...transport.capability,
  ...(onDevice()
    ? {
        navigate: (url: string) => {
          void openExternal(url);
        },
      }
    : {}),
};

/** What Paddle.js starts with on the web, or null when this project has no Paddle rail. */
export const paddleSetup = paymentsConfig.paddle;

/**
 * How to sell `product` on this platform: in the app through the platform's store, on a hosted page, not at all
 * (`none`), or `unavailable` here. From the rail `pithy-config.generated.ts` names for this platform and the rails
 * the Worker has on.
 */
export function purchasePath(product: Pick<PaymentsClientProduct, "skus">): PaymentsPurchasePath {
  return purchasePathFor({ platform: devicePlatform(), rails: platformRails, enabled: paymentsConfig.rails, product });
}

/**
 * What a refusal reads as, in the reader's language: the catalog's sentence for the code when there is one, the
 * Worker's own words otherwise.
 */
export function failureText(t: Translator, failure: PaymentsFailure): string {
  return t.maybe(failure.code, failure.params) ?? failure.message;
}

/**
 * Whether the visitor holds `key` right now. `true` when payments is not composed, so a guard cannot lock a screen
 * shut; `false` when the read fails, because a guard fails shut. A courtesy, never the boundary.
 */
export async function holdsEntitlement(key: string): Promise<boolean> {
  if (!paymentsConfig.enabled) return true;
  const held = await getEntitlements(paymentsClient);
  return held.ok && held.value.some((entitlement) => entitlement.key === key && entitlement.granted);
}

/** Who Paddle prices this visitor as, once there is a session to ask about. Null quotes from the IP estimate. */
export function usePriceVisitor(ask: boolean, options: PriceVisitorOptions = paymentsClient): PriceVisitor | null {
  return (
    useRead("price-visitor", () => fetchPriceVisitor(options), { skip: !ask || !paymentsConfig.enabled }).value ?? null
  );
}

/** The secure-store key one user's account token is kept under. Every character outside `[A-Za-z0-9.]` is escaped. */
function accountTokenKey(userId: string): string {
  let escaped = "";
  for (const char of userId) {
    escaped += /[A-Za-z0-9.]/.test(char) ? char : `_${char.codePointAt(0)?.toString(16)}_`;
  }
  return `pithy.payments.account.${escaped}`;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The secure-store key the account tokens minted on this device are listed under, whoever they belong to. */
const KNOWN_TOKENS_KEY = "pithy.payments.accounts";

/** The account tokens minted on this install, lowercased. Rejects when the store cannot answer or the list is unreadable. */
async function readKnownTokens(): Promise<Set<string>> {
  const listed: unknown = JSON.parse((await secureStore.getItem(KNOWN_TOKENS_KEY)) ?? "[]");
  if (!Array.isArray(listed)) throw new Error("The account token list is unreadable.");
  return new Set(
    listed.filter((token): token is string => typeof token === "string").map((token) => token.toLowerCase()),
  );
}

/** The account tokens minted on this install, lowercased, or `null` when the store cannot say. */
async function knownAccountTokens(): Promise<ReadonlySet<string> | null> {
  try {
    return await readKnownTokens();
  } catch {
    return null;
  }
}

/** List `token` as one this install minted, unless it is already. A list that cannot be read is never rewritten. */
async function listKnownToken(token: string): Promise<void> {
  const known = await readKnownTokens();
  if (known.has(token.toLowerCase())) return;
  known.add(token.toLowerCase());
  await secureStore.setItem(KNOWN_TOKENS_KEY, JSON.stringify([...known]));
}

/**
 * The token a store purchase is tagged with for this user on this device: Apple's `appAccountToken`, Google's
 * `obfuscatedAccountId`. A random UUID, minted once per user and device and kept in the secure store, never derived
 * from the user id: the Worker links a store account to whoever presents it first, so a guessable token would let
 * somebody claim another's purchases.
 *
 * `null` on the web, which buys on a hosted page, and when the store cannot keep a new token: a purchase tagged
 * with a token this device will not remember could not be restored to this account.
 */
export async function accountToken(userId: string): Promise<string | null> {
  if (!onDevice()) return null;
  const key = accountTokenKey(userId);
  try {
    const stored = await secureStore.getItem(key);
    if (stored !== null && UUID_V4.test(stored)) {
      // A token missing from the list, such as one whose listing a concurrent mint overwrote, is listed again.
      await listKnownToken(stored).catch(() => undefined);
      return stored;
    }
    const minted = randomUUID();
    await listKnownToken(minted);
    await secureStore.setItem(key, minted);
    return minted;
  } catch {
    return null;
  }
}

/**
 * The same client, with a hosted page's return reported: on a phone `onReturn` runs once the system browser is
 * closed, so a screen reads the subscription again the moment the reader is back. iOS shows the page over the app
 * and the app never leaves the foreground, so this is the only signal there; on Android the browser is its own app
 * and the return to the foreground signals it as well. On the web the page itself leaves, and nothing returns.
 */
export function returningClient(onReturn: () => void): PaymentsClientOptions {
  if (!onDevice()) return paymentsClient;
  return {
    ...paymentsClient,
    navigate: (url: string) => {
      void openExternal(url).then(onReturn);
    },
  };
}

/** Whether `entitlements` grants every key `product` carries: the purchase a reader went to make has landed. */
export function grantsProduct(
  product: Pick<PaymentsClientProduct, "entitlements">,
  entitlements: readonly EntitlementView[],
): boolean {
  return (
    product.entitlements.length > 0 &&
    product.entitlements.every((key) => entitlements.some((held) => held.key === key && held.granted))
  );
}

/**
 * A Paddle checkout that opens over a page, which an app cannot draw: the Worker answered with a transaction for
 * Paddle.js rather than a page to go to. Paddle's hosted mode answers with the page.
 */
export const PADDLE_IN_PAGE: PaymentsFailure = {
  code: "payments/checkout.in_page",
  message: "This checkout opens inside a web page, which the app can't show.",
  action: 'Set `paddle.checkout: "hosted"` in pithy.config.ts, so Paddle answers with a checkout page.',
};

/** The store could not be reached, or could not answer: no connection to StoreKit or Play Billing. */
export const STORE_UNAVAILABLE: PaymentsFailure = {
  code: "payments/store.unavailable",
  message: "The store didn't answer. Try again in a moment.",
  action: null,
};

/**
 * The store had not answered a purchase by the deadline. It may still go through: one that does lands on the
 * account without the reader doing anything again.
 */
export const STORE_NO_ANSWER: PaymentsFailure = {
  code: "payments/store.no_answer",
  message: "The store hasn't answered. If the purchase goes through, it lands on your account on its own.",
  action: null,
};

/** The store ended the purchase with an error other than the reader closing its sheet. */
export const STORE_REFUSED: PaymentsFailure = {
  code: "payments/store.refused",
  message: "The store didn't finish the purchase.",
  action: null,
};

/** No account token could be kept on this device, so a purchase could not be tagged as this account's. */
export const STORE_NO_TOKEN: PaymentsFailure = {
  code: "payments/store.no_token",
  message: "This device couldn't keep what tags a purchase as yours, so nothing was bought.",
  action: null,
};

/** Nobody is signed in, and a purchase attaches to an account. */
export const STORE_SIGNED_OUT: PaymentsFailure = {
  code: "payments/store.signed_out",
  message: "Sign in before you buy.",
  action: null,
};

/** A product the store sells: its id there and the kind of thing it is. */
export interface StoreItem {
  /** The App Store or Play product id. */
  readonly sku: string;
  /** The product's kind in the catalog. A subscription is asked for as one; everything else is a one-time item. */
  readonly type: PaymentsClientProduct["type"];
}

/** What the store says about one of its products. */
export interface StoreListing {
  /** The price as the store renders it for this reader's storefront, currency and tax included. */
  readonly displayPrice: string;
  /** The Play offer a subscription is bought under, or null. */
  readonly offerToken: string | null;
}

/** The store's own name for a product's kind. */
function storeType(type: PaymentsClientProduct["type"]): "subs" | "in-app" {
  return type === "subscription" ? "subs" : "in-app";
}

let connection: Promise<StoreModule | null> | null = null;

/**
 * The store, with its connection open: once per launch, and `null` where there is no store to reach (the web) or
 * it refused the connection. A failed attempt is forgotten, so the next one tries again.
 */
function connectStore(): Promise<StoreModule | null> {
  connection ??= (async () => {
    const store = await loadStore();
    if (store !== null) {
      try {
        if (await store.initConnection()) return store;
      } catch {
        // Refused below, like a connection the store declined.
      }
    }
    connection = null;
    return null;
  })();
  return connection;
}

/**
 * The store's listing for each of `items`, by SKU. A product the store does not know is absent: that is a SKU
 * missing from App Store Connect or the Play Console, not a price to guess. Rejects when the store cannot answer.
 */
export async function readStoreListings(items: readonly StoreItem[]): Promise<ReadonlyMap<string, StoreListing>> {
  const store = await connectStore();
  if (store === null) throw new Error(STORE_UNAVAILABLE.message);
  const listings = new Map<string, StoreListing>();
  for (const type of ["in-app", "subs"] as const) {
    const skus = items.filter((item) => storeType(item.type) === type).map((item) => item.sku);
    if (skus.length === 0) continue;
    const answered = (await store.fetchProducts({ skus, type })) ?? [];
    for (const product of answered) {
      const offers = "subscriptionOffers" in product ? (product.subscriptionOffers ?? []) : [];
      listings.set(product.id, {
        displayPrice: product.displayPrice,
        offerToken: offers.find((offer) => offer.offerTokenAndroid)?.offerTokenAndroid ?? null,
      });
    }
  }
  return listings;
}

/**
 * The store's listings for `items`, read once per set of SKUs, and only on a phone: the web sells nothing through
 * a store. `null` while reading and when the store could not answer, which a screen renders as no price at all.
 */
export function useStoreListings(items: readonly StoreItem[]): {
  listings: ReadonlyMap<string, StoreListing> | null;
  loading: boolean;
} {
  const key = items.map((item) => `${item.type}:${item.sku}`).join(",");
  const read = useRead(`store-listings:${key}`, () => readStoreListings(items), {
    skip: items.length === 0 || !onDevice(),
  });
  return { listings: read.value ?? null, loading: read.loading };
}

/**
 * What a purchase is submitted to the Worker as: Apple's signed transaction, the JWS; Google's purchase as
 * `getOriginalJson()` returns it, verbatim, because the Worker reads the token and the product from it. `null` when
 * the store answered without one.
 */
export function storeReceipt(rail: "apple" | "google", purchase: Purchase): string | null {
  const receipt = rail === "apple" ? purchase.purchaseToken : "dataAndroid" in purchase ? purchase.dataAndroid : null;
  return typeof receipt === "string" && receipt !== "" ? receipt : null;
}

/** Whether the store product `sku` is a consumable in this project's catalog, which the store finishes by consuming. */
function consumableSku(rail: "apple" | "google", sku: string): boolean {
  return paymentsConfig.products.some((product) => product.skus[rail] === sku && product.type === "consumable");
}

/**
 * Finish a transaction the Worker has accepted. The purchase is on the account either way: a store that fails to
 * finish it hands it back on a later launch, and {@link watchStoreTransactions} submits it again, which the Worker
 * answers with the purchase it already holds.
 */
async function finishAccepted(purchase: Purchase, isConsumable: boolean): Promise<void> {
  const store = await connectStore();
  try {
    await store?.finishTransaction({ purchase, isConsumable });
  } catch {
    // Left with the store, which delivers it again.
  }
}

/**
 * The SKUs a screen is waiting on the store's answer for, and the transactions a screen took as its answer. The
 * store hands every purchase to every listener, so {@link watchStoreTransactions} leaves these to the screen.
 */
const awaitedSkus = new Map<string, number>();
const claimedTransactions = new Set<string>();

function awaitSku(sku: string): () => void {
  awaitedSkus.set(sku, (awaitedSkus.get(sku) ?? 0) + 1);
  return () => {
    const left = (awaitedSkus.get(sku) ?? 1) - 1;
    if (left === 0) awaitedSkus.delete(sku);
    else awaitedSkus.set(sku, left);
  };
}

/** How the store answered a purchase request. */
type StoreAnswer =
  | { kind: "bought"; purchase: Purchase }
  | { kind: "pending" }
  | { kind: "cancelled" }
  | { kind: "refused"; failure: PaymentsFailure };

/**
 * What a store error means for the purchase: the reader closed the sheet, the purchase waits on someone else (Ask
 * to Buy, a bank's check), which StoreKit reports as an error, or the store refused it.
 */
function storeErrorAnswer(store: StoreModule, error: unknown): StoreAnswer {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === store.ErrorCode.UserCancelled) return { kind: "cancelled" };
  if (code === store.ErrorCode.DeferredPayment) return { kind: "pending" };
  return { kind: "refused", failure: STORE_REFUSED };
}

/** The request StoreKit or Play Billing is asked to present, tagged with this account's token. */
function purchaseRequest(
  rail: "apple" | "google",
  item: StoreItem,
  token: string,
  offerToken: string | null,
): RequestPurchaseProps {
  const { sku } = item;
  if (storeType(item.type) === "subs") {
    return {
      type: "subs",
      request:
        rail === "apple"
          ? { apple: { sku, appAccountToken: token } }
          : {
              google: {
                skus: [sku],
                obfuscatedAccountId: token,
                ...(offerToken === null ? {} : { subscriptionOffers: [{ sku, offerToken }] }),
              },
            },
    };
  }
  return {
    type: "in-app",
    request:
      rail === "apple"
        ? { apple: { sku, appAccountToken: token } }
        : { google: { skus: [sku], obfuscatedAccountId: token } },
  };
}

/**
 * How long a purchase waits for the store's answer before the screen stops waiting: long enough for a reader to
 * get through the store's sheet, Face ID and a password included. A purchase that completes after it is still
 * submitted, by {@link watchStoreTransactions}.
 */
export const STORE_ANSWER_WITHIN = 180_000;

/**
 * Ask the store to sell `item`, and wait for its answer, for at most `answerWithin` ms. The answer arrives on the
 * store's listeners rather than as the request's result, so they are attached first and removed once this
 * product's answer is in, or the deadline passes.
 */
function askStore(
  rail: "apple" | "google",
  item: StoreItem,
  token: string,
  answerWithin: number,
): Promise<StoreAnswer> {
  const buyer = token.toLowerCase();
  return new Promise<StoreAnswer>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners: { remove: () => void }[] = [];
    const release = awaitSku(item.sku);
    const settle = (answer: StoreAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const listener of listeners) listener.remove();
      if (answer.kind === "bought") claimedTransactions.add(answer.purchase.id);
      release();
      resolve(answer);
    };
    timer = setTimeout(() => settle({ kind: "refused", failure: STORE_NO_ANSWER }), answerWithin);

    void (async () => {
      const store = await connectStore();
      if (settled) return;
      if (store === null) return settle({ kind: "refused", failure: STORE_UNAVAILABLE });
      let offerToken: string | null = null;
      if (rail === "google" && storeType(item.type) === "subs") {
        try {
          offerToken = (await readStoreListings([item])).get(item.sku)?.offerToken ?? null;
        } catch {
          return settle({ kind: "refused", failure: STORE_UNAVAILABLE });
        }
        if (settled) return;
      }
      listeners.push(
        store.purchaseUpdatedListener((purchase: Purchase) => {
          if (purchase.productId !== item.sku) return;
          // A transaction the store replays, or holds for another account, is never this buyer's answer: not a
          // purchase, and not a pending one either.
          if (purchaseAccountToken(rail, purchase) !== buyer) return;
          settle(purchase.purchaseState === "pending" ? { kind: "pending" } : { kind: "bought", purchase });
        }),
        store.purchaseErrorListener((error) => {
          if (error.productId && error.productId !== item.sku) return;
          settle(storeErrorAnswer(store, error));
        }),
      );
      store
        .requestPurchase(purchaseRequest(rail, item, token, offerToken))
        .catch((error: unknown) => settle(storeErrorAnswer(store, error)));
    })();
  });
}

/**
 * The store rail this app sells through on this device, or `null`: the web, a phone set to a web rail or `none`,
 * a store rail the Worker does not have on, and payments not composed all have no store to listen to.
 */
export function storeRailHere(): "apple" | "google" | null {
  if (!paymentsConfig.enabled) return null;
  const platform = devicePlatform();
  const own = platform === "ios" ? "apple" : platform === "android" ? "google" : null;
  if (own === null || platformRails[platform] !== own) return null;
  return paymentsConfig.rails[own] ? own : null;
}

/**
 * The account token `purchase` was tagged with when it was bought, lowercased, or `null` when it carries none.
 * StoreKit renders a UUID in capitals; the token this app mints is lowercase.
 */
function purchaseAccountToken(rail: "apple" | "google", purchase: Purchase): string | null {
  const token =
    rail === "apple"
      ? "appAccountToken" in purchase
        ? purchase.appAccountToken
        : null
      : "obfuscatedAccountIdAndroid" in purchase
        ? purchase.obfuscatedAccountIdAndroid
        : null;
  return typeof token === "string" && token !== "" ? token.toLowerCase() : null;
}

/**
 * Whether a purchase tagged `tagged` may go to the Worker for the user whose token here is `own`: their own token,
 * or a token this install never minted, which is theirs from an earlier install or another device. A token minted
 * here for another user is that user's, and stays with the store for them. When the list of tokens minted here
 * cannot be read (`known` is `null`), only their own token goes. The Worker's owner checks decide the rest.
 */
function taggedForOwner(tagged: string, own: string, known: ReadonlySet<string> | null): boolean {
  return tagged === own || (known !== null && !known.has(tagged));
}

/** The id of whoever `credential` belongs to, or `null` when nobody. */
async function credentialUserId(credential: PinnedCredential): Promise<string | null> {
  try {
    const session = await getSession(credential.auth);
    return session.ok ? (session.value?.user.id ?? null) : null;
  } catch {
    return null;
  }
}

/** The account token of whoever `credential` belongs to on this device, lowercased, or `null` when nobody. */
async function credentialAccountToken(credential: PinnedCredential): Promise<string | null> {
  const userId = await credentialUserId(credential);
  if (userId === null) return null;
  return (await accountToken(userId))?.toLowerCase() ?? null;
}

/**
 * The purchases the store still holds unfinished: StoreKit's pending transactions, Play's unacknowledged
 * purchases. Empty when the store cannot answer.
 */
async function unfinishedPurchases(rail: "apple" | "google", store: StoreModule): Promise<Purchase[]> {
  try {
    if (rail === "apple") return await store.getPendingTransactionsIOS();
    const held = await store.getAvailablePurchases();
    return held.filter((purchase) => "isAcknowledgedAndroid" in purchase && purchase.isAcknowledgedAndroid === false);
  } catch {
    return [];
  }
}

/**
 * Submit the purchases the store delivers while no screen is waiting on them, and finish each once the Worker has
 * accepted it: a purchase interrupted before it was finished, which the store hands back at launch; an Ask to Buy
 * request once it is approved; a subscription's renewal, which keeps the token it was first bought with. A purchase
 * the Worker refuses, or that could not reach it, stays with the store, which delivers it again.
 *
 * Only a purchase tagged for the signed-in user is submitted: with their account token on this device, or with a
 * token this install never minted, which is theirs from an earlier install or another device. One tagged for another
 * user of this device, or with no token, is left unfinished and untouched, so the store keeps it for the user it
 * belongs to; with nobody signed in, nothing is submitted. Each sign-in and sign-out reads the store's unfinished
 * purchases again, so one left for a user goes through once that user signs in on this device.
 *
 * The store connection opens at launch, which is what starts StoreKit's and Play's deliveries, and the purchases
 * they still hold unfinished are read then too. Answers a function that stops listening. The root layout runs this
 * through `useStoreTransactions`.
 */
export function watchStoreTransactions(rail: "apple" | "google"): () => void {
  let stopped = false;
  let listener: { remove: () => void } | null = null;
  const inFlight = new Set<string>();

  const settle = async (purchase: Purchase): Promise<void> => {
    if (purchase.purchaseState === "pending") return;
    if (awaitedSkus.has(purchase.productId) || claimedTransactions.has(purchase.id)) return;
    const tagged = purchaseAccountToken(rail, purchase);
    if (tagged === null) return;
    const receipt = storeReceipt(rail, purchase);
    if (receipt === null || !authConfig.enabled || inFlight.has(purchase.id)) return;
    inFlight.add(purchase.id);
    try {
      // One credential answers whose purchase this is and carries it, so a sign-in landing in between can never
      // send one user's purchase under the next user's credential.
      const credential = await transport.pinned();
      if (credential === null || stopped) return;
      const owner = await credentialAccountToken(credential);
      if (stopped || owner === null || !taggedForOwner(tagged, owner, await knownAccountTokens())) return;
      const written = await submitPurchase({ rail, receipt }, { ...paymentsClient, ...credential.capability });
      if (written.ok) await finishAccepted(purchase, consumableSku(rail, purchase.productId));
    } finally {
      inFlight.delete(purchase.id);
    }
  };

  const scan = async (): Promise<void> => {
    const store = await connectStore();
    if (store === null || stopped) return;
    for (const purchase of await unfinishedPurchases(rail, store)) {
      if (stopped) return;
      await settle(purchase);
    }
  };

  const unwatch = transport.onChange(() => {
    void scan();
  });

  void (async () => {
    const store = await loadStore();
    if (store === null || stopped) return;
    listener = store.purchaseUpdatedListener((purchase: Purchase) => {
      void settle(purchase);
    });
    // Opening the connection is what starts StoreKit's and Play's deliveries; the scan reads what is already held.
    await scan();
  })();

  return () => {
    stopped = true;
    unwatch();
    listener?.remove();
  };
}

/** A refusal carried through `useAction` as a thrown error, so the screen reads it back as a failure. */
class StoreRefusal extends Error {
  constructor(readonly failure: PaymentsFailure) {
    super(failure.message);
  }
}

/** Who a store sale is made for: one credential, and the account token of the user it belongs to here. */
interface Buyer {
  readonly credential: PinnedCredential;
  readonly token: string;
}

/**
 * The signed-in user, pinned: the same credential answers who they are and carries everything the sale sends, so a
 * sign-in landing while the store's sheet is open can never send one user's purchase under the next user's.
 * Refuses with nobody signed in, and when this device cannot keep a token to tag the purchase with.
 */
async function pinBuyer(): Promise<Buyer> {
  if (!authConfig.enabled) throw new StoreRefusal(STORE_SIGNED_OUT);
  const credential = await transport.pinned();
  if (credential === null) throw new StoreRefusal(STORE_SIGNED_OUT);
  const userId = await credentialUserId(credential);
  if (userId === null) throw new StoreRefusal(STORE_SIGNED_OUT);
  const token = await accountToken(userId);
  if (token === null) throw new StoreRefusal(STORE_NO_TOKEN);
  return { credential, token: token.toLowerCase() };
}

/** What the last store action came to. */
export type StoreSaleOutcome = "bought" | "pending" | "cancelled" | "refused" | "restored" | "nothing_to_restore";

/** What {@link useStoreSale} gives a screen that sells through the platform's store. */
export interface StoreSale {
  /** Buy `item` through `rail`: the store's sheet, then the Worker, then the store's transaction is finished. */
  buy: (rail: "apple" | "google", item: StoreItem) => Promise<void>;
  /**
   * Restore Purchases: the store's history on `rail`, submitted to the Worker for the signed-in user. A purchase
   * tagged for another user on this device is left for that user.
   */
  restore: (rail: "apple" | "google") => Promise<void>;
  /** Whether a purchase or a restore is in flight. */
  busy: boolean;
  /** What the last one came to, or null before any. */
  outcome: StoreSaleOutcome | null;
  /** Why the last one failed, the store's refusal or the Worker's, or null. */
  failure: PaymentsFailure | null;
  /** The caller's entitlements as the Worker answered the last purchase or restore, empty before one. */
  entitlements: readonly EntitlementView[];
}

/** Restore takes at most this many receipts per request. */
const RESTORE_BATCH = 50;

/** What one store action came to, and the entitlements the Worker answered with when it wrote one. */
interface StoreSaleAnswer {
  readonly outcome: StoreSaleOutcome;
  readonly entitlements: readonly EntitlementView[] | null;
}

const NO_ENTITLEMENTS: readonly EntitlementView[] = [];

/**
 * Buying in the app, through StoreKit or Play Billing. The store's sheet takes the payment and answers with a
 * signed purchase; it goes to the Worker's `/purchases` route, and the store's transaction is finished only once
 * the Worker has accepted it. A refused or unsent purchase stays with the store, which hands it back on the next
 * launch or a restore, so a buyer is never charged for something their account does not hold.
 *
 * Each purchase is tagged with this user's account token on this device, which is how the Worker links the store
 * account to the buyer, and is sent under the credential the buyer was read from. A store that has not answered
 * within `answerWithin` ms ({@link STORE_ANSWER_WITHIN} by default) ends the wait with {@link STORE_NO_ANSWER}.
 */
export function useStoreSale(options: { answerWithin?: number } = {}): StoreSale {
  const answerWithin = options.answerWithin ?? STORE_ANSWER_WITHIN;
  const sale = useAction(
    async (
      _signal,
      call: { kind: "buy"; rail: "apple" | "google"; item: StoreItem } | { kind: "restore"; rail: "apple" | "google" },
    ): Promise<StoreSaleAnswer> => {
      if (!onDevice()) throw new StoreRefusal(call.kind === "buy" ? STORE_NO_TOKEN : STORE_UNAVAILABLE);
      const { credential, token } = await pinBuyer();
      const client = { ...paymentsClient, ...credential.capability };

      if (call.kind === "buy") {
        const answer = await askStore(call.rail, call.item, token, answerWithin);
        if (answer.kind === "refused") throw new StoreRefusal(answer.failure);
        if (answer.kind !== "bought") return { outcome: answer.kind, entitlements: null };
        const receipt = storeReceipt(call.rail, answer.purchase);
        if (receipt === null) throw new StoreRefusal(PAYMENTS_UNREADABLE);
        const written = await submitPurchase({ rail: call.rail, receipt }, client);
        if (!written.ok) throw new StoreRefusal(written.failure);
        await finishAccepted(answer.purchase, call.item.type === "consumable");
        return { outcome: "bought", entitlements: written.value.entitlements };
      }

      const store = await connectStore();
      if (store === null) throw new StoreRefusal(STORE_UNAVAILABLE);
      let held: Purchase[];
      try {
        await store.restorePurchases();
        held = await store.getAvailablePurchases();
      } catch {
        throw new StoreRefusal(STORE_UNAVAILABLE);
      }
      const known = await knownAccountTokens();
      // A purchase tagged for another user of this device stays with the store for that user.
      const receipted = held.flatMap((purchase) => {
        const tagged = purchaseAccountToken(call.rail, purchase);
        if (tagged !== null && !taggedForOwner(tagged, token, known)) return [];
        const receipt = storeReceipt(call.rail, purchase);
        return receipt === null ? [] : [{ purchase, receipt }];
      });
      if (receipted.length === 0) return { outcome: "nothing_to_restore", entitlements: null };
      let entitlements: readonly EntitlementView[] | null = null;
      for (let start = 0; start < receipted.length; start += RESTORE_BATCH) {
        const batch = receipted.slice(start, start + RESTORE_BATCH);
        const written = await restorePurchases(
          { rail: call.rail, receipts: batch.map((entry) => entry.receipt) },
          client,
        );
        if (!written.ok) throw new StoreRefusal(written.failure);
        entitlements = written.value.entitlements;
        for (const { purchase } of batch) {
          await finishAccepted(purchase, consumableSku(call.rail, purchase.productId));
        }
      }
      return { outcome: "restored", entitlements };
    },
  );
  const run = sale.run;
  const buy = useCallback(
    async (rail: "apple" | "google", item: StoreItem) => {
      await run({ kind: "buy", rail, item });
    },
    [run],
  );
  const restore = useCallback(
    async (rail: "apple" | "google") => {
      await run({ kind: "restore", rail });
    },
    [run],
  );
  // The entitlements the Worker last answered with, kept through an outcome that wrote nothing.
  const entitlements = useRef(NO_ENTITLEMENTS);
  if (sale.value?.entitlements) entitlements.current = sale.value.entitlements;
  const refused = sale.failure instanceof StoreRefusal ? sale.failure.failure : sale.failure && STORE_UNAVAILABLE;
  return {
    buy,
    restore,
    busy: sale.pending,
    // `useAction` keeps the last success through a later failure; the outcome is the last call's.
    outcome: sale.pending ? null : refused ? "refused" : (sale.value?.outcome ?? null),
    failure: sale.pending ? null : refused,
    entitlements: entitlements.current,
  };
}
