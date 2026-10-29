import { type TextStyle, useColorScheme } from "react-native";

/**
 * The look every Pithy screen draws with: colors, spacing and type, light and dark. The palette is the one the
 * web screens use, so an app on both reads as one product.
 *
 * Edit the values here and every screen follows. A screen never writes a color or a size of its own; it asks
 * {@link useTheme} for the palette the device is in and reads a token, so a dark device gets the dark palette
 * without a screen branching on it.
 */
export interface Theme {
  /** Light or dark: which palette this is. */
  readonly scheme: "light" | "dark";
  /** Colors, by the job they do. */
  readonly colors: {
    /** Behind everything. */
    readonly background: string;
    /** A raised surface: a card, an input. */
    readonly surface: string;
    /** Body text. */
    readonly text: string;
    /** Secondary text: a hint, a caption. */
    readonly muted: string;
    /** Borders and dividers. */
    readonly border: string;
    /** The one action a screen wants taken. */
    readonly accent: string;
    /** Text drawn on {@link Theme.colors.accent}. */
    readonly onAccent: string;
    /** A failure the reader has to act on. */
    readonly danger: string;
  };
  /** Spacing, in density-independent pixels. */
  readonly spacing: {
    readonly xs: number;
    readonly sm: number;
    readonly md: number;
    readonly lg: number;
    readonly xl: number;
  };
  /** Corner radius for surfaces and buttons. */
  readonly radius: number;
  /** Text styles, by role. Colors are left to the screen, so one style serves both palettes. */
  readonly type: {
    readonly title: TextStyle;
    readonly body: TextStyle;
    readonly caption: TextStyle;
    readonly button: TextStyle;
  };
}

const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

const type = {
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "400" },
  button: { fontSize: 16, lineHeight: 20, fontWeight: "600" },
} as const satisfies Theme["type"];

/** The light palette. */
export const light: Theme = {
  scheme: "light",
  colors: {
    background: "#fafaf6",
    surface: "#ffffff",
    text: "#111111",
    muted: "#5f5d57",
    border: "#e5e3db",
    accent: "#d4a017",
    onAccent: "#111111",
    danger: "#b3261e",
  },
  spacing,
  radius: 10,
  type,
};

/** The dark palette. */
export const dark: Theme = {
  scheme: "dark",
  colors: {
    background: "#111111",
    surface: "#1a1a19",
    text: "#fafaf6",
    muted: "#9a988f",
    border: "#2e2e2b",
    accent: "#d4a017",
    onAccent: "#111111",
    danger: "#f2b8b5",
  },
  spacing,
  radius: 10,
  type,
};

/** The palette for the scheme the device is in now. Re-renders when the device switches. */
export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
