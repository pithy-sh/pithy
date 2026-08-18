// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { checkHostEnv, defineHostEnv } from "../workflow/hostEnv";
import { defineCapability } from "./capability";
import { hostEnvFindings, SettingsFinding } from "./settings";

const declaration = defineHostEnv({
  capability: "email",
  env: z.object({
    BASE_URL: z.url().describe("Where the app answers."),
    LINK_TTL_DAYS: z.coerce.number().int().positive().default(90).describe("How long a link lives."),
  }),
  provided: {
    BASE_URL: { kind: "var", name: "BASE_URL", command: "pithy email provision --env dev" },
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
});

describe("host env problems become settings findings", () => {
  test("each one names the field, the reason, and the thing that fills it", () => {
    const report = checkHostEnv(declaration, { BASE_URL: "nope", LINK_TTL_DAYS: "ninety" });
    const findings = hostEnvFindings(report, "prod");

    expect(findings.map((finding) => finding.setting)).toEqual(["BASE_URL", "LINK_TTL_DAYS"]);
    expect(findings.every((finding) => finding.environment === "prod")).toBe(true);
    // The provider sentence is the action, so doctor and the host's own refusal say the same words.
    expect(findings[0]?.action).toContain("Var BASE_URL in the host's wrangler.jsonc.");
    expect(findings[0]?.action).toContain("pithy email provision --env dev");
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
    expect(capability.settings?.local({ project: "acme", worker: "api", environments: [] })).toHaveLength(1);
    // Nothing declares an account tier by default — the tier that costs a call is opt-in.
    expect(capability.settings?.account).toBeUndefined();
  });
});
