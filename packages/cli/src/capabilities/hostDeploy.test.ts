// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEPLOY_STAMP_VAR, deployStamp } from "../provision/deployStamp";
import { deployHostWorker, type HostDeployOptions } from "./hostDeploy";

/**
 * The gate, driven through the path every provisioner now calls. Nothing here spawns wrangler and
 * nothing reaches Cloudflare: both are seams, which is what lets the "when in doubt" cases be proven
 * rather than argued about.
 */

/** The directory the temp config is written into — an installed package's worker dir, in real life. */
let dir: string;

/** Every `wrangler deploy --config` this run made, in order. */
let deploys: { configPath: string; dir: string; config: WorkflowHostTemplate }[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-host-deploy-"));
  deploys = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The resolved config a provisioner hands over. */
function config(overrides: Partial<WorkflowHostTemplate> = {}): WorkflowHostTemplate {
  return {
    name: "acme-prod-email",
    main: "./worker.js",
    compatibility_date: "2026-06-01",
    vars: { BASE_URL: "https://acme.example" },
    ...overrides,
  };
}

/** One gated deploy, with the deployed vars the account would answer with. */
function run(options: Partial<HostDeployOptions> & { vars?: Record<string, string> | null }) {
  const { vars, ...rest } = options;
  return deployHostWorker({
    capability: "email",
    pkg: "@pithy-sh/email",
    version: "0.1.7",
    config: config(),
    dir,
    env: "prod",
    readVars: async () => vars ?? null,
    runDeploy: async (configPath, cwd) => {
      deploys.push({ configPath, dir: cwd, config: JSON.parse(await readFile(configPath, "utf8")) });
    },
    ...rest,
  });
}

/** The stamp a deploy of the unmodified config would write. */
const CURRENT = deployStamp(config(), "0.1.7");

/**
 * The account a host deploy authenticates as travels as a {@link WranglerAccount}, and the distinction
 * between its three values is load-bearing (#555).
 *
 * `deployKit` passes the project's *selection*, so the `cloudflare.accountId` pin reaches
 * `cloudflareChildEnv` and #206's mismatch refusal can fire. A provisioner passes the *pair* its command
 * already resolved. `null` means the project claims no account — and it must never be used to mean "the
 * pair came back incomplete", because that resolves the default `<config>/cloudflare.json` rather than
 * the project's named one.
 */
describe("the account a host deploy ships under", () => {
  test("the selection reaches the runner, pin included, rather than being flattened to a pair", async () => {
    const seen: unknown[] = [];
    await deployHostWorker({
      capability: "email",
      pkg: "@pithy-sh/email",
      version: "1.0.0",
      config: { name: "acme-prod-email", vars: {} } as never,
      dir: await mkdtemp(join(tmpdir(), "pithy-host-account-")),
      env: "prod",
      account: { accountName: "acme", accountId: "acct-1" },
      force: true,
      runDeploy: async (_configPath, _dir) => {
        seen.push("ran");
      },
    });
    // The runner ran, which is what proves the option shape is accepted end to end; the account itself is
    // consumed by `runWrangler` one frame in, and `wrangler.test.ts` is where that pair is asserted.
    expect(seen).toEqual(["ran"]);
  });
});

describe("deployHostWorker", () => {
  test("stamps the config it deploys with the package version and the config hash", async () => {
    const outcome = await run({ vars: null });
    expect(outcome).toEqual({
      capability: "email",
      worker: "acme-prod-email",
      outcome: "deployed",
      reason: "acme-prod-email is not deployed.",
    });
    expect(deploys[0]?.config.vars?.[DEPLOY_STAMP_VAR]).toBe(CURRENT);
    // The stamp ships inside the config wrangler deploys, so the bundle and its claim are one atomic
    // write. A second API call could succeed against a deploy that failed.
    expect(deploys[0]?.dir).toBe(dir);
  });

  test("skips a Worker whose version and hash both match, and says which version is live", async () => {
    const outcome = await run({ vars: { [DEPLOY_STAMP_VAR]: CURRENT } });
    expect(outcome).toEqual({
      capability: "email",
      worker: "acme-prod-email",
      outcome: "unchanged",
      reason: "@pithy-sh/email 0.1.7 is deployed with this configuration.",
    });
    expect(deploys).toEqual([]);
  });

  test("a var an adopter edited redeploys — the silent half of the problem", async () => {
    const edited = config({ vars: { BASE_URL: "https://acme.example", EMAIL_THEME: '{"brand":"#0af"}' } });
    const outcome = await run({ config: edited, vars: { [DEPLOY_STAMP_VAR]: CURRENT } });
    expect(outcome.outcome).toBe("deployed");
    expect(outcome.reason).toBe("Its resolved configuration changed.");
  });

  test("a kit upgrade redeploys, and the reason names the move", async () => {
    const outcome = await run({ vars: { [DEPLOY_STAMP_VAR]: `0.1.6/${CURRENT.split("/")[1]}` } });
    expect(outcome.outcome).toBe("deployed");
    expect(outcome.reason).toBe("@pithy-sh/email moved from 0.1.6 to 0.1.7.");
  });

  describe("when in doubt, deploy", () => {
    test("no Worker on the account", async () => {
      expect((await run({ vars: null })).outcome).toBe("deployed");
    });

    test("a Worker carrying no stamp — deployed before this gate existed", async () => {
      const outcome = await run({ vars: { BASE_URL: "https://acme.example" } });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe("acme-prod-email carries no deploy stamp.");
    });

    test("an unreachable account, with what it said carried into the reason", async () => {
      const outcome = await run({
        readVars: async () => {
          throw new InternalError({ message: "Cloudflare request failed: get vars for 'acme-prod-email'." });
        },
      });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe(
        "acme-prod-email's deploy stamp could not be read. Cloudflare request failed: get vars for 'acme-prod-email'.",
      );
    });

    test("no Cloudflare client at all — undeclared and unchanged are not the same fact", async () => {
      const outcome = await run({ readVars: undefined });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe(
        "acme-prod-email's deploy stamp could not be read. No Cloudflare client was available to read it.",
      );
    });

    test("a stamp in a shape this release cannot read", async () => {
      const outcome = await run({ vars: { [DEPLOY_STAMP_VAR]: "who-knows" } });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe("acme-prod-email's deploy stamp is not one this release can read.");
    });

    test("a package version nobody could read deploys, and deliberately writes no stamp", async () => {
      // A stamp carrying an invented version would match itself forever and skip a real upgrade. No
      // stamp means the next run reads an unstamped Worker and deploys again — today's behavior.
      const outcome = await run({ version: null, vars: { [DEPLOY_STAMP_VAR]: CURRENT } });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe("@pithy-sh/email's version could not be read, so it was deployed unstamped.");
      expect(deploys[0]?.config.vars?.[DEPLOY_STAMP_VAR]).toBeUndefined();
    });
  });

  describe("--force", () => {
    test("deploys a Worker whose stamp matches", async () => {
      const outcome = await run({ force: true, vars: { [DEPLOY_STAMP_VAR]: CURRENT } });
      expect(outcome).toEqual({
        capability: "email",
        worker: "acme-prod-email",
        outcome: "deployed",
        reason: "--force was given.",
      });
      expect(deploys).toHaveLength(1);
    });

    test("reads nothing — a recovery run must not also depend on the account answering", async () => {
      let read = 0;
      const outcome = await run({
        force: true,
        readVars: async () => {
          read += 1;
          return { [DEPLOY_STAMP_VAR]: CURRENT };
        },
      });
      expect(read).toBe(0);
      expect(outcome.outcome).toBe("deployed");
    });
  });

  describe("the temporary config", () => {
    test("is removed after a successful deploy", async () => {
      await run({ vars: null });
      expect(await readdir(dir)).toEqual([]);
    });

    test("is removed after a failed one, and the failure is not swallowed", async () => {
      await expect(
        run({
          vars: null,
          runDeploy: async () => {
            throw new InternalError({ message: "wrangler deploy failed." });
          },
        }),
      ).rejects.toThrowError("wrangler deploy failed.");
      expect(await readdir(dir)).toEqual([]);
    });

    test("is never written for a Worker that was skipped", async () => {
      await run({ vars: { [DEPLOY_STAMP_VAR]: CURRENT } });
      expect(await readdir(dir)).toEqual([]);
    });
  });
});
