// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { payments } from "@pithy-sh/payments/src/capability";
import { describe, expect, test, vi } from "vitest";
import {
  checkPaymentsAllowances,
  describePaymentsAllowances,
  namesUnrestricted,
  type PaymentsAllowancesOptions,
} from "./paymentsAllowances";

/** A real payments composition, so the slice this check reads is the shape the capability really has. */
const composed = payments({
  billingSubject: "organization",
  resolveSubject: async () => undefined,
  entitlements: { growth: { name: "Growth", quotas: { emails: 5000, seats: 10 } } },
  defaults: { quotas: { emails: 50 } },
  meters: { emails: { enforce: true } },
});

const auth = { name: "auth" } as unknown as Capability;

function options(overrides: Partial<PaymentsAllowancesOptions> = {}): PaymentsAllowancesOptions {
  return {
    environments: ["staging", "prod"],
    workers: [{ name: "api", dir: "/project/apps/api" }],
    account: null,
    remoteSkip: null,
    composeWorker: async () => ({ capabilities: [auth, composed] }),
    appDatabaseId: async () => "db-1",
    readUnrestricted: async () => [],
    ...overrides,
  };
}

describe("checkPaymentsAllowances", () => {
  test("a project composing no payments reaches nothing and says nothing", async () => {
    const readUnrestricted = vi.fn();
    const check = await checkPaymentsAllowances(
      options({ composeWorker: async () => ({ capabilities: [auth] }), readUnrestricted }),
    );
    expect(check).toEqual({ state: "not-applicable", meters: [], environments: [] });
    expect(readUnrestricted).not.toHaveBeenCalled();
  });

  test("names each meter, whether it is enforced, and whether a quota is declared for it", async () => {
    const check = await checkPaymentsAllowances(options());
    expect(check.meters).toEqual([
      { worker: "api", meter: "emails", enforced: true, quotaDeclared: true },
      { worker: "api", meter: "storageBytes", enforced: false, quotaDeclared: false },
      { worker: "api", meter: "mediaItems", enforced: false, quotaDeclared: false },
    ]);
    expect(describePaymentsAllowances(check)).toContain("api: emails meter enforced; a emails quota is declared.");
  });

  test("names every unrestricted subject, per environment", async () => {
    const check = await checkPaymentsAllowances(
      options({ readUnrestricted: async (id) => (id === "db-1" ? ["organization:acme", "organization:ours"] : []) }),
    );
    expect(check.state).toBe("ok");
    expect(namesUnrestricted(check)).toBe(true);
    expect(describePaymentsAllowances(check).filter((line) => line.includes("unrestricted —"))).toEqual([
      "staging: unrestricted — organization:acme, organization:ours. Every quota unlimited and every feature on, for every name declared now or later.",
      "prod: unrestricted — organization:acme, organization:ours. Every quota unlimited and every feature on, for every name declared now or later.",
    ]);
  });

  test("a skipped or failed read is said out loud, and never reads as nobody unrestricted", async () => {
    const skipped = await checkPaymentsAllowances(options({ remoteSkip: "offline" }));
    expect(skipped.state).toBe("could-not-check");
    expect(describePaymentsAllowances(skipped)).toContain("staging: skipped — offline, so no override was read.");
    const broken = await checkPaymentsAllowances(
      options({
        readUnrestricted: async () => {
          throw new Error("no such table");
        },
      }),
    );
    expect(broken.environments.map((answer) => answer.state)).toEqual(["unreadable", "unreadable"]);
    expect(namesUnrestricted(broken)).toBe(false);
  });

  test("an environment with no database is not provisioned, and is not a failed read", async () => {
    const check = await checkPaymentsAllowances(options({ appDatabaseId: async () => null }));
    expect(check.state).toBe("ok");
    expect(check.environments.map((answer) => answer.state)).toEqual(["not-provisioned", "not-provisioned"]);
  });
});
