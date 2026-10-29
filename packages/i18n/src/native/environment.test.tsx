// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { I18nClientProjection } from "../client/projection";
import { useNegotiatedLocale } from "../react/useNegotiatedLocale";
import { nativeLocaleEnvironment } from "./environment";

/**
 * The native adapter, against stubbed native modules.
 *
 * `expo-localization`, AsyncStorage and `I18nManager` are native modules that only load inside an app, so each is
 * replaced by a stand-in that keeps the one property the adapter relies on: the device's locale list and a way to
 * change it while the app runs, a key-value store that outlives a mount, and a direction fixed at launch that
 * `forceRTL` changes only for the next one. A "launch" here is a mount; the store and the forced direction carry
 * over between mounts the way they carry over between launches on a device.
 */

const native = vi.hoisted(() => {
  type Listener = () => void;
  const listeners = new Set<Listener>();
  const state = {
    /** The device's preferred languages, most preferred first. */
    device: [{ languageTag: "en-US", textDirection: "ltr" as "ltr" | "rtl" }],
    /** AsyncStorage's contents, which survive a remount the way they survive a relaunch. */
    stored: new Map<string, string>(),
    /** What this launch started with. `forceRTL` changes the next launch, never this one. */
    isRTL: false,
    /** What the next launch will start with. */
    forcedRTL: null as boolean | null,
    allowedRTL: null as boolean | null,
    /** How long a read of AsyncStorage takes, so a test can make the device's memory answer last. */
    readDelayMs: 0,
  };
  return {
    state,
    listeners,
    setDevice(tags: { languageTag: string; textDirection: "ltr" | "rtl" }[]) {
      state.device = tags;
      for (const listener of listeners) listener();
    },
    relaunch() {
      if (state.forcedRTL !== null) state.isRTL = state.forcedRTL;
    },
    reset() {
      state.device = [{ languageTag: "en-US", textDirection: "ltr" }];
      state.stored = new Map();
      state.isRTL = false;
      state.forcedRTL = null;
      state.allowedRTL = null;
      state.readDelayMs = 0;
      listeners.clear();
    },
  };
});

vi.mock("expo-localization", () => ({
  getLocales: () => native.state.device,
  // The library's own hook re-renders when the operating system's language changes; this one does the same over the
  // stand-in's listener set.
  useLocales: () =>
    useSyncExternalStore(
      (listener: () => void) => {
        native.listeners.add(listener);
        return () => native.listeners.delete(listener);
      },
      () => native.state.device,
    ),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => {
      if (native.state.readDelayMs > 0) await new Promise((resume) => setTimeout(resume, native.state.readDelayMs));
      return native.state.stored.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      native.state.stored.set(key, value);
    },
  },
}));

vi.mock("react-native", () => ({
  I18nManager: {
    get isRTL() {
      return native.state.isRTL;
    },
    allowRTL: (allow: boolean) => {
      native.state.allowedRTL = allow;
    },
    forceRTL: (force: boolean) => {
      native.state.forcedRTL = force;
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A composed project's projection. */
const config = (): I18nClientProjection => ({
  enabled: true,
  supportedLocales: ["en", "es", "ar"],
  defaultLocale: "en",
  queryParam: "lang",
  storageKey: "pithy.locale",
  browserResolvers: ["query", "account", "storage", "navigator", "server", "default"],
  exceptions: {},
});

interface Reading {
  locale: string;
  source: string | null;
  reloadRequired: boolean;
}

let latest: Reading | null = null;
/** Every catalog that was ever mounted, in order, so a test can see a flash the final reading hides. */
let mounted: string[] = [];
let choose: ((locale: string) => void) | null = null;

function Probe({ projection }: { projection: I18nClientProjection }) {
  const negotiated = useNegotiatedLocale(projection, { environment: nativeLocaleEnvironment });
  latest = {
    locale: negotiated.locale,
    source: negotiated.source === null ? null : negotiated.source.catalogLocale,
    reloadRequired: negotiated.reloadRequired,
  };
  if (latest.source !== null && mounted.at(-1) !== latest.source) mounted.push(latest.source);
  choose = negotiated.choose;
  return null;
}

/** Drop the last reading, so the next launch's first one is the one read. */
function forget(): void {
  latest = null;
}

const DEADLINE_MS = 10_000;

/** One macrotask under `act`, so pending effects, reads and the re-renders they cause all run. */
async function turn(): Promise<void> {
  await act(async () => {
    await new Promise((resume) => setTimeout(resume, 5));
  });
}

/** Wait until the reading satisfies `done`, or fail naming what never happened. */
async function until(done: (reading: Reading) => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (latest === null || !done(latest)) {
    if (Date.now() > deadline) throw new Error(`${what} never happened: ${JSON.stringify(latest)}`);
    await turn();
  }
}

/** Mount the probe: one launch of the app. */
async function launch(projection: I18nClientProjection = config()) {
  native.relaunch();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<Probe projection={projection} />);
  });
  await turn();
  return {
    quit() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  native.reset();
  latest = null;
  mounted = [];
  choose = null;
  document.documentElement.lang = "";
  document.documentElement.dir = "";
});

describe("the device locale", () => {
  test("is the starting locale", async () => {
    native.setDevice([{ languageTag: "es-MX", textDirection: "ltr" }]);
    const app = await launch();
    await until((reading) => reading.source === "es", "The Spanish catalog loading");
    expect(latest?.locale).toBe("es");
    app.quit();
  });

  test("is followed when it changes while the app runs", async () => {
    const app = await launch();
    await until((reading) => reading.source === "en", "The English source");
    native.setDevice([{ languageTag: "es-ES", textDirection: "ltr" }]);
    await until((reading) => reading.source === "es", "Following the device to Spanish");
    expect(latest?.locale).toBe("es");
    app.quit();
  });

  test("a later preference in the device's list is used when the first is not served", async () => {
    native.setDevice([
      { languageTag: "de-DE", textDirection: "ltr" },
      { languageTag: "es-ES", textDirection: "ltr" },
    ]);
    const app = await launch();
    await until((reading) => reading.source !== null, "A source");
    expect(latest?.locale).toBe("es");
    app.quit();
  });

  test("nothing is negotiated before the device's memory has been read", async () => {
    // A remembered Spanish must not be preceded by a flash of the device's English catalog.
    // The store answers well after the English catalog would have loaded, so a negotiation that did not wait for it
    // would mount English first.
    native.state.stored.set("pithy.locale", "es");
    native.state.readDelayMs = 60;
    const app = await launch();
    await until((reading) => reading.source === "es", "The remembered Spanish");
    expect(mounted).toEqual(["es"]);
    expect(native.state.forcedRTL).toBe(false);
    app.quit();
  });
});

describe("choosing a language", () => {
  test("is remembered and restored on the next launch", async () => {
    const first = await launch();
    await until((reading) => reading.source === "en", "The English source");
    await act(async () => choose?.("es"));
    await until((reading) => reading.source === "es", "The chosen Spanish");
    expect(native.state.stored.get("pithy.locale")).toBe("es");
    first.quit();

    forget();
    const second = await launch();
    await until((reading) => reading.source !== null, "A source on the second launch");
    expect(latest?.locale).toBe("es");
    second.quit();
  });

  test("outranks a device locale that changes afterwards", async () => {
    const app = await launch();
    await until((reading) => reading.source === "en", "The English source");
    await act(async () => choose?.("es"));
    await until((reading) => reading.source === "es", "The chosen Spanish");
    native.setDevice([{ languageTag: "ar-EG", textDirection: "rtl" }]);
    await turn();
    expect(latest?.locale).toBe("es");
    app.quit();
  });

  test("a store that refuses a read answers as no memory, and the device's language is used", async () => {
    native.setDevice([{ languageTag: "es-AR", textDirection: "ltr" }]);
    native.state.stored.get = () => {
      throw new Error("The store is locked.");
    };
    const app = await launch();
    await until((reading) => reading.source === "es", "The device's Spanish");
    app.quit();
  });

  test("a store that refuses still gets the reader the language", async () => {
    native.state.stored.set = () => {
      throw new Error("The disk is full.");
    };
    const app = await launch();
    await until((reading) => reading.source === "en", "The English source");
    await act(async () => choose?.("es"));
    await until((reading) => reading.source === "es", "The chosen Spanish");
    app.quit();
  });
});

describe("right to left", () => {
  test("an RTL device locale forces RTL and says a reload is needed", async () => {
    native.setDevice([{ languageTag: "ar-EG", textDirection: "rtl" }]);
    const app = await launch();
    await until((reading) => reading.locale === "ar", "Negotiating Arabic");
    expect(native.state.allowedRTL).toBe(true);
    expect(native.state.forcedRTL).toBe(true);
    expect(latest?.reloadRequired).toBe(true);
    app.quit();
  });

  test("after the reload the layout is RTL and nothing more is asked", async () => {
    native.setDevice([{ languageTag: "ar-EG", textDirection: "rtl" }]);
    const first = await launch();
    await until((reading) => reading.locale === "ar", "Negotiating Arabic");
    first.quit();

    forget();
    const second = await launch();
    await until((reading) => reading.locale === "ar", "Negotiating Arabic again");
    expect(native.state.isRTL).toBe(true);
    expect(latest?.reloadRequired).toBe(false);
    second.quit();
  });

  test("choosing an LTR language in an RTL launch turns RTL off and says a reload is needed", async () => {
    native.state.isRTL = true;
    native.state.forcedRTL = true;
    native.setDevice([{ languageTag: "ar-EG", textDirection: "rtl" }]);
    const app = await launch();
    await until((reading) => reading.locale === "ar", "Negotiating Arabic");
    expect(latest?.reloadRequired).toBe(false);
    await act(async () => choose?.("es"));
    await until((reading) => reading.locale === "es", "The chosen Spanish");
    expect(native.state.forcedRTL).toBe(false);
    expect(native.state.allowedRTL).toBe(false);
    expect(latest?.reloadRequired).toBe(true);
    app.quit();
  });

  test("an LTR locale in an LTR launch needs no reload", async () => {
    const app = await launch();
    await until((reading) => reading.source === "en", "The English source");
    expect(latest?.reloadRequired).toBe(false);
    app.quit();
  });
});

describe("the native path leaves the browser alone", () => {
  test("no `lang` or `dir` is written to a document", async () => {
    native.setDevice([{ languageTag: "ar-EG", textDirection: "rtl" }]);
    const app = await launch();
    await until((reading) => reading.locale === "ar", "Negotiating Arabic");
    expect(document.documentElement.lang).toBe("");
    expect(document.documentElement.dir).toBe("");
    app.quit();
  });

  test("a `?lang=` in the page's address is not a signal", async () => {
    window.history.replaceState({}, "", "/?lang=es");
    const app = await launch();
    await until((reading) => reading.source !== null, "A source");
    expect(latest?.locale).toBe("en");
    app.quit();
    window.history.replaceState({}, "", "/");
  });
});

describe("a project that never composed the capability", () => {
  test("reads nothing, forces no direction, and asks for no reload", async () => {
    native.setDevice([{ languageTag: "ar-EG", textDirection: "rtl" }]);
    const app = await launch({ enabled: false });
    await turn();
    expect(latest?.locale).toBe("en");
    expect(latest?.source).toBeNull();
    expect(latest?.reloadRequired).toBe(false);
    expect(native.state.forcedRTL).toBeNull();
    app.quit();
  });
});
