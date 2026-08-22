// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PAYMENTS_NO_BROWSER, type PaddleCheckoutHandoff, type PaymentsFailure } from "./api";
import {
  loadPaddle,
  type PaddleCheckoutSettings,
  type PaddleCheckoutTheme,
  type PaddleCheckoutVariant,
  type PaddleOptions,
} from "./paddle";

/**
 * Opening a Paddle checkout over the adopter's own page, or inside it.
 *
 * This is the half of the rail a redirect cannot do. `startCheckout` on a redirect rail sends the browser
 * to somebody else's domain and the sale finishes there; Paddle's overlay draws the card form over the
 * page the buyer was already on, and its inline mode draws it *in* the page, in a container the screen
 * put there. Nothing about the money moves — Paddle is still the merchant of record, still owns SCA, tax
 * and the card fields — but the buyer never leaves.
 *
 * ## `items[]` or `transactionId`, settled
 *
 * Paddle offers two ways to open a checkout. `items: [{ priceId, quantity }]` needs no server at all: a
 * page with the publishable client token can open a checkout in one click, which is the single most
 * pleasant thing about this provider. `transactionId` needs a round trip first, because a transaction is
 * something the server creates.
 *
 * **This kit only ever opens a transaction, and the reason is the price and the buyer — not the stamp.**
 * `items[]` lets the page name what is being sold and to whom, and every other route in this capability
 * takes the price from the catalog entry a product id resolves to precisely so a client cannot buy Pro
 * for the price of a coin pack. There is no reading under which that rule holds at `POST /checkout` and
 * stops holding here. So the cost is one round trip before the overlay appears, paid once per purchase.
 *
 * **What `transactionId` does not buy is the ownership stamp, and that was measured rather than assumed.**
 * #309 argued the stamp needed no proof because `Paddle.Checkout.open` refuses `customData` beside a
 * transaction id. It does not refuse it. Against the live sandbox on 2026-08-13: a server-created
 * transaction stamped `pithy_user: "server-owner"` was opened with
 * `Paddle.Checkout.open({ transactionId, customData: { pithy_user: "attacker", … } })` from a page holding
 * only the publishable client token, paid with a test card, and came back from `GET /transactions/{id}`
 * carrying the attacker's values — same id, `origin` still `"api"`, stamp replaced. The recording is
 * `../rails/paddle/fixtures/browserForged.ts` and the refusal is gated on it.
 *
 * So the two halves are independent, and both are needed. The transaction fixes what is sold; the MAC over
 * `(environment, user)` keyed on the destination secret is the *only* thing that fixes who it belongs to,
 * on either form of the call. See `../rails/paddle/objects.ts` for that half in full, and
 * {@link PaddleCheckoutOpen} in `./paddle` for the type that keeps this one unrepresentable rather than
 * merely conventional.
 *
 * ## How it looks is the caller's to say, and only what Paddle lets code say
 *
 * `theme`, `locale` and `variant` are passed through from the caller and are **never inferred**. No
 * `prefers-color-scheme`, no `matchMedia`, no reading a computed style off the page. The OS preference is
 * not the app's theme: an app with its own light/dark toggle, or one that is dark whatever the machine
 * says, would get a card form contradicting the page it opened over — and a wrong guess is far harder to
 * find than an option nobody passed. The adopter knows. So this takes it, and defaults to Paddle's default
 * by saying nothing.
 *
 * **Saying nothing is a real message.** An omitted setting must reach `Checkout.open` as an absent key,
 * not as a key holding `undefined`, because these overlay account-level settings a seller configured in
 * the Paddle dashboard. {@link settingsFor} builds them one at a time for that reason, and the tests assert
 * on `Object.keys` rather than on values.
 *
 * **Colors and fonts are not here because they are not anywhere in code.** Paddle configures them in its
 * own dashboard — *Checkout → Branded inline checkout* for the 50-odd inline options, logo and brand
 * color for the overlay. That is Paddle's product decision rather than a missing endpoint, and the one
 * API that writes `primary_checkout_color` is a Partners route for a platform configuring another
 * seller's account. Nothing to add here, and nothing to go looking for.
 *
 * ## Nothing here throws
 *
 * `Paddle.Checkout.open` is synchronous and returns nothing, so its only way to report a problem is to
 * throw — inside a click handler, where an unhandled rejection is what a buyer gets instead of a card
 * form. Every path through this module answers with a {@link PaymentsFailure} or with null.
 */

/** A screen said `inline`, and there is no element with that class on the page to render into. */
export const PADDLE_NO_CONTAINER: PaymentsFailure = {
  code: "client/paddle_no_container",
  message: "We couldn't show the payment form.",
  action: "Reload the page. If it keeps happening, this screen is missing its checkout container.",
};

/** Paddle.js refused to open the checkout. A transaction it will not sell, or one already completed. */
export const PADDLE_CHECKOUT_REFUSED: PaymentsFailure = {
  code: "client/paddle_checkout_refused",
  message: "We couldn't open the payment form.",
  action: "Try again in a moment.",
};

/**
 * The default styling of an inline checkout's container.
 *
 * Paddle's own recommendation, and `min-width` in it is a compliance requirement rather than taste: the
 * inline frame carries the footer naming Paddle as merchant of record, and below 312px that footer is cut
 * off. A default here rather than in the scaffolded screen keeps the number out of a file Pithy may never
 * rewrite — and a screen that wants its own passes one.
 */
export const PADDLE_FRAME_STYLE = "width: 100%; min-width: 312px; background-color: transparent; border: none;";

/** The container's height in pixels before the frame resizes itself. Paddle's recommended 450. */
export const PADDLE_FRAME_HEIGHT = 450;

/**
 * The slice of `document` this module reads, as an injectable seam.
 *
 * Structural for the reason `PaymentsGlobal` is: the package compiles in a program with no DOM lib
 * alongside the Worker's code, and a test proves the no-browser path without a DOM.
 */
export interface PaddleDocument {
  /** Elements carrying a class. Paddle's `frameTarget` is a class name, so this is the lookup it does. */
  getElementsByClassName(names: string): { length: number };
}

/** What {@link openPaddleCheckout} lets a caller replace or decide. */
export interface PaddleCheckoutOptions extends PaddleOptions {
  /**
   * Light or dark. Omit to take Paddle's default, which is light.
   *
   * **Pass the theme your app is in. This kit will not work it out.** Reading `prefers-color-scheme` here
   * would answer a different question — the machine's preference, not the app's — and an app with its own
   * toggle would open a light card form over a dark page for a reader who chose dark. The screen already
   * knows which theme it rendered; that is the only source that is right every time.
   *
   * Theme is the whole of what code may set. Colors and fonts live in the Paddle dashboard, deliberately.
   */
  theme?: PaddleCheckoutTheme;
  /**
   * The buyer's language — `"fr"`, `"pt-BR"`. Omit to take the browser's.
   *
   * Worth passing exactly when the app has a language choice of its own, for the reason `theme` is worth
   * passing: a reader who set the app to French should not meet a checkout in the language their browser
   * was installed with.
   */
  locale?: string;
  /** One page or several. Omit to take Paddle's default, which is `multi-page`. */
  variant?: PaddleCheckoutVariant;
  /**
   * The **class name** of the element an inline checkout renders into.
   *
   * The screen's to name, not the server's: the container is a thing in a layout, and a project switching
   * `paddle.checkout` between `overlay` and `inline` in its config must not have to edit a scaffolded
   * screen to match. So a screen passes one always and it is used only when the handoff says inline.
   */
  frameTarget?: string;
  /** Styles for that element. Defaults to {@link PADDLE_FRAME_STYLE}. */
  frameStyle?: string;
  /** Its height in pixels on load. Defaults to {@link PADDLE_FRAME_HEIGHT}. */
  frameInitialHeight?: number;
  /** Where the container is looked for. Defaults to the browser's own `document`. */
  document?: PaddleDocument;
}

/** The document to consult — the injected one, else the browser's own, else none. */
function documentOf(options: PaddleCheckoutOptions | undefined): PaddleDocument | undefined {
  if (options && "document" in options) return options.document;
  return (globalThis as { document?: PaddleDocument }).document;
}

/**
 * The presentation settings the caller actually named, and no key for the ones they did not.
 *
 * **Assigned one at a time rather than spread, and that is the whole point of the function.**
 * `{ theme: options?.theme }` writes the key whatever the value is, and a key holding `undefined` is not
 * the same object as no key: `"theme" in settings` is true for one and false for the other, and Paddle's
 * settings sit over defaults a seller configured in its dashboard. A caller who passed nothing must not
 * silently overrule an account that did.
 *
 * Nothing is inferred here. There is no branch that reads the environment, because the option not being
 * set is an answer — take Paddle's default — rather than a question to go and resolve.
 */
function presentationOf(options: PaddleCheckoutOptions | undefined): PaddleCheckoutSettings {
  const presentation: PaddleCheckoutSettings = {};
  if (options?.theme !== undefined) presentation.theme = options.theme;
  if (options?.locale !== undefined) presentation.locale = options.locale;
  if (options?.variant !== undefined) presentation.variant = options.variant;
  return presentation;
}

/**
 * How this checkout is presented, or the refusal that stops it being opened at all.
 *
 * Inline is checked here rather than left to Paddle because of what Paddle does instead. Measured against
 * the live sandbox: `Checkout.open` with a `frameTarget` matching no element throws synchronously, out of
 * the call, with `TypeError: Cannot read properties of undefined (reading 'appendChild')`. That is a real
 * refusal and it is caught below — but it is somebody else's minified stack trace, and the honest thing to
 * tell a screen is that it is missing its container.
 */
function settingsFor(
  handoff: PaddleCheckoutHandoff,
  options: PaddleCheckoutOptions | undefined,
): { settings: PaddleCheckoutSettings } | { failure: PaymentsFailure } {
  const base: PaddleCheckoutSettings = {
    displayMode: handoff.displayMode,
    successUrl: handoff.successUrl,
    ...presentationOf(options),
  };
  if (handoff.displayMode !== "inline") return { settings: base };

  const document = documentOf(options);
  // A server render, not a screen with a missing container. Two different problems for two different
  // people, and answering the wrong one sends an adopter looking in the wrong file.
  if (document === undefined) return { failure: PAYMENTS_NO_BROWSER };

  const frameTarget = options?.frameTarget;
  if (frameTarget === undefined || frameTarget === "") return { failure: PADDLE_NO_CONTAINER };
  if (document.getElementsByClassName(frameTarget).length === 0) return { failure: PADDLE_NO_CONTAINER };

  return {
    settings: {
      ...base,
      frameTarget,
      frameStyle: options?.frameStyle ?? PADDLE_FRAME_STYLE,
      frameInitialHeight: options?.frameInitialHeight ?? PADDLE_FRAME_HEIGHT,
    },
  };
}

/**
 * Open the checkout the server handed back, over this page or inside it.
 *
 * Loads Paddle.js if it is not loaded, from the token and environment on the handoff itself — so a screen
 * needs no second source of truth for which Paddle account it is selling through, and a handoff for one
 * account cannot open against another page's Paddle. Returns null when the checkout opened, and a failure
 * to render otherwise.
 *
 * **The container must be on the page before this is called.** In React that means an effect rather than
 * a click handler: the render that reveals the container has to commit first. `usePaddleCheckout` in
 * `./hooks` is that ordering, written once.
 */
export async function openPaddleCheckout(
  handoff: PaddleCheckoutHandoff,
  options?: PaddleCheckoutOptions,
): Promise<PaymentsFailure | null> {
  const prepared = settingsFor(handoff, options);
  // Before the load, deliberately. A checkout that cannot be rendered should not also fetch a script from
  // a CDN, and the refusal is the same either way.
  if ("failure" in prepared) return prepared.failure;

  const loaded = await loadPaddle({ clientToken: handoff.clientToken, environment: handoff.environment }, options);
  if (!loaded.ok) return loaded.failure;

  try {
    loaded.value.Checkout.open({ transactionId: handoff.transactionId, settings: prepared.settings });
  } catch {
    // Synchronous and void: a throw is Paddle.js's only channel for "I will not open this", and it does
    // use it — a `frameTarget` matching nothing throws a bare `TypeError` about `appendChild`. Left alone
    // that escapes into a buy button as an unhandled rejection.
    return PADDLE_CHECKOUT_REFUSED;
  }
  return null;
}
