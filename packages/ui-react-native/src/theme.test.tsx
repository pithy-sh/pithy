// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Appearance, Text, View } from "react-native";
import { afterEach, expect, test, vi } from "vitest";
import { dark, light, type Theme, useTheme } from "../templates/src/theme";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A screen in miniature: a surface and a line of body text, drawn only from the theme's tokens. */
function Card(): ReactNode {
  const theme = useTheme();
  return (
    <View testID="card" style={{ backgroundColor: theme.colors.surface, padding: theme.spacing.md }}>
      <Text style={[theme.type.body, { color: theme.colors.text }]}>{theme.scheme}</Text>
    </View>
  );
}

/** react-native-web writes a hex color into the style attribute as `rgba(...)`. */
function rgba(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 1.00)`;
}

function expectDrawnWith(theme: Theme): void {
  const text = screen.getByText(theme.scheme);
  expect(text.style.color).toBe(rgba(theme.colors.text));
  expect(text.style.fontSize).toBe(`${theme.type.body.fontSize}px`);
  expect(screen.getByTestId("card").style.backgroundColor).toBe(rgba(theme.colors.surface));
}

test("a light device draws with the light palette", () => {
  vi.spyOn(Appearance, "getColorScheme").mockReturnValue("light");
  render(<Card />);
  expectDrawnWith(light);
});

test("a dark device draws with the dark palette", () => {
  vi.spyOn(Appearance, "getColorScheme").mockReturnValue("dark");
  render(<Card />);
  expectDrawnWith(dark);
});

test("the two palettes differ where a reader would see it", () => {
  for (const token of ["background", "surface", "text", "muted"] as const) {
    expect(dark.colors[token], token).not.toBe(light.colors[token]);
  }
});
