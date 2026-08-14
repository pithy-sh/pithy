// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CheckoutOpenOptions } from "@paddle/paddle-js";
import { describe, expect, expectTypeOf, test } from "vitest";
import { PAYMENTS_NO_BROWSER, type PaddleCheckoutHandoff } from "./api";
import {
  openPaddleCheckout,
  PADDLE_CHECKOUT_REFUSED,
  PADDLE_FRAME_HEIGHT,
  PADDLE_FRAME_STYLE,
  PADDLE_NO_CONTAINER,
  type PaddleDocument,
} from "./checkout";
import {
  loadPaddle,
  PADDLE_ACCOUNT_CONFLICT,
  PADDLE_UNAVAILABLE,
  type PaddleCheckoutOpen,
  type PaddleInitializer,
  type PaddleJs,
  type PaddleRegistry,
} from "./paddle";

/**
 * What a checkout may be opened for, and what happens when it cannot be.
 *
 * The load is stubbed in every test here, exactly as in `paddle.test.ts`: nothing reaches Paddle's CDN and
 * `paddle-live` is unreachable by construction, because no test calls the default initializer.
 *
 * The case this file exists for is the first one. `Paddle.Checkout.open` will take an `items[]` array with
 * nothing but the publishable client token, and a checkout opened that way is one whose price and whose
 * buyer the page chose. Every other assertion here is about a screen rendering the wrong thing; that one
 * is about what this kit is willing to let a page decide.
 *
 * It is **not** where ownership is protected, and the distinction matters because the issue got it the
 * other way round. Paddle accepts `customData` beside a `transactionId` too, and overwrites the stamp the
 * server wrote — measured, recorded, and gated in `../rails/paddle/objects.test.ts`. The MAC is what makes
 * a stamp mean anything; this file is about the price and the shape of the call.
 */

/** A handoff as the server mints one. Overlay, which is the configured default. */
const OVERLAY: PaddleCheckoutHandoff = {
  kind: "paddle",
  transactionId: "txn_01hv8wptq8987qeep44cyrewp9",
  clientToken: "test_pithyNotARealClientToken",
  environment: "sandbox",
  displayMode: "overlay",
  successUrl: "https://example.test/welcome",
};

/** The same handoff, for a project configured to render checkout inside its own page. */
const INLINE: PaddleCheckoutHandoff = { ...OVERLAY, displayMode: "inline" };

/** A Paddle.js that records what its checkout was asked to open, and never opens anything. */
function stubPaddle(onOpen?: () => void): PaddleJs & { opened: PaddleCheckoutOpen[] } {
  const opened: PaddleCheckoutOpen[] = [];
  return {
    Initialized: true,
    Environment: { set: () => undefined },
    PricePreview: () => Promise.resolve({}),
    Checkout: {
      open(options: PaddleCheckoutOpen) {
        opened.push(options);
        onOpen?.();
      },
      close: () => undefined,
    },
    opened,
  };
}

/** An initializer answering with a fixed Paddle, or refusing the way a blocked script does. */
function stubInitializer(outcome: PaddleJs | Error): PaddleInitializer {
  return () => (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome));
}

/** A fresh page. Nothing here touches the module's own registry. */
function page(): PaddleRegistry {
  return {};
}

/** A document where exactly the named classes exist, and nothing else does. */
function documentWith(...classes: readonly string[]): PaddleDocument {
  return { getElementsByClassName: (name) => ({ length: classes.includes(name) ? 1 : 0 }) };
}

/** Open a checkout against a fresh page, and hand back both the refusal and what Paddle was asked. */
async function open(
  handoff: PaddleCheckoutHandoff,
  extra: Parameters<typeof openPaddleCheckout>[1] = {},
  paddle = stubPaddle(),
) {
  const failure = await openPaddleCheckout(handoff, {
    initialize: stubInitializer(paddle),
    registry: page(),
    ...extra,
  });
  return { failure, opened: paddle.opened };
}

describe("what the browser is allowed to open a checkout for", () => {
  test("a transaction the server minted, and nothing else — no items, no customData", async () => {
    // The whole security argument of this rail, as an assertion about the object handed to Paddle.js.
    // `items` would let the page choose what is being sold; `customData` would let it choose whose
    // account the purchase binds to, permanently, because the first pairing wins and never rebinds.
    const { failure, opened } = await open(OVERLAY);
    expect(failure).toBeNull();
    expect(opened).toHaveLength(1);
    const only = opened[0];
    if (!only) throw new Error("unreachable");
    expect(Object.keys(only).sort()).toEqual(["settings", "transactionId"]);
    expect(only.transactionId).toBe(OVERLAY.transactionId);
    expect(JSON.stringify(only)).not.toContain("customData");
    expect(JSON.stringify(only)).not.toContain("items");
  });

  test("the type cannot express either of them, so no future caller can add one back", () => {
    // The runtime check above is about this call. This one is about every call there will ever be: the
    // fields are absent from the declaration Paddle.js is reached through, so a screen writing
    // `Checkout.open({ items, customData })` against `PaddleJs` does not compile.
    //
    // **Enforced by `tsc -p tsconfig.client.json`, not by Vitest.** A `expectTypeOf` assertion is a type
    // error and Vitest does not typecheck, so this case is green either way when run alone. The program
    // that fails is the browser one — which is also the program an adopter compiles these files in.
    expectTypeOf<PaddleCheckoutOpen>().not.toHaveProperty("items");
    expectTypeOf<PaddleCheckoutOpen>().not.toHaveProperty("customData");
    // And the narrow declaration is still a real slice of Paddle's own, rather than a shape they refuse.
    expectTypeOf<PaddleCheckoutOpen>().toExtend<CheckoutOpenOptions>();
  });

  test("the success URL is the server's, and it reaches Paddle as the setting Paddle documents", async () => {
    const { opened } = await open(OVERLAY);
    expect(opened[0]?.settings?.successUrl).toBe("https://example.test/welcome");
  });
});

describe("overlay", () => {
  test("opens over the page, naming no container", async () => {
    const { failure, opened } = await open(OVERLAY);
    expect(failure).toBeNull();
    expect(opened[0]?.settings?.displayMode).toBe("overlay");
    // An overlay with a frame target is a checkout Paddle renders into a container that may not exist.
    expect(opened[0]?.settings?.frameTarget).toBeUndefined();
    expect(opened[0]?.settings?.frameStyle).toBeUndefined();
  });

  test("needs no container, and does not consult the document for one", async () => {
    const consulted: string[] = [];
    const { failure } = await open(OVERLAY, {
      document: {
        getElementsByClassName: (name) => {
          consulted.push(name);
          return { length: 0 };
        },
      },
    });
    expect(failure).toBeNull();
    expect(consulted).toEqual([]);
  });
});

describe("inline", () => {
  test("renders into the container the screen named, with the sizing Paddle requires", async () => {
    const { failure, opened } = await open(INLINE, {
      frameTarget: "pithy-checkout",
      document: documentWith("pithy-checkout"),
    });
    expect(failure).toBeNull();
    expect(opened[0]?.settings).toEqual({
      displayMode: "inline",
      frameTarget: "pithy-checkout",
      frameStyle: PADDLE_FRAME_STYLE,
      frameInitialHeight: PADDLE_FRAME_HEIGHT,
      successUrl: OVERLAY.successUrl,
    });
    // The default is not decorative: below 312px Paddle's merchant-of-record footer is cut off, which is
    // a compliance requirement rather than a layout preference.
    expect(PADDLE_FRAME_STYLE).toContain("min-width: 312px");
  });

  test("a screen may size its own frame", async () => {
    const { opened } = await open(INLINE, {
      frameTarget: "pithy-checkout",
      frameStyle: "min-width: 400px;",
      frameInitialHeight: 600,
      document: documentWith("pithy-checkout"),
    });
    expect(opened[0]?.settings?.frameStyle).toBe("min-width: 400px;");
    expect(opened[0]?.settings?.frameInitialHeight).toBe(600);
  });

  test("no container on the page is a refusal, not a checkout rendered into nothing", async () => {
    // Paddle.js finds no element with the class and renders nowhere, silently. The buyer clicks Buy and
    // the page does not change — which is indistinguishable from a broken button.
    const { failure, opened } = await open(INLINE, {
      frameTarget: "pithy-checkout",
      document: documentWith("some-other-thing"),
    });
    expect(failure).toEqual(PADDLE_NO_CONTAINER);
    expect(opened).toEqual([]);
  });

  test("no frame target at all is the same refusal", async () => {
    const { failure, opened } = await open(INLINE, { document: documentWith("pithy-checkout") });
    expect(failure).toEqual(PADDLE_NO_CONTAINER);
    expect(opened).toEqual([]);
  });

  test("no document at all is no browser, not a missing container", async () => {
    // A server render. The two are different problems for different people, and answering "your screen is
    // missing its container" to a Node process would send an adopter looking in the wrong file.
    const { failure, opened } = await open(INLINE, { frameTarget: "pithy-checkout", document: undefined });
    expect(failure).toEqual(PAYMENTS_NO_BROWSER);
    expect(opened).toEqual([]);
  });
});

describe("how it is presented", () => {
  /** The settings object that reached `Paddle.Checkout.open`, or a failure if it never got there. */
  async function settingsOpened(extra: Parameters<typeof openPaddleCheckout>[1] = {}) {
    const { failure, opened } = await open(OVERLAY, extra);
    expect(failure).toBeNull();
    expect(opened).toHaveLength(1);
    const settings = opened[0]?.settings;
    if (!settings) throw new Error("unreachable");
    return settings;
  }

  /** What every overlay checkout carries whatever the caller said. */
  const SERVER_SETTINGS = { displayMode: "overlay", successUrl: OVERLAY.successUrl } as const;

  test("nothing passed is nothing sent — no theme key at all, not a key holding undefined", async () => {
    const settings = await settingsOpened();
    // **`toEqual` is not the assertion here, and cannot be.** Vitest's `toEqual` ignores a property whose
    // value is `undefined`, so `{ theme: undefined }` passes it against `{}`. `Object.keys` and `in` are
    // what tell absence from presence, and that difference is the whole of this case: Paddle's per-checkout
    // settings sit over an account's dashboard configuration, so a key nobody set must not be sent at all.
    expect(Object.keys(settings).sort()).toEqual(["displayMode", "successUrl"]);
    expect("theme" in settings).toBe(false);
    expect("locale" in settings).toBe(false);
    expect("variant" in settings).toBe(false);
    // `toStrictEqual` does check undefined keys, unlike `toEqual`. Belt and braces, and it documents which.
    expect(settings).toStrictEqual(SERVER_SETTINGS);
  });

  test("a theme alone reaches Paddle, and adds nothing else", async () => {
    const settings = await settingsOpened({ theme: "dark" });
    expect(settings).toStrictEqual({ ...SERVER_SETTINGS, theme: "dark" });
    expect(Object.keys(settings).sort()).toEqual(["displayMode", "successUrl", "theme"]);
  });

  test("a locale alone reaches Paddle, and adds nothing else", async () => {
    const settings = await settingsOpened({ locale: "pt-BR" });
    expect(settings).toStrictEqual({ ...SERVER_SETTINGS, locale: "pt-BR" });
    expect(Object.keys(settings).sort()).toEqual(["displayMode", "locale", "successUrl"]);
  });

  test("a variant alone reaches Paddle, and adds nothing else", async () => {
    const settings = await settingsOpened({ variant: "one-page" });
    expect(settings).toStrictEqual({ ...SERVER_SETTINGS, variant: "one-page" });
    expect(Object.keys(settings).sort()).toEqual(["displayMode", "successUrl", "variant"]);
  });

  test("all three together", async () => {
    const settings = await settingsOpened({ theme: "dark", locale: "fr", variant: "one-page" });
    expect(settings).toStrictEqual({
      ...SERVER_SETTINGS,
      theme: "dark",
      locale: "fr",
      variant: "one-page",
    });
    expect(Object.keys(settings).sort()).toEqual(["displayMode", "locale", "successUrl", "theme", "variant"]);
  });

  test("passing undefined explicitly is the same as not passing it", async () => {
    // A screen writes `{ theme: user.theme }` and the user has not chosen one. That is an absence, and it
    // must arrive at Paddle as one — otherwise a dashboard default is overridden by a key nobody meant.
    const settings = await settingsOpened({ theme: undefined, locale: undefined, variant: undefined });
    expect(Object.keys(settings).sort()).toEqual(["displayMode", "successUrl"]);
    expect(settings).toStrictEqual(SERVER_SETTINGS);
  });

  test("the theme is never inferred from the environment", async () => {
    // The tempting shortcut, refused deliberately. The OS preference is not the app's theme: an app with
    // its own toggle would open a light card form over a page the reader set to dark. So a `matchMedia`
    // sitting right there on the global is left alone, and this asserts it rather than trusting the diff.
    const consulted: string[] = [];
    const global = globalThis as { matchMedia?: unknown; getComputedStyle?: unknown };
    const hadMatchMedia = "matchMedia" in global;
    const hadComputedStyle = "getComputedStyle" in global;
    global.matchMedia = (query: string) => {
      consulted.push(query);
      return { matches: true, media: query };
    };
    global.getComputedStyle = () => {
      consulted.push("getComputedStyle");
      return {};
    };
    try {
      const settings = await settingsOpened();
      expect("theme" in settings).toBe(false);
    } finally {
      if (!hadMatchMedia) delete global.matchMedia;
      if (!hadComputedStyle) delete global.getComputedStyle;
    }
    expect(consulted).toEqual([]);
  });

  test("an inline checkout carries them beside its frame settings", async () => {
    const { opened } = await open(INLINE, {
      frameTarget: "pithy-checkout",
      theme: "dark",
      document: documentWith("pithy-checkout"),
    });
    expect(opened[0]?.settings).toStrictEqual({
      displayMode: "inline",
      successUrl: OVERLAY.successUrl,
      theme: "dark",
      frameTarget: "pithy-checkout",
      frameStyle: PADDLE_FRAME_STYLE,
      frameInitialHeight: PADDLE_FRAME_HEIGHT,
    });
  });
});

describe("what it refuses", () => {
  test("a Paddle that never loaded is the failure, and nothing is opened", async () => {
    const failure = await openPaddleCheckout(OVERLAY, {
      initialize: stubInitializer(new Error("blocked")),
      registry: page(),
    });
    expect(failure).toEqual(PADDLE_UNAVAILABLE);
  });

  test("a second Paddle account on one page is refused rather than silently re-pointed", async () => {
    const registry = page();
    const initialize = stubInitializer(stubPaddle());
    await loadPaddle({ clientToken: "live_other", environment: "production" }, { initialize, registry });
    const failure = await openPaddleCheckout(OVERLAY, { initialize, registry });
    expect(failure).toEqual(PADDLE_ACCOUNT_CONFLICT);
  });

  test("Checkout.open throwing is a refusal, not an exception escaping into a click handler", async () => {
    const paddle = stubPaddle(() => {
      throw new Error("Paddle Checkout: something went wrong");
    });
    const { failure } = await open(OVERLAY, {}, paddle);
    expect(failure).toEqual(PADDLE_CHECKOUT_REFUSED);
  });

  test("every refusal is a distinct code, so a screen and a log can tell them apart", () => {
    const codes = [PADDLE_NO_CONTAINER, PADDLE_CHECKOUT_REFUSED, PADDLE_UNAVAILABLE, PAYMENTS_NO_BROWSER].map(
      (failure) => failure.code,
    );
    expect(new Set(codes).size).toBe(codes.length);
    for (const failure of [PADDLE_NO_CONTAINER, PADDLE_CHECKOUT_REFUSED]) {
      expect(failure.code.startsWith("client/")).toBe(true);
      expect(failure.message.length).toBeGreaterThan(0);
      expect(failure.action).not.toBeNull();
    }
  });
});
