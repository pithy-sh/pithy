// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
