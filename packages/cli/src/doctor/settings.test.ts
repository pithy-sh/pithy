// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type {
  CapabilitySettings,
  SettingsAccountReader,
  SettingsEnvironment,
} from "@pithy-sh/core/src/capability/settings";
import { describe, expect, test, vi } from "vitest";
import {
  type CapabilitySettingsOptions,
  checkCapabilitySettings,
  describeSettingsAccount,
  describeSettingsFinding,
  type SettingsAccountConnection,
} from "./settings";

/** A capability carrying only what this check reads — the rest of the contract is not this module's. */
function capability(name: string, settings?: CapabilitySettings): Capability {
  return { name, requiredBindings: [], ...(settings ? { settings } : {}) } as Capability;
}

const environments: SettingsEnvironment[] = [
  { name: "dev", origin: null },
  { name: "prod", origin: "https://api.acme.dev" },
];

const reader: SettingsAccountReader = {
  d1Databases: async () => ["acme-global-email-suppressions"],
  zone: async () => true,
  secret: async () => true,
};

const reachable: SettingsAccountConnection = { state: "reachable", reader };

function options(overrides: Partial<CapabilitySettingsOptions> = {}): CapabilitySettingsOptions {
  return {
    project: "acme",
    workers: [],
    environments: async () => environments,
    connect: async () => reachable,
    ...overrides,
  };
}

describe("discovery", () => {
  test("a capability that declares no check is skipped in silence", async () => {
    const check = await checkCapabilitySettings(
      options({ workers: [{ name: "api", capabilities: [capability("auth"), capability("core")] }] }),
    );
    // `null`, not an empty pass: the question does not arise, which is a different fact from "nothing wrong".
    expect(check).toBeNull();
  });

  test("it keys on the capability instance, so a package with no manifest is still checked", async () => {
    const local = vi.fn(() => []);
    const check = await checkCapabilitySettings(
      options({ workers: [{ name: "api", capabilities: [capability("rating", { local })] }] }),
    );
    expect(local).toHaveBeenCalledTimes(1);
    expect(check?.checked).toEqual([{ worker: "api", capability: "rating" }]);
  });

  test("every Worker's capabilities are run, and each finding names the Worker it came from", async () => {
    const check = await checkCapabilitySettings(
      options({
        workers: [
          {
            name: "api",
            capabilities: [
              capability("email", {
                local: () => [{ setting: "BASE_URL", environment: "prod", problem: "Not a URL.", action: "Fix it." }],
              }),
            ],
          },
          {
            name: "collab",
            capabilities: [
              capability("email", {
                local: () => [{ setting: "fromAddress", environment: null, problem: "No domain.", action: "Fix it." }],
              }),
            ],
          },
        ],
      }),
    );
    expect(check?.findings.map((finding) => `${finding.worker}/${finding.setting}`)).toEqual([
      "api/BASE_URL",
      "collab/fromAddress",
    ]);
  });
});

describe("the local tier", () => {
  test("is handed the project, the Worker, and every declared environment", async () => {
    const local = vi.fn(() => []);
    await checkCapabilitySettings(
      options({ workers: [{ name: "api", capabilities: [capability("email", { local })] }] }),
    );
    expect(local).toHaveBeenCalledWith({ project: "acme", worker: "api", environments });
  });

  test("a finding makes the whole check a fault", async () => {
    const check = await checkCapabilitySettings(
      options({
        workers: [
          {
            name: "api",
            capabilities: [
              capability("email", {
                local: () => [
                  {
                    setting: "BASE_URL",
                    environment: "prod",
                    problem: "Not a URL.",
                    action: "Set email({ baseUrl }).",
                  },
                ],
              }),
            ],
          },
        ],
      }),
    );
    expect(check?.state).toBe("faults");
    expect(check?.findings[0]?.tier).toBe("local");
  });

  test("a check that throws is unchecked, never a pass and never a fault", async () => {
    const check = await checkCapabilitySettings(
      options({
        workers: [
          {
            name: "api",
            capabilities: [
              capability("email", {
                local: () => {
                  throw new Error("the config would not resolve");
                },
              }),
            ],
          },
        ],
      }),
    );
    expect(check?.findings).toEqual([]);
    expect(check?.unchecked).toEqual([{ worker: "api", capability: "email", tier: "local" }]);
    expect(check?.state).toBe("could-not-check");
  });
});

describe("the account tier, three outcomes", () => {
  const withAccount = (account: CapabilitySettings["account"]): CapabilitySettingsOptions =>
    options({
      workers: [{ name: "api", capabilities: [capability("email", { local: () => [], ...(account && { account }) })] }],
    });

  test("reachable and passing: the tier ran, nothing is wrong", async () => {
    const check = await checkCapabilitySettings(withAccount(async () => []));
    expect(check?.account).toEqual({ state: "checked", reason: null });
    expect(check?.findings).toEqual([]);
    expect(check?.state).toBe("ok");
  });

  test("reachable and failing: the finding is a fault like any other", async () => {
    const check = await checkCapabilitySettings(
      withAccount(async () => [
        {
          setting: "acme-global-email-suppressions",
          environment: null,
          problem: "No such D1 database in this account.",
          action: "Run pithy email provision --env dev.",
        },
      ]),
    );
    expect(check?.account).toEqual({ state: "checked", reason: null });
    expect(check?.findings[0]?.tier).toBe("account");
    expect(check?.state).toBe("faults");
  });

  test("unreachable: skipped, never passed, and it establishes nothing", async () => {
    const account = vi.fn(async () => [
      { setting: "zone", environment: null, problem: "Not a zone here.", action: "Add it." },
    ]);
    const check = await checkCapabilitySettings({
      ...withAccount(account),
      connect: async () => ({ state: "skipped", reason: "offline" }),
    });
    expect(account).not.toHaveBeenCalled();
    expect(check?.account).toEqual({ state: "skipped", reason: "offline" });
    expect(check?.findings).toEqual([]);
    // Not a fault: nobody asked, so nothing was established. The exit gate reads `findings`.
    expect(check?.state).toBe("ok");
  });

  test("an account check that throws is unchecked, and the tier still says it was reached", async () => {
    const check = await checkCapabilitySettings(
      withAccount(async () => {
        throw new Error("the account did not answer");
      }),
    );
    expect(check?.account).toEqual({ state: "checked", reason: null });
    expect(check?.unchecked).toEqual([{ worker: "api", capability: "email", tier: "account" }]);
    expect(check?.findings).toEqual([]);
  });

  test("nothing connects when no composed capability declares an account tier", async () => {
    const connect = vi.fn(async () => reachable);
    const check = await checkCapabilitySettings(
      options({ workers: [{ name: "api", capabilities: [capability("email", { local: () => [] })] }], connect }),
    );
    expect(connect).not.toHaveBeenCalled();
    // Not "checked" either — a tier nothing asked for is skipped, with the reason saying so.
    expect(check?.account).toEqual({ state: "skipped", reason: "not-declared" });
  });
});

describe("the environments seam", () => {
  test("is asked per Worker, because an origin is a Worker's own declaration", async () => {
    const resolve = vi.fn(async (worker: string) => [{ name: "prod", origin: `https://${worker}.acme.dev` }]);
    const seen: SettingsEnvironment[][] = [];
    const local = (context: { environments: readonly SettingsEnvironment[] }) => {
      seen.push([...context.environments]);
      return [];
    };
    await checkCapabilitySettings(
      options({
        environments: resolve,
        workers: [
          { name: "api", capabilities: [capability("email", { local })] },
          { name: "collab", capabilities: [capability("email", { local })] },
        ],
      }),
    );
    expect(seen).toEqual([
      [{ name: "prod", origin: "https://api.acme.dev" }],
      [{ name: "prod", origin: "https://collab.acme.dev" }],
    ]);
  });

  test("an environment resolver that throws leaves the Worker unchecked rather than checked against nothing", async () => {
    const check = await checkCapabilitySettings(
      options({
        environments: async () => {
          throw new Error("pithy.config.ts would not load");
        },
        workers: [{ name: "api", capabilities: [capability("email", { local: () => [] })] }],
      }),
    );
    expect(check?.unchecked).toEqual([{ worker: "api", capability: "email", tier: "local" }]);
  });
});

describe("rendering", () => {
  test("a finding names the setting, the environment, the problem, and the action", () => {
    expect(
      describeSettingsFinding({
        worker: "api",
        capability: "email",
        tier: "local",
        setting: "BASE_URL",
        environment: "prod",
        problem: "Not a URL.",
        action: "Run pithy email provision --env prod.",
      }),
    ).toBe("email: BASE_URL (prod) — Not a URL. Run pithy email provision --env prod.");
  });

  test("a finding about every environment at once names none", () => {
    expect(
      describeSettingsFinding({
        worker: "api",
        capability: "email",
        tier: "account",
        setting: "fromAddress",
        environment: null,
        problem: "acme.dev is not a zone on this account.",
        action: "Add the domain to Cloudflare, then onboard it onto Email Service.",
      }),
    ).toBe(
      "email: fromAddress — acme.dev is not a zone on this account. Add the domain to Cloudflare, then onboard it onto Email Service.",
    );
  });

  test("the account tier says which of the three things happened", () => {
    expect(describeSettingsAccount({ state: "checked", reason: null })).toBe("account checks ran");
    expect(describeSettingsAccount({ state: "skipped", reason: "offline" })).toBe(
      "account checks skipped (offline) — nothing here was established about the account",
    );
    expect(describeSettingsAccount({ state: "skipped", reason: "no-credentials" })).toBe(
      "account checks skipped (no Cloudflare credentials) — nothing here was established about the account",
    );
    expect(describeSettingsAccount({ state: "skipped", reason: "unreachable" })).toBe(
      "account checks skipped (the account did not answer) — nothing here was established about the account",
    );
    expect(describeSettingsAccount({ state: "skipped", reason: "not-declared" })).toBe(
      "no capability asks the account anything",
    );
  });
});
