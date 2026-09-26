// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { TurnstileMode } from "../config/config";

/**
 * Cloudflare's documented Turnstile test keys. dev and staging wire these instead of provisioning a
 * real widget — they need no CF round-trip and make the positive/negative/challenge paths trivially
 * testable. The *sitekeys* are public (the front-end renders with them); the *secrets* feed siteverify.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
export const TURNSTILE_TEST_KEYS = {
  /** Public sitekeys, by widget mode and verdict. */
  sitekey: {
    /** Visible (managed) widget that always passes. */
    visiblePass: "1x00000000000000000000AA",
    /** Visible (managed) widget that always blocks. */
    visibleBlock: "2x00000000000000000000AB",
    /** Invisible widget that always passes. */
    invisiblePass: "1x00000000000000000000BB",
    /** A widget that always forces an interactive challenge. */
    forceChallenge: "3x00000000000000000000FF",
  },
  /** Secret keys for siteverify, by verdict. */
  secret: {
    /** Secret that makes siteverify always pass. */
    pass: "1x0000000000000000000000000000000AA",
    /** Secret that makes siteverify always fail. */
    fail: "2x0000000000000000000000000000000AA",
  },
} as const;

/** The test sitekey for a mode's always-pass widget — what dev and staging render with. */
export function testSitekey(mode: TurnstileMode): string {
  return mode === "visible" ? TURNSTILE_TEST_KEYS.sitekey.visiblePass : TURNSTILE_TEST_KEYS.sitekey.invisiblePass;
}

/** The always-pass test secret — what dev and staging verify against. */
export const TEST_SECRET = TURNSTILE_TEST_KEYS.secret.pass;

/**
 * The environments `provisionTurnstile` **writes** {@link TEST_SECRET} into: dev's secrets file and
 * staging's managed store. `prod` gets a real widget, and no other environment is written at all.
 *
 * Named here rather than spelled at the provisioner, because the gate and the provisioner have to agree
 * about exactly one thing: a key that passes everybody is acceptable only where somebody deliberately put
 * one. `packages/turnstile/src/provision/provisionTurnstile.test.ts` pins the lists together — the
 * provisioner names its environments itself, so that test compares two independent statements rather
 * than one constant with itself.
 */
export const PROVISIONED_TEST_KEY_ENVIRONMENTS = ["dev", "staging"] as const;

/**
 * **Every environment a test key belongs in** — the two provisioning writes it into, and `feature` (#656).
 *
 * A feature deployment is one branch's ephemeral environment. Nothing provisions it: `pithy turnstile
 * provision` runs for the project and writes dev, staging and prod, and `pithy provision --feature` creates
 * the branch's own secrets store empty, because a widget secret is *obtained* from Cloudflare rather than
 * minted. So a feature used to reach the gate with no secret at all and refuse every protected route,
 * sign-in included — with no edit an adopter could have made, since a branch's config is generated per
 * branch and nobody owns it.
 *
 * The pair a feature wants is the pair dev already wires, for the same reason: it is ephemeral, it holds no
 * real users, and a real widget bound to a real domain would be wrong there. So it resolves the documented
 * test pair by default — {@link defaultWidgetSecret} server-side, {@link defaultSitekey} in the build — and
 * the gate accepts that pair's verdict here exactly as it does in dev.
 *
 * **`feature` can only ever mean that.** It is the one stanza key a branch's provisioning writes, and
 * `DeclaredEnvironments` refuses it in a project's own declaration, so no adopter environment can carry the
 * name. A deployed environment that wanted an always-pass gate would have to be called something else, and
 * would get the strict answer.
 */
export const TEST_KEY_ENVIRONMENTS = [...PROVISIONED_TEST_KEY_ENVIRONMENTS, FEATURE_ENVIRONMENT] as const;

/**
 * Whether a Worker's stamped `ENVIRONMENT` is one a test key belongs in.
 *
 * `null` — an unstamped Worker — is **not** one. The environment is the whole of what separates "a key
 * that passes everybody, on purpose, locally" from "a production login page anybody can walk through",
 * so a Worker that cannot say which it is gets the strict answer.
 */
export function isTestKeyEnvironment(environment: string | null): boolean {
  return environment !== null && (TEST_KEY_ENVIRONMENTS as readonly string[]).includes(environment);
}

/**
 * **Whether an environment resolves the documented test pair with nothing provisioned for it** — exactly a
 * feature's, and {@link TEST_KEY_ENVIRONMENTS} is where the argument for that is written down.
 *
 * Private, because the two resolvers below are what callers need: a default is only ever useful together
 * with the value it defaults to, and a predicate on its own invites a third site to decide for itself what
 * an absent key means.
 */
function defaultsToTestKeys(environment: string | null): boolean {
  return environment === FEATURE_ENVIRONMENT;
}

/**
 * The public sitekey a build renders with when the config states none for its environment — the mode's
 * always-pass test key for a feature build, and `undefined` for every other environment.
 *
 * `undefined` is the answer that renders no widget, which is what a blank sitekey has always meant: an
 * environment provisioning has not reached yet must not quietly render a widget that passes everybody.
 */
export function defaultSitekey(environment: string, mode: TurnstileMode): string | undefined {
  return defaultsToTestKeys(environment) ? testSitekey(mode) : undefined;
}

/**
 * The widget secret a gate verifies against when the store holds none — {@link TEST_SECRET} for a feature
 * deployment, and `null` for every other environment, which then refuses.
 *
 * A feature takes this default however the read failed, not only when the row was absent: the environment
 * is ephemeral, its store is created empty on every branch, and the pair this returns is the pair a read
 * that worked would have found. Every other environment keeps the refusal, because "the secret would not
 * resolve" and "let everybody through" must never be the same sentence where real users sign in.
 */
export function defaultWidgetSecret(environment: string | null): string | null {
  return defaultsToTestKeys(environment) ? TEST_SECRET : null;
}
