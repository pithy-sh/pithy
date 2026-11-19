// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { refusalTransportVerdict } from "./refusalTransport";

/**
 * What an adopter may add to the Better Auth plugins the kit composes, checked when `auth()` is called. It
 * imports no Better Auth runtime, so composing the capability evaluates none.
 */
/**
 * The plugin id, reserved below like the four Better Auth ones.
 *
 * Prefixed because it is the kit's own rather than a dependency's, and an adopter shadowing it would
 * silently win the registration — which for this plugin means silently removing the gate.
 */
export const PROVIDER_SIGN_IN_GATE_ID = "pithy-provider-sign-in-gate";

/**
 * The Better Auth plugins the kit composes for itself, and the reason they are fixed.
 *
 * `magic-link` and `email-otp` are the passwordless email sign-in — no `emailAndPassword` anywhere — and
 * `methods` may leave either out, but never hands its id to an adopter's plugin. `jwt` mints the JWKS the control-plane seam verifies against and
 * `bearer` is how a mobile client presents its credential. `i18n` puts the dependency's own refusals in
 * the reader's language, and {@link PROVIDER_SIGN_IN_GATE_ID} is the kit's own: it decides a refused
 * provider sign-in before Better Auth branches, so the account-enumeration pair is never produced
 * (`./providerSignInGate`). Every one of them is depended on by code outside this package, so an
 * adopter who removed or redefined one would break a contract they cannot see from their config — and
 * for the gate, redefining it *is* removing it. The adopter's list is therefore **additive**: it extends
 * this set, never replaces a member of it.
 */
export const KIT_PLUGIN_IDS = ["i18n", "bearer", "jwt", "magic-link", "email-otp", PROVIDER_SIGN_IN_GATE_ID] as const;

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
    "An additional Better Auth plugin, e.g. `organization()`, `passkey()`, `twoFactor()`. Added to the set the kit composes, never in place of one — and refused when it answers a social sign-in refusal through a response body, which the capability cannot collapse.",
  );

/**
 * Refuse a plugin list the kit cannot compose, naming the offending plugin.
 *
 * Three ways it can fail, and each names a single id because that is what the adopter has to go delete.
 *
 * **Additivity, which is what this function was originally only about.** A plugin whose id is one of
 * {@link KIT_PLUGIN_IDS} would sit beside the kit's own copy (Better Auth merges endpoints by id — the
 * later registration silently wins, so this is a redefinition even when it reads like an addition), and
 * two plugins sharing an id do the same to each other.
 *
 * **And the transport a refusal leaves by.** `../http/providerRefusal` collapses the
 * account-enumeration oracle on the social callback by rewriting the `Location` header, which is the only
 * transport it reads. A plugin that answers a refused callback through a **response body** instead —
 * `oauthPopup()` is the shipped instance — restores the whole oracle with no malformed input anywhere,
 * and no guard on the way in can see it coming. Such a plugin is refused here rather than composed and
 * quietly left uncovered. `./refusalTransport` carries the verdict per plugin, the completeness gate over
 * the dependency's own sources, and the argument for why that rule is a reviewed list rather than a
 * property read off the object.
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
    const verdict = refusalTransportVerdict(plugin.id);
    if (verdict?.outsideLocation === true) {
      throw new ValidationError({
        message: `The auth capability cannot compose the Better Auth "${plugin.id}" plugin.`,
        action: `Remove ${plugin.id}() from auth({ plugins: [...] }). It answers a refused social sign-in through a response body rather than the redirect the capability collapses, which would put back the enumeration oracle that tells a caller whether an account exists at an address a provider handed over.`,
        detail: `plugin "${plugin.id}" answers callback refusals outside the Location header — ${verdict.why}`,
      });
    }
    if (reserved.includes(plugin.id)) {
      throw new ValidationError({
        message: `The auth capability already composes the Better Auth "${plugin.id}" plugin.`,
        action: `Remove ${plugin.id}() from auth({ plugins: [...] }). The ones the kit composes (${KIT_PLUGIN_IDS.join(", ")}) are reserved even when \`methods\` leaves one out; your list adds to them.`,
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
