// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { KIT_ROOT } from "../test-utils/kitRoot";
import { checkLocalDelivery, describeLocalDelivery } from "./localDelivery";

/**
 * Whether local email delivery is live.
 *
 * The verdict is `pithy dev`'s own preflight, so what is under test here is the wiring: which composed
 * capability answers, that a project composing nothing which sends is silent, and that the lines are
 * relayed rather than reworded.
 */

/** An email capability, minimally what the host registry's `delivery` reads off one. */
const email = (devDelivery: "remote" | "simulator", fromAddress: string): Capability =>
  ({ name: "email", emailConfig: { devDelivery, fromAddress } }) as unknown as Capability;

const scope = (capabilities: Capability[]) => [{ capabilities }];

/** Stands in for a `null` answer, so an assertion on the wording fails on the text rather than on a throw. */
const empty = { live: false, capability: "none", lines: [], hosts: [] };

describe("checkLocalDelivery", () => {
  test("a project composing nothing that sends has no delivery question", async () => {
    const check = await checkLocalDelivery({
      projectDir: KIT_ROOT,
      workers: scope([{ name: "auth" } as Capability]),
      cloudflare: async () => ({ accountId: "acct-1", hasToken: true, mismatch: null }),
    });
    expect(check).toBeNull();
  });

  test("a login and a real sending address read as live, in the preflight's own words", async () => {
    const check = await checkLocalDelivery({
      projectDir: KIT_ROOT,
      workers: scope([email("remote", "hello@acme.dev")]),
      cloudflare: async () => ({ accountId: "acct-1", hasToken: true, mismatch: null }),
    });
    expect(check?.live).toBe(true);
    expect(check?.capability).toBe("email");
    expect(describeLocalDelivery(check ?? empty)).toBe(
      "Email: sending for real from hello@acme.dev, as Cloudflare account acct-1.",
    );
  });

  test("no Cloudflare login is the simulator, and the line carries what fixes it", async () => {
    const check = await checkLocalDelivery({
      projectDir: KIT_ROOT,
      workers: scope([email("remote", "hello@acme.dev")]),
      cloudflare: async () => ({ accountId: null, hasToken: false, mismatch: null }),
    });
    expect(check?.live).toBe(false);
    expect(describeLocalDelivery(check ?? empty)).toContain("using the simulator");
    expect(describeLocalDelivery(check ?? empty)).toContain("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  });

  test("the simulator by config is a choice, reported as one rather than as a failure", async () => {
    const check = await checkLocalDelivery({
      projectDir: KIT_ROOT,
      workers: scope([email("simulator", "hello@acme.dev")]),
      cloudflare: async () => ({ accountId: "acct-1", hasToken: true, mismatch: null }),
    });
    expect(check?.live).toBe(false);
    expect(describeLocalDelivery(check ?? empty)).toContain("by config");
  });

  test("an address on a domain nobody can onboard cannot deliver, login or no login", async () => {
    const check = await checkLocalDelivery({
      projectDir: KIT_ROOT,
      workers: scope([email("remote", "hello@example.com")]),
      cloudflare: async () => ({ accountId: "acct-1", hasToken: true, mismatch: null }),
    });
    expect(check?.live).toBe(false);
    expect(describeLocalDelivery(check ?? empty)).toContain("cannot be onboarded onto Email Service");
  });

  /**
   * **A Worker's own email host is judged by its own config.** `two` owns `DB` and chose the simulator, so its host
   * simulates while the shared one sends for real, and the report gives both, named for their hosts.
   */
  test("a Worker's own host gets its own verdict beside the shared host's", async () => {
    const check = await checkLocalDelivery({
      projectDir: KIT_ROOT,
      workers: [
        { dir: "/p/apps/one", target: { ownBindings: [] }, capabilities: [email("remote", "hello@acme.dev")] },
        { dir: "/p/apps/two", target: { ownBindings: ["DB"] }, capabilities: [email("simulator", "hi@two.dev")] },
      ],
      cloudflare: async () => ({ accountId: "acct-1", hasToken: true, mismatch: null }),
    });
    expect(check?.hosts).toEqual([
      expect.objectContaining({ name: "email", live: true }),
      expect.objectContaining({ name: "two---email", live: false }),
    ]);
    expect(check?.live).toBe(false);
    expect(check?.lines).toEqual([
      "email: Email: sending for real from hello@acme.dev, as Cloudflare account acct-1.",
      "two---email: Email: the simulator, by config. Messages are logged and written to disk, never sent.",
    ]);
  });
});
