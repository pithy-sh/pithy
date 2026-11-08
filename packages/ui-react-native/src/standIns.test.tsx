// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { secureStore } from "@pithy-sh/ui-react-native/testing/expo-secure-store";
import * as aliased from "expo-secure-store";
import { describe, expect, test } from "vitest";
import { secureStore as templateStore } from "../templates/src/transport";
import { secureStore as relative } from "../testing/expo-secure-store";
import { STAND_INS } from "./testing/standIns";

/**
 * A test reaches a stand-in's controls by its package path, `@pithy-sh/ui-react-native/testing/<module>`, and a
 * screen reaches the module by its own name through the alias. Both have to be one module, or the controls a test
 * sets drive a copy nothing renders.
 */
describe("a stand-in imported by its package path", () => {
  test("is the module the alias loads, for every native module that has one", async () => {
    for (const [name, file] of Object.entries(STAND_INS)) {
      const byPackage: unknown = await import(`@pithy-sh/ui-react-native/testing/${file.replace(/\.ts$/, "")}`);
      const byName: unknown = await import(/* @vite-ignore */ name);
      expect(byPackage, name).toBe(byName);
    }
  });

  test("is the module a relative import from the kit reaches", async () => {
    expect(await import("@pithy-sh/ui-react-native/testing/expo-secure-store")).toBe(
      await import("../testing/expo-secure-store"),
    );
    expect(secureStore).toBe(relative);
  });

  test("drives what a template reads", async () => {
    secureStore.items.set("pithy.example", "held");
    expect(await aliased.getItemAsync("pithy.example")).toBe("held");
    expect(await templateStore.getItem("pithy.example")).toBe("held");
    secureStore.failing = true;
    await expect(templateStore.getItem("pithy.example")).rejects.toThrow("The secure store refused.");
  });
});
