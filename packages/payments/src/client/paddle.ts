// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { initializePaddle } from "@paddle/paddle-js";
import {
  PAYMENTS_NO_BROWSER,
  PAYMENTS_UNREADABLE,
  type PaymentsFailure,
  type PaymentsPaddleDisplayMode,
  type PaymentsPaddleEnvironment,
  type PaymentsResult,
} from "./api";

/**
 * Paddle.js: loading it once, asking it what this visitor pays, and reading the answer safely.
 *
 * **This is the half of the Paddle rail a redirect cannot do.** The server mints transactions and takes
 * webhooks; nothing on that side can tell a visitor in Berlin that the $5.00 they see includes $0.80 of
 * VAT while a visitor in Chicago will be charged $5.75. Only a script running in that browser, talking to
 * Paddle from that IP, knows — so the whole of localized pricing lives here or it does not exist.
 *
 * **Never format a price yourself, and never write one down.** Paddle returns `formattedTotals` already
 * rendered for the visitor: the right symbol, the right separators, and whole units for the zero-decimal
 * currencies (¥725 is `725`, not `72500`). A kit that took the raw minor units and reached for
 * `Intl.NumberFormat` would have to carry a table of which currencies have two decimals, and would get
 * one wrong. The raw amounts are exposed too, but they are for **comparing**, never for showing.
 *
 * **What "localized" actually means, measured rather than assumed.** With no `unit_price_overrides` on
 * the price, every country is billed in the catalogue's currency — a preview from a UK address on a USD
 * price comes back in dollars. Currency is a catalogue decision. What this delivers without one is tax
 * and formatting, which is real: the US adds tax to the listed figure and settles it at the postal code,
 * while the EU, the UK and Japan take it out of an inclusive one. {@link priceSummary} is where that
 * difference stops being a footnote and becomes two different sentences.
 *
 * **No API key is reachable from this module or any other under `src/client/`.** The client token is
 * publishable by design and is the only credential that belongs in a browser. `paddle.test.ts` sweeps the
 * directory for the shapes of the ones that do not.
 *
 * Cookie/session and same-origin are irrelevant here: none of this talks to the adopter's Worker. It
 * talks to Paddle, with Paddle's own publishable token, exactly as Paddle's documentation intends.
 */

/** Paddle.js could not be loaded at all: an ad blocker, a Content Security Policy, or no network. */
export const PADDLE_UNAVAILABLE: PaymentsFailure = {
  code: "client/paddle_unavailable",
  message: "We couldn't load the payment provider.",
  action: "Check your connection or any content blockers, then reload.",
};

/**
 * Paddle.js loaded and then refused to initialize. A token from the wrong account is the usual cause.
 *
 * Distinct from {@link PADDLE_UNAVAILABLE} because the two are fixed by different people: one is the
 * visitor's browser, the other is the project's configuration.
 */
export const PADDLE_NOT_INITIALIZED: PaymentsFailure = {
  code: "client/paddle_not_initialized",
  message: "The payment provider wouldn't start.",
  action: "Reload. If it keeps happening, this project's payment settings are wrong.",
};

/** A second, different Paddle account was asked for on a page that already has one. */
export const PADDLE_ACCOUNT_CONFLICT: PaymentsFailure = {
  code: "client/paddle_account_conflict",
  message: "The payment provider is already running for a different account.",
  action: "One page serves one Paddle account. Reload before switching.",
};

/** Paddle refused the price request itself — an unknown price id, or a token scoped elsewhere. */
export const PADDLE_PREVIEW_REFUSED: PaymentsFailure = {
  code: "client/paddle_preview_refused",
  message: "We couldn't get a price for you.",
  action: "Try again in a moment.",
};

/** What Paddle.js needs to start: the publishable token, and which account it belongs to. */
export interface PaddleSetup {
  /** Paddle's publishable client token — `test_…` in sandbox, `live_…` in production. */
  clientToken: string;
  /** Which Paddle account the token belongs to. Sandbox and live are separate accounts, not a flag. */
  environment: PaymentsPaddleEnvironment;
}

/** One line of a price request. */
export interface PaddlePriceItem {
  /** The Paddle price — `pri_…`. `paymentsConfig.products[].skus.paddle` carries it. */
  priceId: string;
  /** How many. Paddle refuses a quantity outside the price's own `quantity` bounds. */
  quantity: number;
}

/**
 * What to ask a price for, and on whose behalf.
 *
 * **Location is optional, and where it comes from is a real decision.** Omitted, Paddle resolves it from
 * the browser's own IP, which is right for a marketing page nobody has signed in to. A Worker can do
 * better for a signed-in visitor: `request.cf.country` is on every Cloudflare request, and a customer
 * with a saved address has one on file at Paddle already — pass `customerId` and Paddle uses it.
 *
 * **Send a postal code where you have one.** United States tax resolves at the postal code, not the
 * country: 15% in Chicago, 8.875% in New York, 0% in Oregon — and 0% for the country with no code at
 * all. A country-only preview therefore quotes an American buyer $5.00 for something they will be
 * charged $5.44 for. {@link priceSummary} says so rather than letting the page imply otherwise.
 */
export interface PaddlePriceQuery {
  /** The prices to quote. */
  items: readonly PaddlePriceItem[];
  /** Where the visitor is. Omit to let Paddle resolve it from their IP. */
  address?: { countryCode: string; postalCode?: string };
  /** An existing Paddle customer, whose saved address Paddle will use. */
  customerId?: string;
  /** An IP to resolve location from, for a server that knows it better than the browser does. */
  customerIpAddress?: string;
  /** Force a currency. Only meaningful where the catalogue has an override for it. */
  currencyCode?: string;
  /** A resolved Paddle discount — `dsc_…`. Never a raw code; resolving one needs the API key. */
  discountId?: string;
}

/**
 * The slice of Paddle.js this kit touches, declared structurally.
 *
 * Structural rather than `import type { Paddle }` for the reason `PaymentsFetch` is structural: this file
 * compiles inside an adopter's browser program, and a narrow shape is one they can satisfy with a stub
 * where the real type drags Paddle's whole graph in. `paddle.test.ts` pins it against the real `Paddle`
 * type at compile time, so it cannot drift when Paddle renames something.
 */
export interface PaddleJs {
  /** Whether `Initialize` has run and succeeded. Paddle.js sets it; nothing here writes it. */
  Initialized: boolean;
  /** Which account this instance talks to. Must be set before `Initialize`, which the loader does. */
  Environment: { set(environment: PaymentsPaddleEnvironment): void };
  /** Prices for this visitor. The camelCase mirror of the server's `pricing-preview` endpoint. */
  PricePreview(params: PaddlePriceQuery): Promise<unknown>;
  /** The overlay and the inline frame. See {@link PaddleCheckoutOpen} for what this kit may hand it. */
  Checkout: {
    /** Open a checkout. Synchronous and returns nothing — a refusal arrives as a throw or not at all. */
    open(options: PaddleCheckoutOpen): void;
    /** Close whatever is open. Nothing happens when nothing is. */
    close(): void;
  };
}

/**
 * Light or dark. Paddle's whole theme surface, and the only one there is.
 *
 * Not a palette. Colours, fonts, borders and focus states are configured in the Paddle dashboard and are
 * not expressible from code at all — see {@link PaddleCheckoutSettings.theme} for where and why.
 */
export type PaddleCheckoutTheme = "light" | "dark";

/**
 * Whether the card form is one page or several.
 *
 * Paddle's own type carries a third value, `express`, which its checkout-settings documentation does not
 * list. Absent here rather than passed through: this kit hands Paddle only what Paddle documents a seller
 * may set, and a value nobody can point at a page for is one nobody can support.
 */
export type PaddleCheckoutVariant = "one-page" | "multi-page";

/**
 * How one checkout is presented. Paddle takes the same settings at `Initialize` and here.
 *
 * **Here, deliberately.** The loader is one per page and these are per checkout: the display mode comes
 * off a handoff the server minted, and the container class is the screen's, so a page with a paywall and
 * a pricing panel must be able to open two checkouts differently without re-initializing Paddle — which
 * it cannot do, because `Initialize` runs once. Paddle's own documentation says `frameTarget` goes in
 * `Paddle.Initialize()`; its `Checkout.open` reference then passes exactly these fields per call, and the
 * live sandbox honours them on both forms. Where the two disagree, the measurement wins.
 *
 * **Every field here is optional and stays absent when nobody named one.** Paddle reads these over
 * account-level settings a seller configured in the dashboard, so a key present and `undefined` is not
 * the same message as no key — see `settingsFor` in `./checkout`, which is where that is enforced.
 */
export interface PaddleCheckoutSettings {
  /** Over the page, or inside the element {@link PaddleCheckoutSettings.frameTarget} names. */
  displayMode?: PaymentsPaddleDisplayMode;
  /**
   * Light or dark. Paddle defaults to `light`, which is why an app in dark mode has to say so.
   *
   * **Never inferred, and that is a decision rather than an omission.** Nothing in this kit reads
   * `prefers-color-scheme`, samples a computed style, or calls `matchMedia`: the OS preference is not the
   * app's theme — an app with its own toggle, or one that is dark whatever the OS says, would get a card
   * form contradicting the page it opened over. The adopter knows; guessing wrong is worse than
   * defaulting, and a wrong guess is harder to find than a missing option.
   *
   * **This is the whole of the theming Paddle exposes to code.** Colours, fonts, borders, hover and focus
   * states are set in the Paddle dashboard under *Checkout → Branded inline checkout* (and logo plus
   * brand colour for the overlay). That is Paddle's deliberate product decision, not a missing endpoint,
   * so there is no option to add here for it and nothing to go looking for.
   */
  theme?: PaddleCheckoutTheme;
  /** The buyer's language — `"fr"`, `"pt-BR"`. Paddle defaults to the browser's. Pass it where the app has its own. */
  locale?: string;
  /** One page or several. Paddle defaults to `multi-page`. */
  variant?: PaddleCheckoutVariant;
  /** The **class name** — not an id, not a selector — of the element an inline checkout renders into. */
  frameTarget?: string;
  /** Styles for that element. Paddle needs `min-width` at 312px or the merchant-of-record footer is cut off. */
  frameStyle?: string;
  /** Its height in pixels on load, before the frame resizes itself. Paddle recommends 450. */
  frameInitialHeight?: number;
  /** Where a buyer who paid is sent. From the server, never from a screen — see {@link PaddleCheckoutOpen}. */
  successUrl?: string;
}

/**
 * What this kit is willing to open a checkout for: a transaction, and how to show it.
 *
 * **`items` and `customData` are absent, and their absence is deliberate in two different ways.**
 *
 * `items[]` is what makes Paddle pleasant — no server call, a checkout in one click — and it is also a
 * checkout whose price and whose buyer are chosen by the page. This capability takes both from the
 * catalogue entry a product id resolves to, everywhere else, so that a client cannot buy Pro for the price
 * of a coin pack. A transaction the server minted is that same rule, kept here.
 *
 * `customData` is the harder one, because leaving it out does **not** make the stamp safe. Measured live:
 * Paddle accepts `customData` beside a `transactionId` and overwrites the `custom_data` the server wrote
 * on that transaction. So omitting it here is hygiene — this kit has nothing to say through that field
 * that it has not already said on the server — and the thing that actually protects ownership is the MAC
 * in `../rails/paddle/objects.ts`. A reader who takes this type as the security boundary would be reading
 * it wrongly, which is why it says so.
 */
export interface PaddleCheckoutOpen {
  /** The transaction the server created — `txn_…`. The only thing a checkout here is ever opened for. */
  transactionId: string;
  /** How to present it. */
  settings?: PaddleCheckoutSettings;
}

/**
 * How Paddle.js is fetched and started.
 *
 * The default is `initializePaddle` from `@paddle/paddle-js`. It is a seam because a test must never
 * reach Paddle's CDN, and because a project with its own script-loading policy may want to hand one in.
 */
export type PaddleInitializer = (options: {
  token: string;
  environment?: PaymentsPaddleEnvironment;
}) => Promise<PaddleJs | undefined>;

/**
 * Where "one initialization per page" is remembered.
 *
 * A parameter with a module-level default rather than a hidden singleton with a reset button. The
 * default is the page, which is what every screen wants; a test passes its own and gets a fresh page
 * without an escape hatch existing in shipped code for anyone else to reach for.
 */
export interface PaddleRegistry {
  /** The one load in flight or already done, and which account it was for. */
  current?: { key: string; paddle: Promise<PaymentsResult<PaddleJs>> };
}

/** The page's registry. Module state on purpose: a page is exactly the scope this is about. */
const PAGE: PaddleRegistry = {};

/** What {@link loadPaddle} and {@link previewPrices} let a caller replace. */
export interface PaddleOptions {
  /** How to fetch and start Paddle.js. Defaults to `@paddle/paddle-js`. */
  initialize?: PaddleInitializer;
  /** Where the one-per-page load is remembered. Defaults to the page's own. */
  registry?: PaddleRegistry;
}

/** Which account a setup names, as one comparable string. */
function setupKey(setup: PaddleSetup): string {
  return `${setup.environment}:${setup.clientToken}`;
}

/** The real loader. Wrapped rather than passed directly so the seam's shape is this kit's, not Paddle's. */
const defaultInitializer: PaddleInitializer = (options) => initializePaddle(options);

/**
 * Load and initialize Paddle.js, once per page.
 *
 * Idempotent by construction rather than by documentation: the first call's promise is remembered and
 * every later call for the same account is handed the same one, so two components mounting at once
 * produce one script and one `Initialize`. A call for a *different* account is refused — Paddle.js holds
 * one environment and one token per page, `Environment.set` after `Initialize` leaves it half-moved, and
 * silently re-pointing a live account at a sandbox is not a failure anyone would notice until a real
 * card was declined.
 *
 * **`Environment.set` runs for sandbox and for production alike**, before `Initialize`. Passing it
 * explicitly both ways is what makes the environment a declared fact rather than a default nobody looked
 * at — and the two are separate accounts with separate tokens, so a token used against the wrong one is
 * refused outright.
 *
 * Nothing here throws. A blocked script, a server render with no `window`, and a token the account
 * rejects are three different {@link PaymentsFailure}s, because they are three different problems.
 */
export function loadPaddle(setup: PaddleSetup, options?: PaddleOptions): Promise<PaymentsResult<PaddleJs>> {
  const registry = options?.registry ?? PAGE;
  const key = setupKey(setup);
  const held = registry.current;
  if (held) {
    if (held.key === key) return held.paddle;
    return Promise.resolve({ ok: false, failure: PADDLE_ACCOUNT_CONFLICT });
  }

  const initialize = options?.initialize ?? defaultInitializer;
  // `Promise.try`'s shape by hand: an initializer that throws before it returns a promise — Paddle.js
  // does exactly that when the document has neither a `<head>` nor a `<body>` — must arrive here as a
  // refusal like every other. "Nothing here throws" is a claim about every path or it is not one.
  const started = new Promise<PaddleJs | undefined>((resolve) => {
    resolve(initialize({ token: setup.clientToken, environment: setup.environment }));
  });
  const paddle = started
    .then(
      (instance): PaymentsResult<PaddleJs> => {
        // `undefined` is Paddle.js's own answer for "there is no window here" — a server render, or a
        // test with no DOM. It is not a failure of the account or the network.
        if (!instance) return { ok: false, failure: PAYMENTS_NO_BROWSER };
        // `initializePaddle` swallows an initialization error into a `console.warn` and still resolves
        // with the instance, so the only honest check is the flag Paddle.js sets itself. Without this a
        // bad token reads as a working Paddle whose every call quietly does nothing.
        if (!instance.Initialized) return { ok: false, failure: PADDLE_NOT_INITIALIZED };
        return { ok: true, value: instance };
      },
      (): PaymentsResult<PaddleJs> => ({ ok: false, failure: PADDLE_UNAVAILABLE }),
    )
    .then((result): PaymentsResult<PaddleJs> => {
      // **A failure is not remembered.** Idempotence is about not initializing twice, and a load that
      // never produced a Paddle initialized nothing — a blocked script, a flaky network and a page that
      // rendered before its `<head>` existed are all retryable. Caching the refusal would make one bad
      // first second permanent for the life of the page, and a `refresh` button that cannot work.
      if (!result.ok && registry.current?.key === key) registry.current = undefined;
      return result;
    });

  registry.current = { key, paddle };
  return paddle;
}

/** Four amounts, as Paddle sends them. Formatted or raw depending on which field they came off. */
export interface PriceTotals {
  /** The price before tax. */
  subtotal: string;
  /** What any discount took off. */
  discount: string;
  /** The tax. */
  tax: string;
  /** What the buyer pays. Always `subtotal - discount + tax`. */
  total: string;
}

/**
 * How tax sits against the figure the catalogue lists, resolved for this visitor.
 *
 * Not a country table, and not readable off `taxMode` either: a price set to `location` — Paddle's own
 * default — resolves to `added` in Denver and `included` in Berlin, and the mode says only that Paddle
 * will decide. So this is derived from the numbers Paddle returned, by asking which of them is the
 * listed price.
 *
 * - `added` — the listed price is the subtotal, and tax goes on top. The US convention.
 * - `included` — the listed price is the total, and tax comes out of it. The EU, UK and Japan.
 * - `none` — no tax at this address. The question does not arise; both readings are the same number.
 * - `unknown` — it cannot be told. A currency conversion, or a discount, moved both figures away from
 *   the listed one. The total is still exactly what the buyer pays, which is what a screen renders.
 */
export type PriceTaxTreatment = "added" | "included" | "none" | "unknown";

/** One quoted price. */
export interface PriceLine {
  /** The Paddle price this quotes — `pri_…`. */
  priceId: string;
  /** The product's name, as the catalogue has it. */
  productName: string;
  /** The price's own name — "Monthly" — or null. */
  priceName: string | null;
  /** How many units this line quotes. */
  quantity: number;
  /** The tax rate as a decimal string — `"0.08875"`. `"0"` where none applies. */
  taxRate: string;
  /** How often this bills, or null for a one-off. */
  billingCycle: { interval: string; frequency: number } | null;
  /** Per unit, in minor units. For comparing. Never render these. */
  unitTotals: PriceTotals;
  /** The whole line, in minor units. For comparing. Never render these. */
  totals: PriceTotals;
  /** Per unit, rendered by Paddle for this visitor. Render these. */
  formattedUnitTotals: PriceTotals;
  /** The whole line, rendered by Paddle for this visitor. Render these. */
  formattedTotals: PriceTotals;
  /** Where tax sits against the listed figure here. */
  taxTreatment: PriceTaxTreatment;
}

/** What Paddle quoted this visitor. */
export interface PricePreview {
  /** The currency the quote is in. The catalogue's, unless an override or `currencyCode` moved it. */
  currencyCode: string;
  /** The country Paddle resolved, or null. */
  countryCode: string | null;
  /**
   * The postal code the quote was resolved at, or null.
   *
   * Null is load-bearing, not incidental. United States tax resolves below the country, so a quote with
   * no postal code can be short by up to 15% — and Paddle returns it as `0%` rather than as an error.
   */
  postalCode: string | null;
  /** One line per item asked for, in the order asked. */
  lines: readonly PriceLine[];
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether every one of the four amounts is a string. */
function readTotals(value: unknown): PriceTotals | null {
  if (!isRecord(value)) return null;
  const { subtotal, discount, tax, total } = value;
  if (typeof subtotal !== "string") return null;
  if (typeof discount !== "string") return null;
  if (typeof tax !== "string") return null;
  if (typeof total !== "string") return null;
  return { subtotal, discount, tax, total };
}

/** A non-empty string, or null. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The price's listed amount for this quote's country, following any override that covers it. */
function listedAmount(
  price: Record<string, unknown>,
  countryCode: string | null,
): { amount: string; currency: string } | null {
  const overrides = price.unitPriceOverrides;
  if (countryCode !== null && Array.isArray(overrides)) {
    for (const override of overrides) {
      if (!isRecord(override) || !Array.isArray(override.countryCodes)) continue;
      if (!override.countryCodes.includes(countryCode)) continue;
      const unit = override.unitPrice;
      if (!isRecord(unit) || typeof unit.amount !== "string" || typeof unit.currencyCode !== "string") return null;
      return { amount: unit.amount, currency: unit.currencyCode };
    }
  }
  const unit = price.unitPrice;
  if (!isRecord(unit) || typeof unit.amount !== "string" || typeof unit.currencyCode !== "string") return null;
  return { amount: unit.amount, currency: unit.currencyCode };
}

/**
 * Which of the quoted figures is the price the catalogue lists.
 *
 * Per **unit**, so quantity never enters the comparison, and against the override that covers this
 * country where there is one. Every branch here was measured against the live sandbox; the fixtures
 * beside this module are those measurements.
 */
function taxTreatment(
  unitTotals: PriceTotals,
  price: Record<string, unknown>,
  currencyCode: string,
  countryCode: string | null,
): PriceTaxTreatment {
  if (unitTotals.tax === "0") return "none";
  const listed = listedAmount(price, countryCode);
  // A converted quote is in a currency the catalogue never named an amount in, so there is nothing to
  // compare against and no honest answer but "cannot tell".
  if (listed === null || listed.currency !== currencyCode) return "unknown";
  if (unitTotals.subtotal === listed.amount) return "added";
  if (unitTotals.total === listed.amount) return "included";
  // A discount moved both figures. The total is still what is owed.
  return "unknown";
}

/** One line item of Paddle's answer, or null when it is not one. */
function readLine(value: unknown, currencyCode: string, countryCode: string | null): PriceLine | null {
  if (!isRecord(value)) return null;
  const price = value.price;
  const product = value.product;
  if (!isRecord(price) || !isRecord(product)) return null;
  if (typeof price.id !== "string" || typeof product.name !== "string") return null;
  if (typeof value.quantity !== "number" || typeof value.taxRate !== "string") return null;

  const unitTotals = readTotals(value.unitTotals);
  const totals = readTotals(value.totals);
  const formattedUnitTotals = readTotals(value.formattedUnitTotals);
  const formattedTotals = readTotals(value.formattedTotals);
  if (!unitTotals || !totals || !formattedUnitTotals || !formattedTotals) return null;

  const cycle = price.billingCycle;
  const billingCycle =
    isRecord(cycle) && typeof cycle.interval === "string" && typeof cycle.frequency === "number"
      ? { interval: cycle.interval, frequency: cycle.frequency }
      : null;

  return {
    priceId: price.id,
    productName: product.name,
    priceName: optionalString(price.name),
    quantity: value.quantity,
    taxRate: value.taxRate,
    billingCycle,
    unitTotals,
    totals,
    formattedUnitTotals,
    formattedTotals,
    taxTreatment: taxTreatment(unitTotals, price, currencyCode, countryCode),
  };
}

/**
 * Narrow Paddle's answer, or refuse it.
 *
 * **This is a trust boundary and it is treated as one.** The response comes from a third party's script
 * over a network this kit does not control, and a page that read `lineItems[0].formattedTotals.total`
 * off whatever arrived would render `undefined` as a price. Every field a caller can reach is checked
 * here; nothing partial gets through, because half a price is worse than none.
 *
 * Hand-written guards rather than Zod, for the reason `api.ts` gives: this compiles into a browser
 * bundle and must not drag the server's schema graph in behind it.
 */
export function readPricePreview(value: unknown): PricePreview | null {
  if (!isRecord(value)) return null;
  if (typeof value.currencyCode !== "string") return null;
  const details = value.details;
  if (!isRecord(details) || !Array.isArray(details.lineItems)) return null;

  const address = isRecord(value.address) ? value.address : null;
  const countryCode = address ? optionalString(address.countryCode) : null;
  // Paddle answers a country-only request with `postalCode: ""`, not with null. An empty string is an
  // absent postal code, and the difference matters — see {@link PricePreview.postalCode}.
  const postalCode = address ? optionalString(address.postalCode) : null;

  const lines: PriceLine[] = [];
  for (const item of details.lineItems) {
    const line = readLine(item, value.currencyCode, countryCode);
    if (line === null) return null;
    lines.push(line);
  }
  return { currencyCode: value.currencyCode, countryCode, postalCode, lines };
}

/**
 * Ask Paddle what this visitor pays.
 *
 * Loads Paddle.js if it is not loaded, which is why a screen needs no separate setup step. Every failure
 * on the way — a blocked script, a refused token, an unreadable answer — arrives as a
 * {@link PaymentsFailure} and never as a thrown error and never as a number.
 */
export async function previewPrices(
  setup: PaddleSetup,
  query: PaddlePriceQuery,
  options?: PaddleOptions,
): Promise<PaymentsResult<PricePreview>> {
  const loaded = await loadPaddle(setup, options);
  if (!loaded.ok) return loaded;
  // Settled as a pair rather than caught into a sentinel: the answer is `unknown`, so any sentinel value
  // is one an answer could in principle equal.
  const answer = await loaded.value.PricePreview(query).then(
    (value: unknown) => ({ answered: true as const, value }),
    () => ({ answered: false as const, value: undefined }),
  );
  if (!answer.answered) return { ok: false, failure: PADDLE_PREVIEW_REFUSED };
  const preview = readPricePreview(answer.value);
  if (preview === null) return { ok: false, failure: PAYMENTS_UNREADABLE };
  return { ok: true, value: preview };
}

/** What a pricing screen puts on the page for one line. */
export interface PriceSummary {
  /** The figure that goes in large type, already rendered by Paddle. */
  headline: string;
  /** One sentence about tax, or null when there is nothing true to say. */
  note: string | null;
  /**
   * Whether the tax in this quote may be short of what the buyer is charged.
   *
   * True when no postal code was resolved. United States tax lives below the country, so a country-only
   * quote comes back at 0% and the card is charged more. A screen that hides this is the defect this
   * whole module exists to avoid.
   */
  estimated: boolean;
}

/**
 * The one number to show, and the one sentence that makes it true.
 *
 * **The headline is not the same field in every country, and that is the point.** Where tax is added on
 * top the listed price is the subtotal, and quoting the total would advertise a New Yorker's local sales
 * tax as part of the price. Where tax is taken out of an inclusive figure the listed price *is* the
 * total, and quoting the subtotal would advertise €4.20 for something that costs €5.00. One hardcoded
 * string cannot mean "before tax" in Denver and "including VAT" in Berlin, so this returns two.
 *
 * It lives in the package rather than in the scaffolded screen for the reason the hooks do: an adopter's
 * `pricing.tsx` is written once and never rewritten, and tax conventions are not a thing to freeze into
 * somebody else's repository.
 *
 * Per unit, always. A pricing page quotes "$5.00 a month", not "$15.00 for the three seats you have not
 * chosen yet"; a cart that wants the line total reads `formattedTotals` itself.
 */
export function priceSummary(preview: PricePreview, line: PriceLine): PriceSummary {
  const estimated = preview.postalCode === null;
  const totals = line.formattedUnitTotals;
  if (line.taxTreatment === "added") {
    return { headline: totals.subtotal, note: `Plus ${totals.tax} tax.`, estimated };
  }
  if (line.taxTreatment === "included") {
    return { headline: totals.total, note: `Includes ${totals.tax} tax.`, estimated };
  }
  if (line.taxTreatment === "none") {
    // No tax was resolved. Whether that is the truth or the missing postal code depends on `estimated`,
    // and saying "no tax" when we did not ask precisely enough would be the lie.
    return { headline: totals.total, note: estimated ? "Tax is settled at checkout." : null, estimated };
  }
  return { headline: totals.total, note: `Includes ${totals.tax} tax.`, estimated };
}

/**
 * A stable key for a query, so an effect can depend on what was asked rather than on the object.
 *
 * A screen writes `usePricePreview(setup, { items: [{ priceId, quantity: 1 }] })` inline, which is a new
 * object every render. An effect depending on it would fetch forever. Depending on this instead means
 * the request repeats when — and only when — something about the request changed.
 *
 * Field order is fixed here rather than taken from the object, because `{ a, b }` and `{ b, a }` are the
 * same query and `JSON.stringify` disagrees.
 */
export function priceQueryKey(query: PaddlePriceQuery): string {
  return JSON.stringify([
    query.items.map((item) => [item.priceId, item.quantity]),
    query.address ? [query.address.countryCode, query.address.postalCode ?? null] : null,
    query.customerId ?? null,
    query.customerIpAddress ?? null,
    query.currencyCode ?? null,
    query.discountId ?? null,
  ]);
}
