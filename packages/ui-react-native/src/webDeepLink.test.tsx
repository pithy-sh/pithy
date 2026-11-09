// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ExpoRoot } from "expo-router";
import type { ComponentType, ReactNode } from "react";
import { Text } from "react-native";
import { afterEach, describe, expect, test, vi } from "vitest";
import Layout from "../templates/app/_layout";
import CatchAll from "../templates/app/[...pithy]";
import Index from "../templates/app/index";

/**
 * A deep link opened on the web build lands on its own screen, through the real `expo-router` and its web linking
 * rather than the stand-in the other native tests use. The `web-router` project in `vitest.config.ts` bundles
 * `expo-router` for the browser, with `react-native` as `react-native-web`, the way Metro serves a dev web build.
 *
 * The layout is the scaffolded one, with `<PithyLocale>` over `<Slot />` and a catalog that lands after the first
 * paint. A tree above `<Slot />` that changes shape when the catalog lands remounts the slot, and under `StrictMode`
 * that remount makes `expo-router` replace the deep link with `/`. Each case waits for its screen in Spanish, so it
 * reads the address bar only after the catalog has landed.
 */

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  i18nProjection: {
    enabled: true,
    supportedLocales: ["es"],
    defaultLocale: "es",
    queryParam: "lang",
    storageKey: "pithy.locale",
    // Only the link that reads no global, so the catalog that lands is the one this file names.
    browserResolvers: ["default"],
    exceptions: {},
  },
}));

/** A screen that says its name and the catalog locale it renders through: `en` until the catalog lands. */
function named(name: string): () => ReactNode {
  return function Named(): ReactNode {
    const t = useTranslator();
    return <Text>{`${name} in ${t.catalogLocale}`}</Text>;
  };
}

vi.mock("../templates/src/route-modules", () => ({
  pithyRoutes: [
    async () => ({ path: "/sign-in", default: named("sign-in") }),
    async () => ({ path: "/setup", default: named("setup") }),
  ],
  appRoutes: [async () => ({ path: "/", default: named("home") })],
  sessionModule: undefined,
  paymentsModule: undefined,
  storeTransactions: undefined,
}));

/** The app directory `expo-router` reads, as Metro's `require.context` hands it over. */
const files: Record<string, ComponentType> = { _layout: Layout, "[...pithy]": CatchAll, index: Index };
const appDirectory = Object.assign((key: string) => ({ default: files[key.replace(/^\.\/|\.tsx$/g, "")] }), {
  keys: () => Object.keys(files).map((name) => `./${name}.tsx`),
  resolve: (key: string) => key,
  id: "app",
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

/** Open `path` as a fresh page load. */
async function open(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  await act(async () => {
    // What `ExpoRoot` reads from `window` when its module loads, passed because the module loads once per file.
    render(<ExpoRoot context={appDirectory as never} location={new URL(window.location.href)} />);
  });
}

const SETTLED = { timeout: 10_000 };

describe("a deep link on the web build", () => {
  test("/sign-in opens the sign-in screen and keeps its address", async () => {
    await open("/sign-in");
    expect(await screen.findByText("sign-in in es", undefined, SETTLED)).toBeTruthy();
    expect(window.location.pathname).toBe("/sign-in");
  });

  test("/setup opens the setup screen and keeps its address", async () => {
    await open("/setup");
    expect(await screen.findByText("setup in es", undefined, SETTLED)).toBeTruthy();
    expect(window.location.pathname).toBe("/setup");
  });

  test("an unknown path opens the not-found screen and keeps its address", async () => {
    await open("/no-such-page");
    expect(await screen.findByText("Aquí no hay nada.", undefined, SETTLED)).toBeTruthy();
    expect(window.location.pathname).toBe("/no-such-page");
  });

  test("/ opens home", async () => {
    await open("/");
    expect(await screen.findByText("home in es", undefined, SETTLED)).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });
});
