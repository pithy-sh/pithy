// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SettingsAccountReader, SettingsCheckContext } from "@pithy-sh/core/src/capability/settings";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { email } from "../capability";
import { defaultTheme, type EmailTheme } from "../templates/theme";
import { EmailHostEnv, emailHostEnv } from "../workflows/hostEnv";
import { emailSettings } from "./settingsCheck";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const context = (overrides: Partial<SettingsCheckContext> = {}): SettingsCheckContext => ({
  project: "acme",
  worker: "api",
  environments: [
    { name: "staging", origin: "https://staging.acme.dev" },
    { name: "prod", origin: "https://api.acme.dev" },
  ],
  ...overrides,
});

const config = { fromAddress: "hello@acme.dev", baseUrl: "https://api.acme.dev" };

const reader = (overrides: Partial<SettingsAccountReader> = {}): SettingsAccountReader => ({
  d1Databases: async () => ["acme-global-email-suppressions"],
  zone: async () => true,
  secret: async () => true,
  ...overrides,
});

/**
 * Every `.ts` under the package, relative to `src`, so a source pin names files rather than paths.
 *
 * Node's own recursive listing rather than a walk of our own: `packages/cli/src/ci/sourceFiles.test.ts`
 * refuses a hand-rolled one, and this needs no more than the flat list of names.
 */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort();
}

/**
 * One source file with its comments blanked, so a literal in prose can never stand in for the call.
 *
 * The shared walk (#439). Anchoring to the line start dodged the `//` in a URL and left the other hole
 * open: an unbalanced `/*` inside a glob opens a block that runs to the next `*\/` in the file, and the
 * call this pins would be inside it.
 */
function code(file: string): string {
  return blankComments(readFileSync(join(SRC, file), "utf8"));
}

describe("one schema, two readers", () => {
  test("the declaration the host boots against is the object the check validates through", () => {
    // The runtime half: the declaration and the schema are one object, not a pair that agree today.
    expect(emailHostEnv.env).toBe(EmailHostEnv);
  });

  test("nothing in this package declares a second host env", () => {
    const declaring = sources().filter((file) => readFileSync(join(SRC, file), "utf8").includes("defineHostEnv("));
    expect(declaring).toEqual(["workflows/hostEnv.ts"]);
  });

  test("the host's boot check and doctor's check name the same declaration", () => {
    // Comments stripped first, for the reason `doctorDocs.test.ts` strips them: prose about a call is
    // not the call, and a pin that a doc comment can satisfy pins nothing. A `worker.ts` validating
    // against a differently-provisioned declaration while still *describing* this one would pass.
    expect(code("workflows/worker.ts")).toContain("requireHostEnv(emailHostEnv");
    expect(code("provision/settingsCheck.ts")).toContain("checkHostEnv(emailHostEnv");
  });
});

describe("the local tier", () => {
  test("a project whose settings work reports nothing", async () => {
    expect(await emailSettings(config).local(context())).toEqual([]);
  });

  test("a BASE_URL that is not a URL is reported through the host's own schema", async () => {
    const findings = await emailSettings({ ...config, baseUrl: "api.acme.dev" }).local(context());
    // One finding, not one per environment: `email({ … })` is one config object, and so is the edit.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.setting).toBe("BASE_URL");
    expect(findings[0]?.environment).toBeNull();
    // The action is the provider sentence the host writes into its own startup log.
    expect(findings[0]?.action).toContain("Var BASE_URL in the host's wrangler.jsonc.");
  });

  test("a base URL no declared environment answers on is a finding", async () => {
    const findings = await emailSettings({ ...config, baseUrl: "http://localhost:8787" }).local(context());
    expect(findings).toEqual([
      {
        setting: "BASE_URL",
        environment: null,
        problem:
          "Links are built against http://localhost:8787, and no environment this project declares answers on it.",
        action:
          "Set `email({ baseUrl })` to an origin this project serves: https://staging.acme.dev, https://api.acme.dev.",
      },
    ]);
  });

  test("a project with no declared origin is not judged against one nobody named", async () => {
    const findings = await emailSettings({ ...config, baseUrl: "http://localhost:8787" }).local(
      context({ environments: [{ name: "prod", origin: null }] }),
    );
    expect(findings).toEqual([]);
  });

  test("a theme that does not survive its one JSON var is reported through the host's own schema", async () => {
    // `EMAIL_THEME` reaches the host as one serialized var, and the host refuses to boot on a value
    // that will not parse back. The check has to be live rather than nominal: a theme built by
    // `resolveTheme` round-trips, so nothing else in this file would ever exercise the branch, and a
    // wiring mistake here would look exactly like a clean pass.
    const findings = await emailSettings({
      ...config,
      theme: { ...defaultTheme, links: "twitter" } as unknown as EmailTheme,
    }).local(context());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.setting).toBe("EMAIL_THEME");
    expect(findings[0]?.action).toContain("email({ theme, customTheme })");
  });

  test("a from address with no usable domain is a finding, and it names the config key", async () => {
    const findings = await emailSettings({ ...config, fromAddress: "hello" }).local(context());
    expect(findings).toEqual([
      {
        setting: "fromAddress",
        environment: null,
        problem: "hello is not an address a sending domain can be read from.",
        action: "Set `email({ fromAddress })` to an address on a domain you have onboarded onto Email Service.",
      },
    ]);
  });
});

describe("the account tier", () => {
  test("an onboarded domain, a live suppression database, and a signing key report nothing", async () => {
    const findings = await emailSettings(config).account?.({ ...context(), account: reader() });
    expect(findings).toEqual([]);
  });

  test("a sending domain that is not a zone here is a finding naming the one-time action", async () => {
    const findings = await emailSettings(config).account?.({
      ...context(),
      account: reader({ zone: async () => false }),
    });
    expect(findings?.[0]).toEqual({
      setting: "fromAddress",
      environment: null,
      problem: "acme.dev is not a zone on this Cloudflare account, so it cannot be onboarded onto Email Service.",
      action: "Add acme.dev to this Cloudflare account, then onboard it onto Email Service in the dashboard.",
    });
  });

  test("a missing suppression database is a finding naming the command that creates it", async () => {
    const findings = await emailSettings(config).account?.({
      ...context(),
      account: reader({ d1Databases: async () => [] }),
    });
    expect(findings?.[0]).toEqual({
      setting: "EMAIL_SUPPRESSIONS",
      environment: null,
      problem: "No D1 database named acme-global-email-suppressions exists on this account.",
      action: "Run `pithy email provision --env prod`. Nothing is suppressed until it exists.",
    });
  });

  test("a signing key that was never created is reported per environment", async () => {
    const findings = await emailSettings(config).account?.({
      ...context(),
      account: reader({ secret: async ({ environment }) => environment !== "prod" }),
    });
    expect(findings).toEqual([
      {
        setting: "email-link-signing-key",
        environment: "prod",
        problem: "The link-signing key has no value in prod, so no tracking or unsubscribe link can be signed.",
        action: "Run `pithy secrets provision --env prod`.",
      },
    ]);
  });

  test("dev is never asked of the account — there is no manager Worker to answer", async () => {
    const asked: string[] = [];
    await emailSettings(config).account?.({
      ...context({ environments: [{ name: "dev", origin: null }] }),
      account: reader({
        secret: async ({ environment }) => {
          asked.push(environment);
          return true;
        },
      }),
    });
    expect(asked).toEqual([]);
  });
});

describe("the capability declares it", () => {
  test("`email()` carries the check on the instance, where doctor finds it with no manifest", () => {
    const capability = email(config);
    expect(capability.settings).toBeDefined();
    expect(capability.settings?.account).toBeDefined();
  });
});
