// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type CustomTheme, defaultTheme, resolveTheme, themePresets, widthPx } from "./theme";

describe("resolveTheme — presets", () => {
  test("a bare preset yields its accent + matched palettes and empty branding defaults", () => {
    const theme = resolveTheme("saffron");
    expect(theme.accent).toBe(themePresets.saffron.accent);
    expect(theme.light).toEqual(themePresets.saffron.light);
    expect(theme.dark).toEqual(themePresets.saffron.dark);
    expect(theme).toMatchObject({ appName: "Pithy", logoUrl: "", logoDarkUrl: "", footerAddress: "", links: [] });
  });

  test("each preset resolves to its own palette", () => {
    expect(resolveTheme("midnight").accent).toBe("#3B82F6");
    expect(resolveTheme("forest").light.background).toBe(themePresets.forest.light.background);
    expect(resolveTheme("rose").dark.background).toBe(themePresets.rose.dark.background);
  });

  test("the default theme is the saffron preset", () => {
    expect(defaultTheme).toEqual(resolveTheme("saffron"));
  });
});

describe("resolveTheme — overrides", () => {
  test("an empty override changes nothing", () => {
    expect(resolveTheme("midnight", {})).toEqual(resolveTheme("midnight"));
  });

  test("scalar overrides apply and leave the rest of the preset intact", () => {
    const theme = resolveTheme("saffron", {
      appName: "Acme",
      accent: "#FF0000",
      logoUrl: "https://x/l.png",
      footerAddress: "1 Main St",
    });
    expect(theme).toMatchObject({
      appName: "Acme",
      accent: "#FF0000",
      logoUrl: "https://x/l.png",
      footerAddress: "1 Main St",
    });
    // Untouched fields still come from the preset.
    expect(theme.light).toEqual(themePresets.saffron.light);
    expect(theme.logoDarkUrl).toBe("");
  });

  test("a partial light override deep-merges — only the named color changes, dark is untouched", () => {
    const theme = resolveTheme("midnight", { light: { background: "#FFFFFF" } });
    expect(theme.light.background).toBe("#FFFFFF");
    // Every other light color is still the preset's.
    expect(theme.light.text).toBe(themePresets.midnight.light.text);
    expect(theme.light.separator).toBe(themePresets.midnight.light.separator);
    // The dark palette is entirely the preset's.
    expect(theme.dark).toEqual(themePresets.midnight.dark);
  });

  test("light and dark can be overridden independently and simultaneously", () => {
    const custom: CustomTheme = { light: { text: "#000000" }, dark: { background: "#0A0A0A", text: "#FFFFFF" } };
    const theme = resolveTheme("forest", custom);
    expect(theme.light.text).toBe("#000000");
    expect(theme.light.background).toBe(themePresets.forest.light.background); // preset
    expect(theme.dark.background).toBe("#0A0A0A");
    expect(theme.dark.text).toBe("#FFFFFF");
    expect(theme.dark.separator).toBe(themePresets.forest.dark.separator); // preset
  });

  test("a full palette override replaces every color in that mode", () => {
    const full = {
      background: "#1",
      cardBackground: "#2",
      text: "#3",
      textMuted: "#4",
      textSubtle: "#5",
      separator: "#6",
    };
    const theme = resolveTheme("saffron", { light: full });
    expect(theme.light).toEqual(full);
  });

  test("links and accent override together", () => {
    const links = [{ label: "GitHub", href: "https://github.com/pithy-sh" }];
    const theme = resolveTheme("rose", { accent: "#123456", links });
    expect(theme.accent).toBe("#123456");
    expect(theme.links).toEqual(links);
  });
});

describe("widthPx", () => {
  test("maps the content width to pixels", () => {
    expect(widthPx("narrow")).toBe(600);
    expect(widthPx("wide")).toBe(720);
  });
});
