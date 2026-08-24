// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { LocaleCatalogs } from "@pithy-sh/core/src/i18n/catalog";
import { email } from "@pithy-sh/email/src/capability";
import { catalogsFromEnv } from "@pithy-sh/email/src/templates/messages";
import { defaultTheme } from "@pithy-sh/email/src/templates/theme";
import { i18n } from "@pithy-sh/i18n/src/capability";
import { describe, expect, test, vi } from "vitest";
import { loadEmailCapability } from "../commands/email";
import type { ResolvedWorker } from "../project/workerScope";
import { CloudflareEmailProvisioner } from "./emailProvisioner";

/**
 * **What `pithy email provision` actually deploys the host with.**
 *
 * Two links in that chain had a test each side of them and none on them. `emailCatalogs.test.ts` calls
 * `resolveEmailConfig` directly, so it proves catalogs *can* be stamped; nothing proved the command
 * reads them or the provisioner carries them. A revert of either would have shipped an English-only
 * host with no catalog vars and a green CI — the same defect class as the missing var itself,
 * moved one layer up (pithy-sh/pithy#441).
 *
 * So this drives the two links: the command edge, through its filesystem seam, and `deployWorker`,
 * against the real committed `wrangler.jsonc` with only `wrangler deploy` itself stubbed.
 */

/** Only what these assertions read of a resolved host config. */
interface DeployedConfig {
  vars?: Record<string, string>;
}

/** Every config `wrangler deploy` was pointed at, each read before the command unlinks it. */
const deployed = vi.hoisted(() => ({ configs: [] as DeployedConfig[] }));

// The one thing in `deployWorker` that talks to Cloudflare. Everything either side of it — reading the
// committed template, resolving it, writing the config — is what is under test and stays real.
vi.mock("../project/wrangler", () => ({
  runWrangler: async (args: string[]) => {
    const path = args[args.indexOf("--config") + 1];
    deployed.configs.push(JSON.parse(await readFile(path ?? "", "utf8")));
  },
}));

/** The kit's Spanish for `welcome`, as `@pithy-sh/i18n` ships it — the sentence that has to survive. */
/**
 * One sentence the adopter changed.
 *
 * **The kit's own Spanish is no longer what travels (#442).** The host is built with it, so a project
 * that overrides nothing deploys no variable at all — which means asserting the kit's own value here
 * would assert an empty answer and prove nothing about the compose step. The adopter's diff is what
 * still has to reach the host, so that is what these cases carry.
 */
const OVERRIDDEN = "Hola y bienvenido a {app}";

/** One app Worker composing the given capabilities — the shape `resolveWorkers` hands back. */
function workers(...capabilities: Capability[]): ResolvedWorker[] {
  return [
    {
      name: "api",
      dir: "/proj/apps/api",
      config: {} as ResolvedWorker["config"],
      capabilities,
      target: {} as ResolvedWorker["target"],
    },
  ];
}

function mail() {
  return email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
}

describe("loadEmailCapability", () => {
  test("hands back an assembled capability, so its catalogs are an answer and not a placeholder", async () => {
    const resolved = await loadEmailCapability("/proj", async () =>
      workers(
        i18n({ supportedLocales: ["en", "es"], messages: { es: { "email/welcome.subject": OVERRIDDEN } } }),
        mail(),
      ),
    );
    expect(resolved.hostCatalogs().es?.["email/welcome.subject"]).toBe(OVERRIDDEN);
  });

  test("across Workers, because the host it stamps is the project's and belongs to neither of them", async () => {
    // `apps/web` composes the languages and `apps/api` composes the mail. One host is deployed for the
    // project, named `<project>-<env>-email`, and it sends for both — so the union is the honest set.
    const resolved = await loadEmailCapability("/proj", async () => [
      ...workers(i18n({ supportedLocales: ["en", "es"], messages: { es: { "email/welcome.subject": OVERRIDDEN } } })),
      ...workers(mail()),
    ]);
    expect(resolved.hostCatalogs().es?.["email/welcome.subject"]).toBe(OVERRIDDEN);
  });

  test("a project composing no i18n capability carries nothing, which is the English it always sent", async () => {
    const resolved = await loadEmailCapability("/proj", async () => workers(mail()));
    expect(resolved.hostCatalogs()).toEqual({});
  });
});

describe("CloudflareEmailProvisioner.deployWorker", () => {
  function provisioner(messages: LocaleCatalogs) {
    return new CloudflareEmailProvisioner({
      cf: {} as CloudflareClients,
      account: { accountId: "acct-1", confirmation: "pinned" },
      project: "acme",
      apiToken: "tok",
      storeId: "store-1",
      theme: defaultTheme,
      messages,
      resolveEnv: async () => ({
        appDatabaseId: "app-db",
        secretsDatabaseId: "sec-db",
        baseUrl: "https://api.acme.test",
      }),
    });
  }

  test("deploys the host carrying the project's catalogs, not merely holding them", async () => {
    deployed.configs.length = 0;
    const mailCapability = await loadEmailCapability("/proj", async () =>
      workers(
        i18n({ supportedLocales: ["en", "es"], messages: { es: { "email/welcome.subject": OVERRIDDEN } } }),
        mail(),
      ),
    );
    await provisioner(mailCapability.hostCatalogs()).deployWorker("prod", "sup-db");

    const vars = deployed.configs[0]?.vars;
    expect(vars?.EMAIL_MESSAGES_ES, "wrangler was pointed at a config with no `es` catalog var").toBeDefined();
    const carried = catalogsFromEnv(vars ?? {});
    expect(carried.es?.["email/welcome.subject"]).toBe(OVERRIDDEN);
  });

  test("and deploys no var at all for a project with nothing to carry", async () => {
    deployed.configs.length = 0;
    await provisioner({}).deployWorker("prod", "sup-db");
    expect(deployed.configs[0]?.vars, "wrangler was pointed at no config at all").toBeDefined();
    expect(catalogsFromEnv(deployed.configs[0]?.vars ?? {})).toEqual({});
  });
});
