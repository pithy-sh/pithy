// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The React Native templates `pithy ui add react-native` copies into an Expo app.
 *
 * A template library, not a runtime library: it ships text, and nothing imports it at runtime except the CLI's
 * scaffolder. The screens need React Native's toolchain to be checked — its types, a program with no DOM lib, and
 * `react-native-web` to render them under test — so they live here with it rather than in the CLI.
 *
 * The tree mirrors the scaffolded layout exactly, so a template's relative imports resolve here as they will in
 * the app, and the whole library typechecks in place.
 */

/** Absolute path to the template tree. Resolved from this module, so it holds in a workspace and once published. */
export const TEMPLATE_DIR: string = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

/**
 * The named file groups this library offers, each keyed by path within {@link TEMPLATE_DIR}, grouped as
 * `@pithy-sh/ui-react`'s are so a screen set maps one to one.
 *
 * `base` is written on every scaffold: the Expo app's entry and config, the router, the transport, the locale and
 * the theme. Every other group is a screen set that rides on a capability being composed, with the helpers only
 * those screens use. The home screen is not in a group: {@link HOME_SCREEN} picks one of its two variants.
 *
 * Tests for these files live in this package's `src/`, not in the tree, so nothing here is a test.
 */
export const TEMPLATE_GROUPS = {
  base: [
    "app.config.ts",
    "metro.config.js",
    "metro-proxy.cjs",
    "tsconfig.json",
    "app/_layout.tsx",
    "app/index.tsx",
    "app/[...pithy].tsx",
    "src/theme.ts",
    "src/platform.ts",
    "src/pithy-config.ts",
    "src/pithy-config.generated.ts",
    "src/pithy-locale.tsx",
    "src/router.tsx",
    "src/route-modules.ts",
    "src/transport.ts",
  ],
  auth: [
    "src/session.tsx",
    "src/turnstile.tsx",
    "src/useTurnstileWeb.ts",
    "src/routes/pithy/sign-in.tsx",
    "src/routes/pithy/otp.tsx",
    "src/routes/pithy/callback.tsx",
    "src/routes/pithy/account-suspended.tsx",
    "src/routes/pithy/account-deleted.tsx",
    "src/routes/pithy/organization-suspended.tsx",
  ],
  organization: ["src/routes/pithy/choose-organization.tsx", "src/routes/pithy/invitation.tsx"],
  mcp: ["src/routes/pithy/agent-consent.tsx", "src/routes/pithy/connected-applications.tsx"],
  payments: [
    "src/payments.tsx",
    "src/payments-store.ts",
    "src/payments-store.native.ts",
    "src/useStoreTransactions.ts",
    "src/useAppFocus.ts",
    "src/routes/pithy/paywall.tsx",
    "src/routes/pithy/pricing.tsx",
    "src/routes/pithy/subscription.tsx",
  ],
  consent: ["src/routes/pithy/consent.tsx"],
} as const satisfies Record<string, readonly string[]>;

/** One of {@link TEMPLATE_GROUPS}. */
export type TemplateGroup = keyof typeof TEMPLATE_GROUPS;

/**
 * The adopter's own home screen, in two variants: the auth one carries the signed-in guard and a sign-out, the
 * bare one asks the Worker's health route. Exactly one is written, always to the same place.
 */
export const HOME_SCREEN = {
  target: "src/routes/app/home.tsx",
  auth: "src/routes/app/home.tsx",
  bare: "src/routes/app/home.bare.tsx",
} as const;

/** The token the templates use where the name of the Worker the app calls belongs. */
export const WORKER_TOKEN = "__PITHY_WORKER__";

/** The token `app.config.ts` uses where the app's own name belongs: its `apps/<name>` directory. */
export const APP_TOKEN = "__PITHY_APP__";
