// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The theme injected into every template: "plug your colors in, point at your logo." Templates render
 * with full **light/dark** support — each mode has its own background, card, text, and separator
 * colors, applied inline for light and swapped in via a `prefers-color-scheme: dark` style block. A
 * single `accent` (saffron) carries through both modes. Visual polish is deliberately secondary to the
 * typed payload contracts — this is enough to brand the starter set well.
 */

export const ContentWidth = z
  .enum(["narrow", "wide"])
  .describe(
    "The email body width: `narrow` (600px — the transactional default) or `wide` (720px — better for newsletters).",
  );
export type ContentWidth = z.output<typeof ContentWidth>;

/** One mode's color set — the surfaces and text shades the templates reference. */
export const Palette = z
  .object({
    background: z.string().describe("The page background behind the card."),
    cardBackground: z.string().describe("The card surface the email content sits on."),
    text: z.string().describe("The primary text/heading color."),
    textMuted: z.string().describe("Secondary body text — summaries, supporting copy."),
    textSubtle: z.string().describe("Tertiary text — the footer and fine print."),
    separator: z.string().describe("The hairline rule color between sections."),
  })
  .describe("A light- or dark-mode color set for the email templates.");
export type Palette = z.output<typeof Palette>;

/** A footer link (social or otherwise). */
export const FooterLink = z
  .object({
    label: z.string().describe("The link text shown in the footer."),
    href: z.string().describe("The absolute URL the footer link points to."),
  })
  .describe("One footer link rendered in the email footer.");
export type FooterLink = z.output<typeof FooterLink>;

export const EmailTheme = z
  .object({
    appName: z.string().describe("The product name shown in the header (when no logo is set) and the footer."),
    accent: z
      .string()
      .describe(
        "The single accent color (hex) for the CTA button and the header rule, in both modes. Defaults to saffron.",
      ),
    logoUrl: z.string().describe("Absolute URL of the light-mode header logo PNG. Empty renders the app name as text."),
    logoDarkUrl: z
      .string()
      .describe(
        "Absolute URL of the dark-mode logo PNG, swapped in under `prefers-color-scheme: dark`. Empty falls back to the light logo / app name.",
      ),
    footerAddress: z
      .string()
      .describe("The physical mailing address shown in the footer — required for marketing (CAN-SPAM) compliance."),
    light: Palette.describe("The light-mode color set, applied inline."),
    dark: Palette.describe("The dark-mode color set, applied via a `prefers-color-scheme: dark` style block."),
    links: z.array(FooterLink).describe("Footer links (e.g. social profiles), rendered as a separated row."),
  })
  .describe("Brand theme for the email templates — light/dark palettes, accent, logo, and the compliance footer.");
export type EmailTheme = z.output<typeof EmailTheme>;

/**
 * A partial override of {@link EmailTheme} — the thin config surface a project tweaks. Every field is
 * optional and deep-merges over the chosen preset, so `customTheme: { accent: "#7C3AED", dark: { background: "#0A0A0A" } }`
 * changes just those values and inherits the rest. Body width is **not** here: it is a property of the
 * template (transactional is narrow, newsletters wide), not the brand.
 */
export const CustomTheme = EmailTheme.partial()
  .extend({
    // Override `light`/`dark` with *partial* palettes so a project can change one color, not the whole set.
    // The scalar fields + `links` are inherited (as optional) from EmailTheme, so this can never drift from it.
    light: Palette.partial().optional().describe("Override individual light-mode palette colors."),
    dark: Palette.partial().optional().describe("Override individual dark-mode palette colors."),
  })
  .describe("A partial, deep-merged override of the chosen theme preset — derived from EmailTheme so it can't drift.");
export type CustomTheme = z.output<typeof CustomTheme>;

/** A named, off-the-shelf palette pair plus its accent — the base a config picks and may override. */
export interface ThemePalettes {
  accent: string;
  light: Palette;
  dark: Palette;
}

/**
 * Off-the-shelf themes a project can pick by name to bootstrap its config (`email({ theme: "midnight" })`),
 * then override piecemeal (`accent`, `light`, `dark`). Each ships a matched light/dark pair so dark mode
 * looks intentional, not auto-inverted. `saffron` is the Pithy default.
 */
export const themePresets = {
  /** Pithy brand — warm parchment/ink, saffron accent. */
  saffron: {
    accent: "#D4A017",
    light: {
      background: "#FAFAF6",
      cardBackground: "#FFFFFF",
      text: "#111111",
      textMuted: "#5F5D57",
      textSubtle: "#9A988F",
      separator: "#E7E5DF",
    },
    dark: {
      background: "#14110D",
      cardBackground: "#1C1813",
      text: "#FAFAF6",
      textMuted: "#A09C90",
      textSubtle: "#6B675E",
      separator: "#2A251E",
    },
  },
  /** Cool, modern neutral with a blue accent — a safe SaaS default. */
  midnight: {
    accent: "#3B82F6",
    light: {
      background: "#F4F6FB",
      cardBackground: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
      textSubtle: "#94A3B8",
      separator: "#E2E8F0",
    },
    dark: {
      background: "#0B1120",
      cardBackground: "#111827",
      text: "#F1F5F9",
      textMuted: "#94A3B8",
      textSubtle: "#64748B",
      separator: "#1E293B",
    },
  },
  /** Calm green — good for product/community mail. */
  forest: {
    accent: "#2F9E6E",
    light: {
      background: "#F3F7F4",
      cardBackground: "#FFFFFF",
      text: "#13231B",
      textMuted: "#4B6358",
      textSubtle: "#8AA597",
      separator: "#DDE8E1",
    },
    dark: {
      background: "#0C140F",
      cardBackground: "#141F18",
      text: "#ECF5EF",
      textMuted: "#9CB6A7",
      textSubtle: "#5F7568",
      separator: "#213028",
    },
  },
  /** Warm rose — softer, friendlier for consumer/lifecycle mail. */
  rose: {
    accent: "#E0567A",
    light: {
      background: "#FBF4F6",
      cardBackground: "#FFFFFF",
      text: "#26101A",
      textMuted: "#6B4451",
      textSubtle: "#B08A95",
      separator: "#F0DDE3",
    },
    dark: {
      background: "#160C10",
      cardBackground: "#20141A",
      text: "#F8EEF1",
      textMuted: "#C29AA6",
      textSubtle: "#7A5662",
      separator: "#33222A",
    },
  },
} satisfies Record<string, ThemePalettes>;

/** The names of the off-the-shelf themes. */
export type ThemePreset = keyof typeof themePresets;

/** The default theme — Pithy brand (`saffron`), parchment/ink light, deep-ink dark, logo-less. */
export const defaultTheme: EmailTheme = {
  appName: "Pithy",
  accent: themePresets.saffron.accent,
  logoUrl: "",
  logoDarkUrl: "",
  footerAddress: "",
  light: themePresets.saffron.light,
  dark: themePresets.saffron.dark,
  links: [],
};

/** Build a full {@link EmailTheme} from a preset plus an optional partial override (deep-merged). */
export function resolveTheme(preset: ThemePreset, custom?: CustomTheme): EmailTheme {
  const base = themePresets[preset];
  const merged: EmailTheme = {
    appName: custom?.appName ?? defaultTheme.appName,
    accent: custom?.accent ?? base.accent,
    logoUrl: custom?.logoUrl ?? "",
    logoDarkUrl: custom?.logoDarkUrl ?? "",
    footerAddress: custom?.footerAddress ?? "",
    light: { ...base.light, ...custom?.light },
    dark: { ...base.dark, ...custom?.dark },
    links: custom?.links ?? [],
  };
  return merged;
}

/** The pixel width the layout uses for a given content width. */
export function widthPx(width: ContentWidth): number {
  return width === "wide" ? 720 : 600;
}
