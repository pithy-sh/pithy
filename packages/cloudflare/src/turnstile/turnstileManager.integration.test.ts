// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareTurnstileManager } from "./turnstileManager";

/**
 * LIVE integration test — Turnstile. Two halves: server-side `verify` against `/siteverify` using
 * Cloudflare's documented always-pass / always-fail test secrets (no browser token needed), and the
 * widget management CRUD, where the throwaway resource is a widget deleted in the guaranteed teardown.
 * See `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();

// Cloudflare's published Turnstile testing secret keys — deterministic, no real challenge required.
const ALWAYS_PASSES = "1x0000000000000000000000000000000AA";
const ALWAYS_FAILS = "2x0000000000000000000000000000000AA";

describe.skipIf(!creds.hasCreds)("CloudflareTurnstileManager — LIVE", () => {
  const manager = new CloudflareTurnstileManager({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("verify decodes a passing and a failing siteverify response", async () => {
    // Happy path: the always-pass secret returns success and the decoded shape.
    const ok = await manager.verify("dummy-token", ALWAYS_PASSES);
    expect(ok.success).toBe(true);

    // Error path: the always-fail secret returns success=false with machine-readable error codes.
    const bad = await manager.verify("dummy-token", ALWAYS_FAILS);
    expect(bad.success).toBe(false);
    expect(bad["error-codes"].length).toBeGreaterThan(0);
  });

  test("creates a widget, finds it, verifies against its real secret, updates/rotates, then deletes it", async () => {
    const name = uniqueName("pithy-int-turnstile");

    await withThrowawayResource(
      () => manager.addTurnstile(name, ["example.com"]),
      async (widget) => {
        expect(widget.sitekey).toBeTruthy();
        expect(await manager.validateServiceAccess()).toBe(true);

        // Found by name in the listing (decoded widget shape).
        const found = await manager.getTurnstile(name);
        expect(found?.sitekey).toBe(widget.sitekey);

        // Verify against the REAL widget's secret: a non-solved token can't pass a real widget, so
        // siteverify returns a well-formed denial — proof the freshly-minted secret is recognized.
        const denied = await manager.verify("not-a-solved-token", widget.secret);
        expect(denied.success).toBe(false);
        expect(denied["error-codes"].length).toBeGreaterThan(0);

        // Update domains, then rotate the secret — the rotated secret differs from the original.
        const updated = await manager.updateTurnstileDomains(widget.sitekey, ["example.com", "pithy.sh"], name);
        expect(updated.domains).toContain("pithy.sh");

        const rotated = await manager.rotateTurnstile(widget.sitekey);
        expect(rotated.secret).not.toBe(widget.secret);
      },
      (widget) => manager.deleteTurnstile(widget.sitekey),
    );

    // Error/absent path: the widget is gone after teardown.
    expect(await manager.getTurnstile(name)).toBeNull();
  });

  test("creates a managed (visible) widget in the requested mode, then deletes it", async () => {
    const name = uniqueName("pithy-int-turnstile-managed");

    await withThrowawayResource(
      () => manager.addTurnstile(name, ["example.com"], "managed"),
      async (widget) => {
        expect(widget.sitekey).toBeTruthy();
        expect(widget.mode).toBe("managed");
      },
      (widget) => manager.deleteTurnstile(widget.sitekey),
    );

    expect(await manager.getTurnstile(name)).toBeNull();
  });
});
