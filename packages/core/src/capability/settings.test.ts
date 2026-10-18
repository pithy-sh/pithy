// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { checkHostEnv, defineHostEnv } from "../workflow/hostEnv";
import { defineCapability } from "./capability";
import {
  allSettings,
  hostEnvFindings,
  SettingsAccountIncomplete,
  type SettingsAccountReader,
  SettingsFinding,
  settingsFindingsBefore,
} from "./settings";

const declaration = defineHostEnv({
  capability: "email",
  env: z.object({
    BASE_URL: z.url().describe("Where the app answers."),
    LINK_TTL_DAYS: z.coerce.number().int().positive().default(90).describe("How long a link lives."),
  }),
  provided: {
    BASE_URL: { kind: "var", name: "BASE_URL", command: "pithy email provision" },
    LINK_TTL_DAYS: { kind: "var", name: "LINK_TTL_DAYS" },
  },
});

describe("a settings finding", () => {
  test("is refused without the action that resolves it", () => {
    const parsed = SettingsFinding.safeParse({
      setting: "BASE_URL",
      environment: "prod",
      problem: "Not a URL.",
      action: "",
    });
    expect(parsed.success).toBe(false);
  });

  test("carries the environment it is about, or null when it is about none", () => {
    const finding = SettingsFinding.parse({
      setting: "fromAddress",
      environment: null,
      problem: "example.com can never be onboarded.",
      action: "Set email({ fromAddress }).",
    });
    expect(finding.environment).toBeNull();
  });

  test("may carry the command that resolves it, and never an empty one (#697)", () => {
    const base = { setting: "EMAIL_SUPPRESSIONS", environment: null, problem: "Missing.", action: "Run it." };
    expect(SettingsFinding.parse({ ...base, fix: "pithy email provision" }).fix).toBe("pithy email provision");
    expect(SettingsFinding.parse(base).fix).toBeUndefined();
    expect(SettingsFinding.safeParse({ ...base, fix: "" }).success).toBe(false);
  });
});

describe("host env problems become settings findings", () => {
  test("each one names the field, the reason, and the thing that fills it", () => {
    const report = checkHostEnv(declaration, { BASE_URL: "nope", LINK_TTL_DAYS: "ninety" });
    const findings = hostEnvFindings(report, "prod");

    expect(findings.map((finding) => finding.setting)).toEqual(["BASE_URL", "LINK_TTL_DAYS"]);
    expect(findings.every((finding) => finding.environment === "prod")).toBe(true);
    // The provider's command, where it names one, is the finding's `fix`; a field nothing writes has none (#697).
    expect(findings.map((finding) => finding.fix)).toEqual(["pithy email provision", undefined]);
    // The provider sentence is the action, so doctor and the host's own refusal say the same words.
    expect(findings[0]?.action).toContain("Var BASE_URL in the host's wrangler.jsonc.");
    expect(findings[0]?.action).toContain("pithy email provision");
    expect(findings[1]?.action).toBe("Var LINK_TTL_DAYS in the host's wrangler.jsonc.");
  });

  test("an env that parses produces none", () => {
    const report = checkHostEnv(declaration, { BASE_URL: "https://api.acme.dev", LINK_TTL_DAYS: "30" });
    expect(hostEnvFindings(report, "prod")).toEqual([]);
  });

  test("every finding it produces satisfies the schema", () => {
    const report = checkHostEnv(declaration, {});
    const findings = hostEnvFindings(report, null);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(SettingsFinding.safeParse(finding).success).toBe(true);
  });
});

describe("the declaration hangs off the capability", () => {
  test("a capability carries its settings check beside its health summary", () => {
    const capability = defineCapability({
      name: "email",
      requiredBindings: [],
      settings: {
        local: () => hostEnvFindings(checkHostEnv(declaration, {}), "dev"),
      },
    });
    expect(
      capability.settings?.local({ project: "acme", worker: "api", workerDirectory: "api", environments: [] }),
    ).toHaveLength(1);
    // Nothing declares an account tier by default — the tier that costs a call is opt-in.
    expect(capability.settings?.account).toBeUndefined();
  });
});

describe("allSettings — two checks on one capability (#728)", () => {
  const context = {
    project: "acme",
    worker: "acme-api",
    workerDirectory: "api",
    environments: [{ name: "prod", origin: null }],
  };
  const finding = (setting: string, environment: string | null = null): SettingsFinding => ({
    setting,
    environment,
    problem: `${setting} is wrong.`,
    action: `Fix ${setting}.`,
  });
  const account = {} as SettingsAccountReader;

  test("runs every check's local tier and every account tier, findings in declaration order", async () => {
    const both = allSettings(
      { local: () => [finding("a")], account: async () => [finding("b")] },
      { local: async () => [finding("c")], account: async () => [finding("d")] },
    );
    expect(await both.local(context)).toEqual([finding("a"), finding("c")]);
    expect(await both.account?.({ ...context, account })).toEqual([finding("b"), finding("d")]);
  });

  test("a check with no account tier contributes none, and no tier at all is declared when none has one", async () => {
    expect(allSettings({ local: () => [] }, { local: () => [] }).account).toBeUndefined();
    const one = allSettings({ local: () => [] }, { local: () => [], account: async () => [finding("x")] });
    expect(await one.account?.({ ...context, account })).toEqual([finding("x")]);
  });

  test("one check that cannot answer costs its environments, never the other check's findings", async () => {
    const both = allSettings(
      {
        local: () => [],
        account: async () => {
          throw new SettingsAccountIncomplete([finding("half", "staging")], [{ environment: "prod", cause: "no db" }]);
        },
      },
      { local: () => [], account: async () => [finding("other")] },
    );
    const run = both.account?.({ ...context, account });
    await expect(run).rejects.toBeInstanceOf(SettingsAccountIncomplete);
    const error = await run?.catch((caught: unknown) => caught);
    expect(settingsFindingsBefore(error)).toEqual([finding("half", "staging"), finding("other")]);
    expect((error as SettingsAccountIncomplete).unanswered).toEqual(["prod"]);
  });

  test("a check that throws outright still leaves the other's findings, and the throw is reported", async () => {
    const both = allSettings(
      { local: () => [], account: async () => [finding("kept")] },
      {
        local: () => [],
        account: async () => {
          throw new Error("account refused");
        },
      },
    );
    const error = await both.account?.({ ...context, account }).catch((caught: unknown) => caught);
    expect(settingsFindingsBefore(error)).toEqual([finding("kept")]);
    expect((error as SettingsAccountIncomplete).unanswered).toEqual(["prod"]);
  });
});
