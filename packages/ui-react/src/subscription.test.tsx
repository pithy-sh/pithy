// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { bakedTranslator, createTranslator, type Translator } from "@pithy-sh/core/src/i18n/translator";
// The kit's translations, read as the value `@pithy-sh/i18n` composes into its layers rather than as
// files on disk — the same import `signIn.test.tsx` makes, for the same reason.
import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import { PAYMENTS_HOSTED_RAILS, type PaymentsClientRail } from "@pithy-sh/payments/src/client/api";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { failureText } from "../templates/src/payments";
import { SubscriptionScreen } from "../templates/src/routes/pithy/subscription";

/**
 * The scaffolded subscription screen, rendered against one project shape at a time.
 *
 * #336: this screen gated "Manage billing" on `rails.stripe || rails.lemonSqueezy`, so a Paddle-only
 * project scaffolded a subscription page with no way to reach a portal — while the server minted one
 * happily. It was the third hand-written copy of the same list, and the comment above it documented the
 * second time the same thing happened.
 *
 * A source-text assertion cannot catch that class. What the screen *renders* for a given set of enabled
 * rails is the fact, so the file is mounted against a DOM and asked. The loop over
 * `PAYMENTS_HOSTED_RAILS` is what makes it hold for the next rail too: a fourth one added to the package
 * enters this test with it, and if the screen were still naming rails by hand the new member would
 * arrive here with nothing rendering for it.
 */

// React refuses to run `act` unless the environment says it is a test one. See `signIn.test.tsx`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every rail off. Each case switches on exactly what it is about. */
const NONE: Record<PaymentsClientRail, boolean> = {
  apple: false,
  google: false,
  stripe: false,
  lemonSqueezy: false,
  paddle: false,
};

/** A fetch that answers the entitlements read with an empty list and records nothing else. */
const answered: typeof fetch = (async () => Response.json({ entitlements: [] })) as unknown as typeof fetch;

let mounted: { container: HTMLElement; unmount: () => void } | null = null;

async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  return container;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/**
 * Where "see what else there is" is told to point. Not `/paywall`, on purpose: the screen takes the
 * path, and a real one here would pass against a screen that went back to a literal (#393).
 */
const PAYWALL = "/gate-canary-not-the-paywall-path";

/** Render the screen for one project's rails, and hand back the buttons it drew. */
async function buttons(rails: Record<PaymentsClientRail, boolean>): Promise<string[]> {
  const container = await mount(
    <SubscriptionScreen rails={rails} client={{ fetch: answered }} paywallPath={PAYWALL} />,
  );
  // The loading branch renders no buttons at all, so a test that never resolved the read would report
  // "no Manage billing" and pass the negative cases for the wrong reason. The heading proves it settled.
  expect(container.querySelector("h1"), "the screen is still loading — the read never resolved").not.toBeNull();
  return [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

describe("the scaffolded subscription screen", () => {
  test("the way back to the paywall is the path it is handed, not one of its own", async () => {
    // #393: `<Link to="/paywall">` is the same defect as a redirect written as a literal — it survives
    // the rename and stops answering. The canary is invented here, so a screen that went back to a
    // literal fails rather than agreeing with itself.
    expect(PAYWALL).not.toBe("/paywall");
    const container = await mount(
      <SubscriptionScreen rails={NONE} client={{ fetch: answered }} paywallPath={PAYWALL} />,
    );
    const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toContain(PAYWALL);
  });

  test("offers a way to manage billing on every hosted rail, one at a time", async () => {
    // A floor. If `PAYMENTS_HOSTED_RAILS` were ever empty this loop would assert nothing and pass.
    expect(PAYMENTS_HOSTED_RAILS.length).toBeGreaterThanOrEqual(3);

    for (const rail of PAYMENTS_HOSTED_RAILS) {
      const drawn = await buttons({ ...NONE, [rail]: true });
      expect(drawn, `a ${rail}-only project must be able to reach its billing portal`).toContain("Manage billing");
      mounted?.unmount();
      mounted = null;
    }
  });

  test("offers none when the project sells only inside the app stores", async () => {
    // Not an oversight and not the #336 bug in reverse: a web page cannot open a StoreKit or Play
    // Billing portal, so the two store buttons are the only management there is.
    const drawn = await buttons({ ...NONE, apple: true, google: true });
    expect(drawn).not.toContain("Manage billing");
    expect(drawn).toEqual(["Bought on the App Store", "Bought on Google Play"]);
  });

  test("offers nothing when no rail is on", async () => {
    expect(await buttons(NONE)).toEqual([]);
  });

  test("offers exactly one billing button when several hosted rails are on", async () => {
    // The server picks the rail this caller actually bought on, from the account map. A button per rail
    // would ask the buyer a question they cannot answer.
    const rails = { ...NONE };
    for (const rail of PAYMENTS_HOSTED_RAILS) rails[rail] = true;
    const drawn = await buttons(rails);
    expect(drawn.filter((label) => label === "Manage billing")).toHaveLength(1);
  });
});

/**
 * The same screen, in a second language — and in none.
 *
 * **Both directions, because only one of them was ever asserted.** Every case above states the English,
 * and the English is unchanged by design: a screen that renders `t.t(key)` over its own baked catalog
 * says exactly what the literal said, so the whole set stayed green across the change that introduced
 * the translator. A gate that cannot fail on the work it covers is not covering it.
 *
 * What is actually at stake here is two properties that pull against each other. A project composing
 * `i18n` must render the reader's language — including the *date*, which was `toLocaleDateString()` and
 * therefore followed the device rather than the app. And a project composing nothing must render the
 * English byte for byte, because that is the whole of what makes the capability optional.
 *
 * The Spanish translator is built with the locale's catalog and **no English layer behind it**, which
 * makes these cases stricter than the real render: a key nobody translated falls through to the key
 * itself rather than quietly reading well in English.
 */
describe("the subscription screen's language", () => {
  /** When the entitlement lapses. A day under 13, so the two locales order it differently. */
  const WHEN = "2027-02-01T00:00:00.000Z";

  /** One entitlement that renews, which is the branch carrying a formatted date. */
  const HOLDING = { key: "pro", granted: true, expiresAt: WHEN };

  /** A fetch that answers with {@link HOLDING} and nothing else. */
  const holding: typeof fetch = (async () => Response.json({ entitlements: [HOLDING] })) as unknown as typeof fetch;

  /** Spanish, over the kit's catalog alone. */
  const es: Translator = createTranslator({ catalogLocale: "es", layers: [KIT_CATALOGS.es] });

  /** The screen for one project, with a translator or without one. */
  async function rendered(t?: Translator): Promise<string> {
    const container = await mount(
      <SubscriptionScreen
        rails={{ ...NONE, stripe: true }}
        client={{ fetch: holding }}
        paywallPath={PAYWALL}
        {...(t ? { t } : {})}
      />,
    );
    expect(container.querySelector("h1"), "the screen is still loading — the read never resolved").not.toBeNull();
    return container.textContent ?? "";
  }

  test("renders the words of the language it was handed", async () => {
    const text = await rendered(es);
    // Read from the catalog rather than restated here: a sentence this file wrote down would be a second
    // copy of the Spanish, and the first thing to drift from it.
    for (const key of [
      "payments/subscription.subscribed",
      "payments/subscription.manage",
      "payments/subscription.more",
    ]) {
      const sentence = KIT_CATALOGS.es?.[key];
      expect(sentence, `the kit ships no Spanish for ${key}`).toBeTypeOf("string");
      expect(text, key).toContain(sentence);
    }
    // And it is not quietly English. The anti-vacuity half: every assertion above is a `toContain`, and
    // a screen that ignored its `t` prop would still have to fail this one.
    expect(text).not.toContain("You're subscribed.");
  });

  test("renders the renewal date in the app's language, not the device's", async () => {
    // The one thing no catalog can carry, and the line that was `new Date(…).toLocaleDateString()` —
    // which follows whatever language the *device* is set to. A reader who chose Spanish inside a
    // Spanish app read a date in the language their laptop happened to be in, and on a right-to-left
    // locale the sentence and the number disagreed about direction as well.
    const spanish = new Intl.DateTimeFormat("es").format(new Date(WHEN));
    const english = new Intl.DateTimeFormat("en").format(new Date(WHEN));
    // The precondition that makes the assertion mean anything: the two orderings really do differ, so a
    // date rendered through the device's formatter cannot pass by coincidence.
    expect(spanish).not.toBe(english);

    expect(await rendered(es)).toContain(spanish);
  });

  /**
   * The code the refusing fetch answers with. A real kit code with a real Spanish sentence behind it,
   * looked up rather than written down — a sentence restated here would be the first thing to drift.
   */
  const REFUSED = "payments/entitlement_required";

  /** The English the server puts on the wire. Invented, so no catalog can answer with it by accident. */
  const SERVER_ENGLISH = "pithy-gate-canary-server-said-this";

  /** A worker that refuses the entitlements read the way the real one does: `{ error: { code, message } }`. */
  const refusing: typeof fetch = (async () =>
    Response.json({ error: { code: REFUSED, message: SERVER_ENGLISH } }, { status: 403 })) as unknown as typeof fetch;

  test("a refusal from the server is read in the reader's language, not the wire's", async () => {
    // **The server never localizes an error.** `message` is English permanently — it is simultaneously
    // the operator's diagnostic and the fallback for every client that does not translate. So a screen
    // that renders it raw turns Spanish into English at the exact moment something has gone wrong,
    // which is the moment the words matter most and the moment nothing was ever asserted about.
    const spanish = KIT_CATALOGS.es?.[REFUSED];
    expect(spanish, `the kit ships no Spanish for ${REFUSED}`).toBeTypeOf("string");

    const container = await mount(
      <SubscriptionScreen
        rails={{ ...NONE, stripe: true }}
        client={{ fetch: refusing }}
        paywallPath={PAYWALL}
        t={es}
      />,
    );
    expect(container.querySelector("h1"), "the screen is still loading — the read never resolved").not.toBeNull();
    const text = container.textContent ?? "";
    expect(text, "the failure rendered the server's English under a Spanish page").toContain(spanish);
    expect(text).not.toContain(SERVER_ENGLISH);
  });

  test("with no translator, a refusal reads exactly as the server sent it", async () => {
    // The other direction, and the whole of what keeps the capability optional: a project that never
    // composed `i18n` has no catalog to find the code in, so `t.maybe` misses and the server's own
    // sentence comes through byte for byte — which is what this screen did before any of this existed.
    const container = await mount(
      <SubscriptionScreen rails={{ ...NONE, stripe: true }} client={{ fetch: refusing }} paywallPath={PAYWALL} />,
    );
    expect(container.textContent).toContain(SERVER_ENGLISH);
  });

  test("with no translator at all, renders the English it was scaffolded with", async () => {
    // The other direction, and the one the capability's optionality rests on. `useTranslator` with no
    // provider is a translator over the screen's own baked catalog, so a project that never composed
    // `i18n` must read exactly as it did before any of this existed — including the date, which
    // `bakedTranslator` formats in `en` rather than in the host's locale.
    const text = await rendered();
    expect(text).toContain("You're subscribed.");
    expect(text).toContain("Manage billing");
    expect(text).toContain("See what else there is");
    expect(text).toContain(new Intl.DateTimeFormat("en").format(new Date(WHEN)));
    // And no Spanish leaked into it from a provider nothing mounted.
    expect(text).not.toContain(KIT_CATALOGS.es?.["payments/subscription.subscribed"] ?? "«no es catalog»");
  });
});

describe("a translated server failure renders its values, not its placeholders", () => {
  /**
   * The contract `docs/I18N.md` states is `t.maybe(code, params) ?? message`, and `failureText` used
   * to call it with the code alone. Nothing failed, because no kit throw site passes `params` yet and
   * the shipped `es` catalog names no placeholder — so the day either changes, three payments screens
   * would have rendered `{board}` at a reader instead of the English they were improving on.
   */
  test("the params from the wire reach the catalog's sentence", () => {
    const t = bakedTranslator({ "payments/product_not_found": "No existe {product}." }, "es");
    const failure = {
      code: "payments/product_not_found",
      message: "That product does not exist: pro.",
      action: null,
      params: { product: "pro" },
    };
    expect(failureText(t, failure)).toBe("No existe pro.");
  });

  test("and an untranslated code still falls back to the English the server sent", () => {
    const t = bakedTranslator({}, "es");
    const failure = { code: "payments/product_not_found", message: "That product does not exist.", action: null };
    expect(failureText(t, failure)).toBe("That product does not exist.");
  });
});
