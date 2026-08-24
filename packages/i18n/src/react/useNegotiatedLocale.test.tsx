// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { I18nConfig, type I18nConfigInput } from "../config/config";
import { type NegotiatedLocaleOptions, useNegotiatedLocale } from "./useNegotiatedLocale";

/**
 * The hook the README documents and nothing tested.
 *
 * **Rendered on a real root rather than through `renderToStaticMarkup`**, unlike `translator.test.tsx`
 * next door, and the difference is the whole point: every interesting thing this hook does happens in
 * an effect. The catalog arrives by dynamic import, `lang`/`dir` are written after the paint, and
 * `choose` is a state transition. A server render runs none of it, which is exactly how
 * `loadKitCatalog` could be gutted to `{}` and `applyDocumentLocale` to a no-op with 130 tests green.
 *
 * `react-dom/client` plus React's own `act` — no `@testing-library/react`, which is not a dependency of
 * this package and is not added for this.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config = (input: I18nConfigInput = {}): I18nConfig =>
  I18nConfig.parse({ supportedLocales: ["en", "es", "ar"], defaultLocale: "en", ...input });

/** What the probe reports back, flattened into text one assertion can read. */
interface Reading {
  /** The catalog locale in force. */
  locale: string;
  /** `null` until this locale's catalog has landed, then the tag the provider would mount under. */
  source: string | null;
  /** The number of layers the source offers, so a dropped layer is visible. */
  layers: number;
  /** A real kit sentence, looked up through the layers the hook assembled. */
  greeting: string;
}

/** The last reading each mounted probe produced. One probe per mount, so this is never ambiguous. */
let latest: Reading | null = null;

/** The key the reading looks up — a real one, from the kit's own Spanish screens. */
const KEY = "auth/sign_in.title";

function Probe({ config: resolved, options }: { config: I18nConfig; options?: NegotiatedLocaleOptions }) {
  const { source, locale, choose } = useNegotiatedLocale(resolved, options);
  latest = {
    locale,
    source: source === null ? null : `${source.catalogLocale}|${source.formattingLocale}`,
    layers: source?.layers.length ?? 0,
    greeting: source?.layers.find((layer) => layer?.[KEY] !== undefined)?.[KEY] ?? "",
  };
  return (
    <>
      <button type="button" data-pick="es" onClick={() => choose("es")}>
        es
      </button>
      <button type="button" data-pick="ar" onClick={() => choose("ar")}>
        ar
      </button>
    </>
  );
}

/**
 * How long the catalog gets to land, and how long each poll waits.
 *
 * **A deadline in milliseconds, not a count of turns.** Counting turns was the first spelling and it
 * flaked on its first full-repo run: under twenty-five parallel turbo tasks the cold `import()` needed
 * more event-loop turns than a warm one, and fifty of them is well under a second. Ten seconds is two
 * hundred times the measured cold cost and still well inside the suite's 30s budget, so it catches a
 * catalog that never arrives and nothing else.
 */
const SETTLE_DEADLINE_MS = 10_000;
const SETTLE_POLL_MS = 5;

/**
 * Let the catalog's dynamic import land, and the re-render it causes with it.
 *
 * **Waited on rather than assumed.** `source` is `null` until the catalog for the locale in force has
 * arrived, so that transition is the signal — and a fixed wait would be a *silent* flake, because every
 * assertion after it would simply read the previous render. A macrotask per poll rather than a
 * microtask flush: `loadKitCatalog` is a real `import()`, which vitest resolves off the module graph
 * rather than out of the current tick.
 */
async function settle(): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (latest === null || latest.source === null) {
    if (Date.now() > deadline) {
      throw new Error(`The catalog never landed: \`source\` is still null after ${SETTLE_DEADLINE_MS}ms.`);
    }
    await act(async () => {
      await new Promise((resume) => setTimeout(resume, SETTLE_POLL_MS));
    });
  }
}

/** Mount one probe, letting every effect — including the catalog's dynamic import — settle. */
async function mount(resolved: I18nConfig, options?: NegotiatedLocaleOptions) {
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<Probe config={resolved} options={options} />);
  });
  await settle();
  return {
    container,
    /** Click one of the probe's buttons, which calls `choose(locale)`. */
    async choose(locale: string) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-pick="${locale}"]`)?.click();
      });
      await settle();
    },
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

/** Put the page at `path` without navigating — a navigation tears the document down mid-test. */
function at(path: string): void {
  window.history.replaceState({}, "", path);
}

/**
 * A browser that refuses storage: a private window, a site-data block, an embedded view.
 *
 * The whole global is replaced rather than one method spied on. happy-dom serves `localStorage` through
 * a proxy, and `vi.restoreAllMocks()` does not undo a spy installed on one — the throw leaks into every
 * later case in the file, which is how it was found. `vi.unstubAllGlobals()` does undo this.
 */
function blockStorage(): void {
  const refuse = () => {
    throw new Error("The operation is insecure.");
  };
  vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.lang = "";
  document.documentElement.dir = "";
  at("/");
  latest = null;
});

describe("the browser chain, run from a component", () => {
  test("`?lang=es` mounts the kit's Spanish", async () => {
    at("/?lang=es");
    const probe = await mount(config());
    expect(latest?.locale).toBe("es");
    expect(latest?.source).toBe("es|es");
    // The kit's real translation, not a stub: this is what `loadKitCatalog` returning `{}` would lose.
    expect(latest?.greeting).toBeTypeOf("string");
    expect(latest?.greeting.length).toBeGreaterThan(0);
    probe.unmount();
  });

  test("an `es-AR` reader reads the `es` catalog and formats as `es-AR`", async () => {
    // The two locales are two facts. A chosen locale is a catalog locale and carries no region; a
    // negotiated one may be more specific than the catalog it reads, and that specificity is what
    // `Intl` should keep.
    at("/?lang=es-AR");
    const probe = await mount(config());
    expect(latest?.source).toBe("es|es-AR");
    probe.unmount();
  });

  test("the signed-in reader's account outranks this device's memory", async () => {
    // `pithy_auth_users.locale` is the one home for a person's language, so a reader who picked Spanish
    // on their phone must not read English on a laptop whose `localStorage` holds an older choice.
    window.localStorage.setItem("pithy.locale", "en");
    const probe = await mount(config(), { account: "es" });
    expect(latest?.locale).toBe("es");
    probe.unmount();
  });

  test("a `?lang=` that is not a supported locale falls through to the default", async () => {
    at("/?lang=de");
    const probe = await mount(config());
    expect(latest?.locale).toBe("en");
    // English has no kit catalog, so the layer walk finds nothing and every screen keeps its own baked
    // English — which is what a reader in the default locale sees permanently.
    expect(latest?.greeting).toBe("");
    probe.unmount();
  });

  test("a browser that refuses storage still gets a language", async () => {
    blockStorage();
    at("/?lang=es");
    const probe = await mount(config());
    expect(latest?.locale).toBe("es");
    probe.unmount();
  });
});

describe("the document follows", () => {
  test("`lang` and `dir` are written after the paint", async () => {
    at("/?lang=es");
    const probe = await mount(config());
    expect(document.documentElement.lang).toBe("es");
    expect(document.documentElement.dir).toBe("ltr");
    probe.unmount();
  });

  test("a right-to-left reader gets the rtl direction", async () => {
    // The half a suite that only checks words cannot see. An Arabic reader served `dir="ltr"` reads a
    // page laid out backwards, and every assertion about the sentences still passes.
    at("/?lang=ar");
    const probe = await mount(config());
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    probe.unmount();
  });
});

describe("choosing a language", () => {
  test("remembers it on this device, and moves the document with it", async () => {
    const probe = await mount(config());
    expect(latest?.locale).toBe("en");
    await probe.choose("es");
    expect(latest?.locale).toBe("es");
    expect(window.localStorage.getItem("pithy.locale")).toBe("es");
    expect(document.documentElement.lang).toBe("es");
    probe.unmount();
  });

  test("choosing a right-to-left language flips the direction with it", async () => {
    // **The defect this case was written against, and it was live.** The effect took its direction
    // from what the *chain* negotiated rather than from the locale in force, so a reader on an English
    // page who picked Arabic from a language menu got `lang="ar"` with `dir="ltr"`: the words right and
    // the layout backwards. Every assertion about sentences passed either way.
    const probe = await mount(config());
    expect(document.documentElement.dir).toBe("ltr");
    await probe.choose("ar");
    expect(latest?.locale).toBe("ar");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    probe.unmount();
  });

  test("a choice outside `supportedLocales` is ignored rather than mounted", async () => {
    // `choose` is called from a language picker, whose options are the adopter's own markup. A tag the
    // project does not serve would otherwise be written to storage and negotiated on every later visit.
    const monolingual = config({ supportedLocales: ["en"], defaultLocale: "en" });
    const probe = await mount(monolingual);
    await probe.choose("es");
    expect(latest?.locale).toBe("en");
    expect(window.localStorage.getItem("pithy.locale")).toBeNull();
    probe.unmount();
  });

  test("the catalog for the chosen locale is what gets mounted, never the previous one", async () => {
    // Mounting the old catalog under the new tag is a page that says it is Spanish and reads English.
    const probe = await mount(config());
    expect(latest?.greeting).toBe("");
    await probe.choose("es");
    expect(latest?.source).toBe("es|es");
    expect(latest?.greeting.length).toBeGreaterThan(0);
    probe.unmount();
  });
});

describe("the adopter's own catalogs sit above the kit's", () => {
  test("an overridden sentence wins, and everything unmentioned keeps flowing from the package", async () => {
    at("/?lang=es");
    const probe = await mount(config(), { messages: { es: { [KEY]: "Entrar." } } });
    expect(latest?.greeting).toBe("Entrar.");
    // Three layers is the browser walk: this locale's adopter catalog, the default locale's, and the
    // kit's translation. The two English layers a Worker also walks are the composed capabilities',
    // and a copied screen carries its own English instead.
    expect(latest?.layers).toBe(3);
    probe.unmount();
  });
});

describe("choosing a language reaches both homes", () => {
  /**
   * **`account` outranks `storage` in the chain, so something has to keep the account current.**
   *
   * Without the write-through that ordering describes a value nothing updates: a reader picks Spanish
   * on their phone, the phone remembers it, and their laptop keeps answering from its own older memory
   * forever — the exact per-device divergence putting `account` above `storage` exists to prevent. The
   * docs claimed this happened before the code did it, which is worse than the gap.
   */
  const SERVES_ES = config({ supportedLocales: ["en", "es"], defaultLocale: "en" });

  test("the device is remembered and the account is written through", async () => {
    const written: string[] = [];
    const view = await mount(SERVES_ES, { persist: (locale) => void written.push(locale) });
    await view.choose("es");
    expect(window.localStorage.getItem("pithy.locale")).toBe("es");
    expect(written).toEqual(["es"]);
    view.unmount();
  });

  test("with no `persist`, the choice is still remembered on this device", async () => {
    const view = await mount(SERVES_ES);
    await view.choose("es");
    expect(window.localStorage.getItem("pithy.locale")).toBe("es");
    view.unmount();
  });

  test("a locale the project does not serve reaches neither home", async () => {
    // `ar` is the probe's other button and is not in this project's `supportedLocales`.
    const written: string[] = [];
    const view = await mount(SERVES_ES, { persist: (locale) => void written.push(locale) });
    await view.choose("ar");
    expect(window.localStorage.getItem("pithy.locale")).toBeNull();
    expect(written).toEqual([]);
    view.unmount();
  });

  test("a rejected account write does not cost the reader the language", async () => {
    // The switch is a render, not a round trip. A dropped preference is tomorrow's problem, not this
    // visit's, so nothing on screen waits for it and nothing throws out of `choose`.
    const view = await mount(SERVES_ES, { persist: () => Promise.reject(new Error("offline")) });
    await view.choose("es");
    expect(window.localStorage.getItem("pithy.locale")).toBe("es");
    view.unmount();
  });
});
