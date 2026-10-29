// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nManager, Platform, Pressable, Text } from "react-native";
import { afterEach, describe, expect, test, vi } from "vitest";
import { asyncStorage } from "../testing/async-storage";
import { localization } from "../testing/expo-localization";

const projection = vi.hoisted(() => ({
  value: {
    enabled: true,
    supportedLocales: ["en", "es", "ar"],
    defaultLocale: "en",
    queryParam: "lang",
    storageKey: "pithy.locale",
    browserResolvers: ["query", "account", "storage", "navigator", "server", "default"],
    exceptions: {},
  } as Record<string, unknown>,
}));

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  get i18nProjection() {
    return projection.value;
  },
}));

const EN = { "app/loading": "One moment." } satisfies MessageCatalog;

/**
 * The modules a mount reads, imported after `Platform.OS` is set. The translator comes from the same import, because
 * after `vi.resetModules()` a provider and a hook from two evaluations of one module are two different contexts.
 */
async function load(platform: "ios" | "web") {
  Platform.OS = platform;
  const { useTranslator } = await import("@pithy-sh/i18n/src/react/translator");
  const locale = await import("../templates/src/pithy-locale");
  function Probe(): ReactNode {
    const t = useTranslator(EN);
    return <Text>{t.t("app/loading")}</Text>;
  }
  return { ...locale, Probe };
}

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.resetModules();
  vi.restoreAllMocks();
});

async function mount(platform: "ios" | "web") {
  const { PithyLocale, Probe } = await load(platform);
  await act(async () => {
    render(
      <PithyLocale>
        <Probe />
      </PithyLocale>,
    );
  });
}

describe("on a phone", () => {
  test("the screens render in the device's language", async () => {
    localization.setDevice(["es-MX"]);
    await mount("ios");
    expect(await screen.findByText("Un momento.")).toBeTruthy();
  });

  test("a change of the device's language while the app runs is followed", async () => {
    await mount("ios");
    expect(await screen.findByText("One moment.")).toBeTruthy();
    await act(async () => localization.setDevice(["es"]));
    expect(await screen.findByText("Un momento.")).toBeTruthy();
  });

  test("a choice is honored, remembered in AsyncStorage, and wins on the next launch", async () => {
    const { PithyLocale, Probe, useLocaleChoice } = await load("ios");
    function Picker(): ReactNode {
      const { choose } = useLocaleChoice();
      return (
        <Pressable onPress={() => choose("es")}>
          <Text>español</Text>
        </Pressable>
      );
    }
    await act(async () => {
      render(
        <PithyLocale>
          <Probe />
          <Picker />
        </PithyLocale>,
      );
    });
    await act(async () => fireEvent.click(screen.getByText("español")));
    expect(await screen.findByText("Un momento.")).toBeTruthy();
    expect(asyncStorage.items.get("pithy.locale")).toBe("es");
    cleanup();
    vi.resetModules();
    await mount("ios");
    expect(await screen.findByText("Un momento.")).toBeTruthy();
  });

  test("a language that lays out the other way says the app must restart, and sets the direction for it", async () => {
    const forceRTL = vi.spyOn(I18nManager, "forceRTL");
    localization.setDevice(["ar"]);
    await mount("ios");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Restart the app to finish changing the language.")).toBeTruthy();
    expect(forceRTL).toHaveBeenLastCalledWith(true);
  });

  test("a language laid out the way the app already is asks for nothing", async () => {
    await mount("ios");
    await screen.findByText("One moment.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("with nothing composed", () => {
  test("the screens keep their English and nothing is remembered", async () => {
    projection.value = { enabled: false };
    localization.setDevice(["es"]);
    await mount("ios");
    expect(await screen.findByText("One moment.")).toBeTruthy();
    expect(asyncStorage.items.size).toBe(0);
  });
});

describe("on the web", () => {
  test("the browser's languages decide, and the device's are not read", async () => {
    projection.value = { ...projection.value, enabled: true };
    localization.setDevice(["es"]);
    await mount("web");
    expect(await screen.findByText("One moment.")).toBeTruthy();
  });
});
