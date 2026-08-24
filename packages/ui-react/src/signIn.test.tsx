// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthFetch } from "@pithy-sh/auth/src/client/api";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { createTranslator } from "@pithy-sh/core/src/i18n/translator";
// The kit's translations, read as the value `@pithy-sh/i18n` composes into its layers rather than as
// files on disk. A locale directory nobody imported into that map ships to nobody, so this is the set
// of languages a reader can actually be served — see `packages/cli/src/ci/catalogCoverage.test.ts`.
import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
// The screen the magic link comes back to, read rather than restated. This file used to assert
// `callbackURL: "…/callback"` — a literal against a literal, both written on the same afternoon, and
// neither of them the one the router matches. Renaming the screen's path broke the round trip and
// nothing here noticed (#393).
import { path as callbackPath } from "../templates/src/routes/pithy/callback";
import { type AuthProjection, type HumanityCheck, SignInScreen } from "../templates/src/routes/pithy/sign-in";

/**
 * The scaffolded sign-in screen, rendered.
 *
 * This is the first screen every adopter sees, and most of what it has to get right is a *state*: a
 * pending humanity check, a provider switched on with no credential behind it, a server that did not
 * answer. None of those are reachable from an assertion about source text, so the file is rendered
 * against a DOM and driven through its seams.
 *
 * The screen takes its projection, its fetch, its origin and its navigator as props for that reason —
 * `routes/pithy/sign-in.tsx`'s default export is the three lines that wire the real ones in, and
 * nothing here navigates, fetches, or reads a config a Vite build has to produce.
 */

// React refuses to run `act` unless the environment says it is a test one. Stated here rather than in
// a setup file: it is the only thing this file needs from its environment, and the setup file every
// project in this repository loads is about the config directory, not about React.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A projection with the two providers a scaffold most often enables. */
const AUTH: AuthProjection = {
  basePath: "/auth",
  providers: { google: true, github: true, apple: false, facebook: false },
  signUpEnabled: true,
};

/** Every provider on, which is how the marks are checked. */
const ALL_PROVIDERS: AuthProjection = {
  ...AUTH,
  providers: { google: true, github: true, apple: true, facebook: true },
};

/** One call the screen made. */
interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * A fetch that records what was asked and answers from a table.
 *
 * Typed as `AuthFetch` rather than `typeof fetch`, because that is the seam the screen now takes: every
 * request it makes goes through `callAuth`, which declares the slice of `fetch` it uses structurally so
 * one signature holds in a Worker-typed program, in a browser, and here (#370).
 */
function recorder(answers: Record<string, () => Response> = {}): { fetch: AuthFetch; calls: Call[] } {
  const calls: Call[] = [];
  const send: AuthFetch = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: init?.headers ?? {},
    });
    return (answers[url] ?? (() => Response.json({})))();
  };
  return { fetch: send, calls };
}

/** A check that still owes a token, so the gated submit must stay disabled. */
const PENDING: HumanityCheck = {
  widget: <div data-testid="widget" />,
  pending: true,
  attach: (body) => ({ body, headers: {} }),
};

/** A check that has one, and puts it in the body the way the middleware reads it. */
const SATISFIED: HumanityCheck = {
  widget: <div data-testid="widget" />,
  pending: false,
  attach: (body) => ({ body: { ...body, "cf-turnstile-response": "tok" }, headers: {} }),
};

let mounted: { container: HTMLElement; unmount: () => void } | null = null;

function mount(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
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

/** Every element matching, as a real array. */
function all<T extends Element>(container: HTMLElement, selector: string): T[] {
  return [...container.querySelectorAll<T>(selector)];
}

/** The one element matching, or a failure naming the selector. */
function one<T extends Element>(container: HTMLElement, selector: string): T {
  const found = all<T>(container, selector);
  expect(found.length, `expected exactly one ${selector}`).toBe(1);
  return found[0] as T;
}

/** Click, flushing whatever the handler starts. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Type into the email field the way a browser does. */
async function fill(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Submit the form, the way pressing return in the field does. */
async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("one way in", () => {
  test("the only thing the form submits is a magic link", async () => {
    const { fetch: send, calls } = recorder();
    const container = mount(<SignInScreen auth={AUTH} fetch={send} origin="https://app.example" />);

    await fill(one<HTMLInputElement>(container, "input[type=email]"), "someone@example.com");
    await submit(one<HTMLFormElement>(container, "form"));

    expect(calls.map((call) => call.url)).toEqual(["/auth/sign-in/magic-link"]);
    expect(calls[0]?.body).toEqual({
      email: "someone@example.com",
      callbackURL: `https://app.example${callbackPath}`,
    });
  });

  test("nothing on the screen offers a second passwordless path", () => {
    const container = mount(<SignInScreen auth={AUTH} fetch={recorder().fetch} origin="https://app.example" />);
    const words = all(container, "button").map((button) => button.textContent ?? "");
    expect(words.filter((word) => /code/i.test(word))).toEqual([]);
    // One submit, and it is the form's. A second `type="submit"` is a second intent on one screen.
    expect(all(container, "button[type=submit]")).toHaveLength(1);
  });

  test("the answer is the same whether or not the address can sign in", async () => {
    const container = mount(<SignInScreen auth={AUTH} fetch={recorder().fetch} origin="https://app.example" />);
    await fill(one<HTMLInputElement>(container, "input[type=email]"), "nobody@example.com");
    await submit(one<HTMLFormElement>(container, "form"));
    expect(container.textContent).toContain("Check your inbox.");
    expect(container.textContent).toContain("If that address can sign in");
  });
});

describe("the humanity check", () => {
  test("gates the link and leaves every provider alone", () => {
    const container = mount(
      <SignInScreen auth={AUTH} check={PENDING} fetch={recorder().fetch} origin="https://app.example" />,
    );
    expect(one<HTMLButtonElement>(container, "button[type=submit]").disabled).toBe(true);
    const providers = all<HTMLButtonElement>(container, ".auth__provider");
    expect(providers).toHaveLength(2);
    expect(providers.map((button) => button.disabled)).toEqual([false, false]);
  });

  test("is rendered in a host of its own, so the widget has a column to fill", () => {
    const container = mount(
      <SignInScreen auth={AUTH} check={PENDING} fetch={recorder().fetch} origin="https://app.example" />,
    );
    expect(one(container, ".auth__check").querySelector("[data-testid=widget]")).not.toBeNull();
  });

  test("puts its token on the request once it has one", async () => {
    const { fetch: send, calls } = recorder();
    const container = mount(<SignInScreen auth={AUTH} check={SATISFIED} fetch={send} origin="https://app.example" />);
    await fill(one<HTMLInputElement>(container, "input[type=email]"), "someone@example.com");
    await submit(one<HTMLFormElement>(container, "form"));
    expect(calls[0]?.body["cf-turnstile-response"]).toBe("tok");
  });

  test("never gates a provider: the redirect carries no token to check", async () => {
    const followed: string[] = [];
    const { fetch: send, calls } = recorder({
      "/auth/sign-in/social": () => Response.json({ url: "https://accounts.google.com/o/oauth2/auth?client_id=abc" }),
    });
    const container = mount(
      <SignInScreen
        auth={AUTH}
        check={PENDING}
        fetch={send}
        origin="https://app.example"
        redirect={(url) => followed.push(url)}
      />,
    );
    await click(all(container, ".auth__provider")[0] as Element);
    expect(followed).toEqual(["https://accounts.google.com/o/oauth2/auth?client_id=abc"]);
    expect(calls[0]?.body).toEqual({ provider: "google", callbackURL: `https://app.example${callbackPath}` });
  });
});

describe("a provider button is never a control that cannot complete", () => {
  test("an authorization URL naming no client is refused, not followed", async () => {
    const followed: string[] = [];
    const { fetch: send } = recorder({
      // What a provider switched on in config with a blank credential behind it actually answers.
      "/auth/sign-in/social": () => Response.json({ url: "https://accounts.google.com/o/oauth2/auth?client_id=" }),
    });
    const container = mount(
      <SignInScreen auth={AUTH} fetch={send} origin="https://app.example" redirect={(url) => followed.push(url)} />,
    );
    await click(all(container, ".auth__provider")[0] as Element);
    expect(followed).toEqual([]);
    expect(one(container, ".auth__failed").textContent).toContain("not configured");
  });

  test("a server that did not answer says something different", async () => {
    const followed: string[] = [];
    const { fetch: send } = recorder({
      "/auth/sign-in/social": () => new Response("nope", { status: 500 }),
    });
    const container = mount(
      <SignInScreen auth={AUTH} fetch={send} origin="https://app.example" redirect={(url) => followed.push(url)} />,
    );
    await click(all(container, ".auth__provider")[0] as Element);
    expect(followed).toEqual([]);
    expect(one(container, ".auth__failed").textContent).toContain("didn't answer");
  });

  test("a javascript: URL is never handed to the navigator", async () => {
    const followed: string[] = [];
    const { fetch: send } = recorder({
      "/auth/sign-in/social": () => Response.json({ url: "javascript:alert(1)?client_id=abc" }),
    });
    const container = mount(
      <SignInScreen auth={AUTH} fetch={send} origin="https://app.example" redirect={(url) => followed.push(url)} />,
    );
    await click(all(container, ".auth__provider")[0] as Element);
    expect(followed).toEqual([]);
  });

  test("only the providers config switched on are offered at all", () => {
    const container = mount(<SignInScreen auth={AUTH} fetch={recorder().fetch} origin="https://app.example" />);
    expect(all(container, ".auth__provider").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Continue with Google",
      "Continue with GitHub",
    ]);
  });
});

describe("the brand slot", () => {
  test("ships empty, and the layout says so rather than leaving a blank column", () => {
    const container = mount(<SignInScreen auth={AUTH} fetch={recorder().fetch} origin="https://app.example" />);
    expect(all(container, ".auth__brand")).toEqual([]);
    expect(one(container, ".auth").getAttribute("data-brand")).toBe("none");
  });

  test("holds whatever the adopter puts in it, and nothing of Pithy's", () => {
    const container = mount(
      <SignInScreen
        auth={AUTH}
        fetch={recorder().fetch}
        origin="https://app.example"
        brand={<p>Acme keeps nothing.</p>}
      />,
    );
    expect(one(container, ".auth__brand").textContent).toBe("Acme keeps nothing.");
    expect(one(container, ".auth").getAttribute("data-brand")).toBe("set");
  });

  test("the compact mark is a slot of its own, for the widths the panel is not on", () => {
    const container = mount(
      <SignInScreen
        auth={AUTH}
        fetch={recorder().fetch}
        origin="https://app.example"
        brand={<p>Acme</p>}
        mark={<span>ACME</span>}
      />,
    );
    // Both are in the tree at every width; which one is on screen is the stylesheet's answer, never a
    // JavaScript branch on width. A second tree is a second thing to keep correct.
    expect(one(container, ".auth__form-mark").textContent).toBe("ACME");
    expect(one(container, ".auth__brand").textContent).toBe("Acme");
  });

  test("the screen carries no copy about the product it is scaffolded into", () => {
    const container = mount(<SignInScreen auth={AUTH} fetch={recorder().fetch} origin="https://app.example" />);
    expect(container.textContent?.toLowerCase()).not.toContain("pithy");
  });
});

describe("the account line", () => {
  test("is reassurance, not navigation — passwordless has no sign-up screen to point at", () => {
    const container = mount(<SignInScreen auth={AUTH} fetch={recorder().fetch} origin="https://app.example" />);
    const line = one(container, ".auth__signup");
    expect(line.textContent).toContain("Signing in creates one.");
    expect(line.querySelector("a")).toBeNull();
  });

  test("says the other thing when signing in cannot create an account", () => {
    const auth: AuthProjection = { ...AUTH, signUpEnabled: false };
    const container = mount(<SignInScreen auth={auth} fetch={recorder().fetch} origin="https://app.example" />);
    expect(one(container, ".auth__signup").textContent).toBe("Existing accounts only.");
  });
});

describe("the provider marks", () => {
  /** The `<svg>` inside the button for `provider`. */
  function mark(container: HTMLElement, label: string): SVGElement {
    const button = all(container, ".auth__provider").find((element) =>
      element.getAttribute("aria-label")?.endsWith(label),
    );
    expect(button, `no button for ${label}`).toBeDefined();
    const svg = button?.querySelector("svg");
    expect(svg, `${label} ships no mark`).not.toBeNull();
    return svg as SVGElement;
  }

  /** Every color any shape in `svg` is filled with. */
  function fills(svg: SVGElement): string[] {
    return [...svg.querySelectorAll("path, circle")]
      .map((shape) => shape.getAttribute("fill"))
      .filter((value): value is string => value !== null);
  }

  test("every provider the template can render arrives with one", () => {
    const container = mount(<SignInScreen auth={ALL_PROVIDERS} fetch={recorder().fetch} origin="https://x" />);
    for (const label of ["Google", "GitHub", "Apple", "Facebook"]) {
      expect(mark(container, label).tagName.toLowerCase()).toBe("svg");
    }
  });

  test("a mark whose owner forbids recoloring carries its own colors, in both themes", () => {
    const container = mount(<SignInScreen auth={ALL_PROVIDERS} fetch={recorder().fetch} origin="https://x" />);
    // Google's four-color "G". Their brand terms forbid recoloring it, so no part of it may inherit.
    const google = fills(mark(container, "Google"));
    expect(google).toHaveLength(4);
    expect(google.every((value) => /^#[0-9A-Fa-f]{6}$/.test(value))).toBe(true);
    expect(google).not.toContain("currentColor");
    // Meta's "f" is one fixed blue, and the counter inside it is white rather than whatever is behind.
    const facebook = fills(mark(container, "Facebook"));
    expect(facebook).toContain("#1877F2");
    expect(facebook).not.toContain("currentColor");
  });

  test("a mark whose owner permits the two ink colors takes the page's, so it follows the theme", () => {
    const container = mount(<SignInScreen auth={ALL_PROVIDERS} fetch={recorder().fetch} origin="https://x" />);
    expect(fills(mark(container, "GitHub"))).toEqual(["currentColor"]);
    expect(fills(mark(container, "Apple"))).toEqual(["currentColor"]);
  });

  test("a mark is decorative, and the action is on the button", () => {
    const container = mount(<SignInScreen auth={ALL_PROVIDERS} fetch={recorder().fetch} origin="https://x" />);
    for (const label of ["Google", "GitHub", "Apple", "Facebook"]) {
      expect(mark(container, label).getAttribute("aria-hidden")).toBe("true");
    }
    // The visible word is inside the accessible name, so voice control still matches "click Google"
    // (WCAG 2.5.3, Label in Name).
    for (const button of all(container, ".auth__provider")) {
      expect(button.getAttribute("aria-label")).toContain(button.textContent);
    }
  });
});

/**
 * The two invariants this screen holds **per language**, checked in every language the kit ships.
 *
 * Both were asserted in English only, and English is the one language where neither could have been
 * wrong: the copy and the assertion were written on the same afternoon by the same person. A
 * translation is the first time the words change without the screen changing, and it is the first time
 * either invariant can break with nothing in the diff to notice.
 *
 * The screen is driven through its `t` prop with a translator over the locale's catalog **and no
 * English layer behind it**, which is deliberate and makes these cases stricter than the real render.
 * A key with no translation falls through to the key itself — `t.t` returns what it was asked for —
 * so an untranslated `auth/sign_in.provider.label` renders `auth/sign_in.provider.label` as the
 * accessible name, which does not contain `Google`, and the WCAG case below fails naming the language.
 * In production the baked English catches that fall-through and the screen reads fine; here it must
 * not, because "reads fine in English" is exactly the state this is looking for.
 */
describe("every language the kit ships", () => {
  /** The locales `@pithy-sh/i18n` composes. Read, never listed — a language added is a language tested. */
  const LOCALES = Object.keys(KIT_CATALOGS);

  /**
   * The word a sign-in button may not say, in each language.
   *
   * **The rule has to be re-stated per locale, and that is a property of the rule rather than an
   * oversight.** The English case a few describes up forbids `/code/i`, and what it is really enforcing
   * is semantic: this screen offers exactly one way in — the magic link — because two passwordless
   * paths on one screen is two things to explain, two surfaces to rate-limit, and two inboxes' worth of
   * mail for one intent. A substring match cannot carry a meaning across a language. `código` shares no
   * letters with `code` that matter to a regular expression, so the English pattern passes a Spanish
   * screen that offers a code in as many words.
   *
   * So each language names its own word, and a locale with no entry fails the first case below rather
   * than being waved through. That is the whole mechanism: adding French costs one line here, and not
   * adding it costs a red build instead of a silent gap.
   */
  const OTP_WORD: Record<string, RegExp> = {
    // `código` and the unaccented spelling a catalog may arrive with. Not `codificar` or `codigo
    // postal` — neither is a sign-in affordance — but the screen's whole vocabulary is eleven strings,
    // so the loose match costs nothing and the tight one would need re-tightening per catalog edit.
    es: /c[oó]digo/i,
  };

  /** The screen rendered in `locale`, with that locale's catalog as its only layer. */
  function inLocale(locale: string, auth: AuthProjection = ALL_PROVIDERS): HTMLElement {
    const t: Translator = createTranslator({ catalogLocale: locale, layers: [KIT_CATALOGS[locale]] });
    return mount(<SignInScreen auth={auth} t={t} fetch={recorder().fetch} origin="https://x" />);
  }

  test("is a language this file knows the vocabulary of", () => {
    // The forcing function. A locale that ships with nobody having said what "code" is in it would make
    // the second case below vacuous for that language, and vacuous is what passing looks like.
    expect(LOCALES.length, "the kit ships no translation at all").toBeGreaterThanOrEqual(1);
    expect(LOCALES.filter((locale) => OTP_WORD[locale] === undefined)).toEqual([]);
  });

  test("puts the visible word inside the accessible name — WCAG 2.5.3, in every language", () => {
    // Label in Name. The visible word is the brand and is never translated; the sentence around it is.
    // A translation that dropped `{provider}`, or reordered the sentence into something that no longer
    // contains the mark's own word, breaks voice control for every reader of that language — "click
    // Google" matches nothing — and it breaks it silently, because the button still looks right.
    for (const locale of LOCALES) {
      const container = inLocale(locale);
      const buttons = all(container, ".auth__provider");
      expect(buttons, locale).toHaveLength(4);
      for (const button of buttons) {
        expect(button.getAttribute("aria-label"), `${locale}: ${button.textContent}`).toContain(button.textContent);
      }
      mounted?.unmount();
      mounted = null;
    }
  });

  test("offers no second passwordless path, in the words of the language it is offering it in", () => {
    for (const locale of LOCALES) {
      const container = inLocale(locale, AUTH);
      const words = all(container, "button").map((button) => button.textContent ?? "");
      expect(
        words.filter((word) => (OTP_WORD[locale] as RegExp).test(word)),
        locale,
      ).toEqual([]);
      // One submit, and it is the form's — the same statement the English case makes, and it is about
      // structure rather than words, so a translation cannot change the answer. It is repeated here so
      // that a locale-specific screen variant, if one ever lands, is held to it too.
      expect(all(container, "button[type=submit]"), locale).toHaveLength(1);
      mounted?.unmount();
      mounted = null;
    }
  });

  test("renders the language it was handed, so the two cases above are not reading English", () => {
    // The anti-vacuity guard for the whole describe. Every assertion above is a `not` or a `contain`,
    // and both are satisfied by a screen that quietly rendered English — which is precisely what a
    // translator with no catalog would produce. This is the one case that fails if it did.
    for (const locale of LOCALES) {
      const container = inLocale(locale);
      const heading = one(container, "h1").textContent ?? "";
      expect(heading, locale).not.toBe("Welcome.");
      expect(heading.length, locale).toBeGreaterThan(0);
      expect(heading, locale).not.toContain("auth/sign_in");
      mounted?.unmount();
      mounted = null;
    }
  });
});
