// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import type { TurnstileClientProjection } from "@pithy-sh/turnstile/src/client/projection";
import {
  provisionTurnstile,
  type TurnstileProvisionResult,
} from "@pithy-sh/turnstile/src/provision/provisionTurnstile";
import { pithy } from "@pithy-sh/vite/src/plugin";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { uiBuildEnvironment } from "../project/deploy";
import { scaffoldProject } from "../project/scaffold";
import { linkKitPackages } from "../test-utils/linkKit";
import { addCapability } from "./add";
import { CloudflareTurnstileProvisioner } from "./turnstileProvisioner";
import { environmentsBuiltWithoutSitekeys } from "./turnstileSitekeys";

/**
 * **The gate for #590: what `pithy turnstile provision` writes is what a deployed bundle renders with.**
 *
 * The invariant is that the producer and the consumer meet, and it is stated about the far end of the
 * consumer — the bundle — rather than about either half. #53's provisioner wrote the sitekeys into Worker
 * vars; #83's projection read them out of `pithy.config.ts`. Each half's own tests were green for as long
 * as the split stood, because each half was right about itself. Nothing asserted the two still met.
 *
 * So this runs the chain an adopter runs, with the real thing at every link but Cloudflare's API:
 *
 * 1. **`pithy add turnstile`** — `addCapability` with the shipped manifest, into a scaffolded project.
 * 2. **`pithy turnstile provision`** — `provisionTurnstile` driving the real `CloudflareTurnstileProvisioner`,
 *    whose Cloudflare client and secrets dispatcher are stubs.
 * 3. **`pithy deploy --env <name>`'s front-end build** — a real `vite build` through the `pithy()` plugin,
 *    handed the environment the way deploy hands it: `uiBuildEnvironment`'s overlay, in the process env,
 *    with no `environment` option on the plugin.
 * 4. **The bundle itself is evaluated**, and its `virtual:pithy/turnstile` export is what is asserted.
 *
 * **What must be true, for every environment this project builds a front end for:** the bundle renders the
 * widget, with the sitekey provisioning reports writing — or provisioning names that environment as one
 * with no sitekey. Never a silent `enabled: false`.
 *
 * ## What it does not see
 *
 * - **The widget secret.** It is written to the secrets store and read by the middleware at request time;
 *   `turnstileProvisioner.test.ts` and the middleware's own suites hold that half.
 * - **`@cloudflare/vite-plugin`.** Deploy's overlay also selects the wrangler stanza; the pithy plugin reads
 *   only the environment, so the stanza half is not exercised here.
 * - **dev's sitekey from staging's.** Both are Cloudflare's one always-pass test key, so a build that
 *   answered staging out of dev's slot renders the right widget and passes. Planted and watched: it does.
 * - **A config that computes its sitekeys from `compositionEnvironment()`.** The fixture states literals;
 *   the plugin's own loader imports the config once per build, so such a config is covered only insofar as
 *   that import sees the environment.
 */

/** This repository's packages — where the shipped turnstile manifest lives. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/** The production widget sitekey the stubbed Cloudflare API issues. */
const PROD_SITEKEY = "0x4AAAAAAAgate-prod";

/** Cloudflare's always-pass visible test sitekey, written out: the gate's expectation is not the producer's constant. */
const VISIBLE_TEST_SITEKEY = "1x00000000000000000000AA";

/** The project's declared environments — the defaults plus one a sitekey has no slot for. */
const DECLARED = ["staging", "live", "prod"];

/** Every environment this project builds a front end for: local, each declared one, and a feature build. */
const BUILT = [LOCAL_ENVIRONMENT, ...DECLARED, FEATURE_ENVIRONMENT];

/** The one `vite` call this makes, typed here: the CLI does not depend on Vite, so its types are not in reach. */
type ViteBuild = (config: Record<string, unknown>) => Promise<unknown>;

/**
 * `vite`, resolved from the plugin's own package — the copy `@pithy-sh/vite` runs against. The CLI takes
 * `@pithy-sh/vite` as a dev dependency and Vite only through it, so it is found where the plugin finds it.
 */
async function viteBuild(): Promise<ViteBuild> {
  const require = createRequire(join(PACKAGES, "vite", "package.json"));
  const vite = (await import(pathToFileURL(require.resolve("vite")).href)) as { build: ViteBuild };
  return vite.build;
}

/**
 * Build the Worker's front end for one environment and evaluate the bundle's turnstile projection.
 *
 * The environment reaches the plugin the way `pithy deploy` sends it — the overlay in the process env — and
 * every variable that could otherwise answer is cleared first, so a developer's shell cannot pass the gate.
 */
async function bundledProjection(workerDir: string, environment: string): Promise<TurnstileClientProjection> {
  const build = await viteBuild();
  for (const name of ["ENVIRONMENT", "CLOUDFLARE_ENV", "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH"]) {
    vi.stubEnv(name, undefined);
  }
  const overlay = uiBuildEnvironment(environment === LOCAL_ENVIRONMENT ? undefined : environment, workerDir);
  for (const [name, value] of Object.entries(overlay)) vi.stubEnv(name, value);
  try {
    const entry = join(workerDir, "turnstile-entry.ts");
    await writeFile(entry, 'import turnstile from "virtual:pithy/turnstile";\nexport default turnstile;\n');
    const output = await build({
      root: workerDir,
      configFile: false,
      logLevel: "silent",
      plugins: [pithy()],
      build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "entry" } },
    });
    const results = (Array.isArray(output) ? output : [output]) as unknown as {
      output: { type: string; code?: string }[];
    }[];
    const code = results
      .flatMap((result) => result.output)
      .filter((chunk) => chunk.type === "chunk")
      .map((chunk) => chunk.code ?? "")
      .join("\n");
    const module = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as {
      default: TurnstileClientProjection;
    };
    return module.default;
  } finally {
    vi.unstubAllEnvs();
  }
}

/** A Cloudflare client that issues one widget and knows of none before it. */
function stubCloudflare(): CloudflareClients {
  return {
    turnstile: () => ({
      listTurnstilesByDomain: async () => [],
      getTurnstile: async () => null,
      addTurnstile: async () => ({ sitekey: PROD_SITEKEY, secret: "0x4AAAAAAAgate-secret" }),
      deleteTurnstile: async () => {},
    }),
  } as unknown as CloudflareClients;
}

const fixture = { dir: "", workerDir: "", result: undefined as TurnstileProvisionResult | undefined };

beforeAll(async () => {
  fixture.dir = await mkdtemp(join(tmpdir(), "pithy-turnstile-bundle-"));
  await scaffoldProject({ targetDir: fixture.dir, appName: "replay", worker: "board", environments: DECLARED });
  await linkKitPackages(fixture.dir, ["core", "turnstile"]);
  fixture.workerDir = join(fixture.dir, "apps", "board");

  // 1. `pithy add turnstile`, from the manifest the package ships.
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(join(PACKAGES, "turnstile", "pithy.manifest.json"), "utf8")),
  );
  await addCapability({ workerDir: fixture.workerDir, manifest, project: "replay" });

  // 2. `pithy turnstile provision`, with the real provisioner over a stubbed account.
  const dispatcher: SecretDispatcher = { dispatch: async () => {} };
  const provisioner = new CloudflareTurnstileProvisioner({
    account: { accountId: "acct-gate", confirmation: "pinned" },
    cf: stubCloudflare(),
    project: "replay",
    projectDir: fixture.dir,
    workerDir: fixture.workerDir,
    dispatcher,
    environments: DECLARED,
    notes: () => {},
  });
  fixture.result = await provisionTurnstile(provisioner, { modes: ["visible"], productionDomain: "app.example.com" });
}, 120_000);

afterAll(async () => {
  await rm(fixture.dir, { recursive: true, force: true });
});

describe("pithy add turnstile, then provision, then a build per environment", () => {
  test("pithy add turnstile scaffolds a widget, so provisioning had one to provision", () => {
    // The trap beside #590: `add` used to render `turnstile()`, whose default gates login with a widget
    // nobody declared, and provisioning refused until one was written by hand. The modes provisioning acted on
    // came out of the registration `add` wrote, and nothing else wrote it.
    expect(fixture.result?.modes).toEqual(["visible"]);
  });

  test.for(BUILT)(
    "%s: the bundle renders the provisioned sitekey, or provisioning named the environment",
    { timeout: 120_000 },
    async (environment) => {
      const projection = await bundledProjection(fixture.workerDir, environment);
      // What `pithy turnstile provision` and `pithy doctor` report, from the project's declaration — the
      // command's own list, so a report that forgot an environment the CLI builds is a red build here.
      const reported = environmentsBuiltWithoutSitekeys(DECLARED);

      if (projection.enabled) {
        // The producer's own report and an independent literal, both — so neither a writer that reports what
        // it did not write, nor a report computed from the bundle, can pass.
        const expected = environment === "prod" ? PROD_SITEKEY : VISIBLE_TEST_SITEKEY;
        expect(projection.sitekey).toBe(expected);
        expect(projection.sitekey).toBe(fixture.result?.sitekeys.visible?.[environment as "dev" | "staging" | "prod"]);
        expect(reported).not.toContain(environment);
      } else {
        expect(reported).toContain(environment);
      }
    },
  );

  test("the environments a sitekey has a slot for are exactly the ones that rendered", async () => {
    // The other direction: an environment provisioning *claims* is covered must render. Without this, a
    // writer that wrote nothing would pass the case above for every environment, each one "reported".
    for (const environment of ["dev", "staging", "prod"]) {
      expect((await bundledProjection(fixture.workerDir, environment)).enabled).toBe(true);
    }
  }, 180_000);
});
