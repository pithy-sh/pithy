// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { i18n } from "@better-auth/i18n";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { BetterAuthPlugin } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { magicLink } from "better-auth/plugins/magic-link";
import { z } from "zod";
import { authErrorTranslations } from "../i18n/errorCopy";
import type { SendAuthEmail } from "./auth";

/**
 * The four Better Auth plugins the kit composes for itself, and the reason they are fixed.
 *
 * `magic-link` and `email-otp` **are** the sign-in this product promises — passwordless, no
 * `emailAndPassword` anywhere. `jwt` mints the JWKS the control-plane seam verifies against and
 * `bearer` is how a mobile client presents its credential. Every one of them is depended on by code
 * outside this package, so an adopter who removed or redefined one would break a contract they cannot
 * see from their config. The adopter's list is therefore **additive**: it extends this set, never
 * replaces a member of it.
 */
export const KIT_PLUGIN_IDS = ["i18n", "bearer", "jwt", "magic-link", "email-otp"] as const;

/** What the kit's own plugins need to be constructed. The subset of `AuthInstanceDeps` they read. */
export interface KitPluginDeps {
  /** Magic-link / OTP token lifetime in seconds. */
  verificationExpiresIn: number;
  /** OTP length (digits). */
  otpLength: number;
  /** When true, sign-in never provisions a new user (existing accounts only). */
  disableSignUp: boolean;
  /** Deliver a magic link or OTP. Enqueues an email job; never sends inline. */
  sendEmail: SendAuthEmail;
  /**
   * The catalog locale this request negotiated, or `null`/absent when nothing did.
   *
   * Read from `c.var.locale` where the instance is built, which is per request — so this is the locale
   * the *project* resolved through its own configured chain, never a second negotiation of Better
   * Auth's own. Without that a reader who chose Spanish with `?lang=es` would get Spanish screens and
   * English refusals on the same page, because the two chains ask different signals in different
   * orders (#452).
   *
   * `null` is the ordinary state of a project that never composed `i18n`, and it means English — which
   * is what the plugin answers with anyway, so its absence is not a special case.
   */
  locale?: string | null;
}

/**
 * The kit's four, as a **tuple** rather than an array. Better Auth infers a composed instance's whole
 * `$Infer` surface from the element types of its `plugins` list, so widening this to
 * `BetterAuthPlugin[]` here would erase the adopter's plugin types one line later, where `makeAuth`
 * spreads the two lists together.
 */
export type KitPlugins = [
  // Widened where the other four are not, and it costs nothing: the translator contributes no
  // endpoints and no `$Infer` surface, so there is no adopter-visible type to erase. Its own return
  // type names an internal `MiddlewareOptions` that cannot be named from here, which is a TS4058 on
  // `makeAuth`'s declaration emit rather than anything about the composition.
  BetterAuthPlugin,
  ReturnType<typeof bearer>,
  ReturnType<typeof jwt>,
  ReturnType<typeof magicLink>,
  ReturnType<typeof emailOTP>,
];

/**
 * Build the kit's own plugins. **One definition, two readers**: `makeAuth` composes these into the
 * live instance, and the migration builder composes the same four into the baseline schema it diffs an
 * adopter's plugins against. Two copies of this list would be drift that no test could see — the
 * baseline would claim a table the instance never created, or miss one it did.
 */
export function kitPlugins(deps: KitPluginDeps): KitPlugins {
  return [
    /**
     * Better Auth's own refusals, in the reader's language (#452).
     *
     * **First in the list deliberately.** It works by wrapping the error rendering of the plugins
     * registered around it, so anything composed before it answers in English regardless.
     *
     * `getLocale` is the whole of the integration: one chain, the project's, resolved before this
     * instance was built. The plugin's own `header`/`cookie`/`session` strategies are deliberately
     * unused — each is a second negotiation, and two chains over one page is the bug where the screens
     * and the errors disagree about who is reading.
     */
    i18n({
      translations: authErrorTranslations(),
      detection: ["callback"],
      getLocale: () => deps.locale ?? null,
    }),
    bearer(),
    jwt({ schema: { jwks: { modelName: "pithyAuthJwks" } } }),
    magicLink({
      expiresIn: deps.verificationExpiresIn,
      disableSignUp: deps.disableSignUp,
      sendMagicLink: async ({ email, url, token }) => {
        await deps.sendEmail({ to: email, template: "magicLink", token, url });
      },
    }),
    emailOTP({
      otpLength: deps.otpLength,
      expiresIn: deps.verificationExpiresIn,
      disableSignUp: deps.disableSignUp,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") return;
        await deps.sendEmail({ to: email, template: "otp", code: otp });
      },
    }),
  ];
}

/** Is this value shaped like a Better Auth plugin — an object carrying a non-empty string `id`? */
function isBetterAuthPlugin(value: unknown): value is BetterAuthPlugin {
  if (typeof value !== "object" || value === null) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0;
}

/**
 * One additional Better Auth plugin, validated at the config boundary.
 *
 * `z.custom` rather than a `z.object`, and deliberately: a plugin is a live object carrying endpoints,
 * hooks and an `init` closure, and an object schema would hand back a **copy** — a different object from
 * the one Better Auth was given, with whatever the schema did not name quietly dropped. What can be
 * checked without rebuilding it is checked: it is an object, and it has the `id` every other rule here
 * (reservation, duplication, migration keys, `pithy doctor`) is written in terms of.
 */
export const AuthPlugin = z
  .custom<BetterAuthPlugin>(isBetterAuthPlugin, {
    message: "Expected a Better Auth plugin — an object with a non-empty string `id`.",
  })
  .describe(
    "An additional Better Auth plugin, e.g. `organization()`, `passkey()`, `twoFactor()`. Added to the set the kit composes, never in place of one.",
  );

/**
 * Refuse a plugin list that is not purely additive, naming the offending plugin.
 *
 * Two ways it can fail, and both name a single id because that is what the adopter has to go delete:
 * a plugin whose id is one of {@link KIT_PLUGIN_IDS} would sit beside the kit's own copy (Better Auth
 * merges endpoints by id — the later registration silently wins, so this is a redefinition even when it
 * reads like an addition), and two plugins sharing an id do the same to each other.
 *
 * **The `message` stays short on purpose.** `auth()` runs while `pithy.config.ts` is being imported, so
 * the CLI catches this through `classifyConfigLoadFailure`, which prints the cause's message and nothing
 * else — and drops it entirely past 160 characters (`safeReason`). A refusal whose whole content is in
 * its `action` reaches the adopter as "the config threw while loading", which names nothing.
 */
export function assertAdditivePlugins(plugins: readonly BetterAuthPlugin[]): void {
  const reserved: readonly string[] = KIT_PLUGIN_IDS;
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (reserved.includes(plugin.id)) {
      throw new ValidationError({
        message: `The auth capability already composes the Better Auth "${plugin.id}" plugin.`,
        action: `Remove ${plugin.id}() from auth({ plugins: [...] }). The four the kit composes (${KIT_PLUGIN_IDS.join(", ")}) are the sign-in this product promises and what the control-plane seam verifies against; your list adds to them.`,
        detail: `reserved plugin id "${plugin.id}" supplied through AuthConfig.plugins`,
      });
    }
    if (seen.has(plugin.id)) {
      throw new ValidationError({
        message: `The Better Auth "${plugin.id}" plugin is listed twice in auth({ plugins: [...] }).`,
        action: `Keep one ${plugin.id}() in auth({ plugins: [...] }) — the second registration would silently win over the first.`,
        detail: `duplicate plugin id "${plugin.id}" supplied through AuthConfig.plugins`,
      });
    }
    seen.add(plugin.id);
  }
}
