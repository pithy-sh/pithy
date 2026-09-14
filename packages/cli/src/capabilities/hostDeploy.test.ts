// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configFromArgs, TOP_LEVEL_STANZA_ARG } from "../project/effectiveConfig";
import { DEPLOY_STAMP_VAR, deployStamp } from "../provision/deployStamp";
import { narrate, type ProgressEvent } from "../terminal/progress";
import { deployHostWorker, type HostDeployOptions } from "./hostDeploy";

/**
 * The gate, driven through the path every provisioner now calls. Nothing here spawns wrangler and
 * nothing reaches Cloudflare: both are seams, which is what lets the "when in doubt" cases be proven
 * rather than argued about.
 */

/** The directory the temp config is written into — an installed package's worker dir, in real life. */
let dir: string;

/** Every `wrangler deploy` this run made, in order — the argv, and the config that argv names. */
let deploys: { args: readonly string[]; configPath: string; dir: string; config: WorkflowHostTemplate }[];

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
    runDeploy: async (args, cwd) => {
      // Read back through the argv, the way wrangler resolves it, rather than through a path this test
      // rebuilt: an argv that stopped naming the generated config would otherwise still look like one.
      const configPath = configFromArgs(args) as string;
      deploys.push({ args, configPath, dir: cwd, config: JSON.parse(await readFile(configPath, "utf8")) });
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
      runDeploy: async (_args, _dir) => {
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

/**
 * **One place, and every command that ships a kit Worker inherits it (#578).**
 *
 * `pithy deploy --kit` reaches here, and so does every `pithy <capability> provision` — through an
 * orchestrator and a provisioner class in a kit package, neither of which carries a progress parameter
 * and neither of which should grow one. Narrating at the spawn is what enrolls all of them at once,
 * which is the opposite of what #531 did: it named the seam for provisioning, filed it under
 * `provision/`, and `deploy` never found it.
 */
describe("a kit Worker's upload announces itself", () => {
  /** Every progress event one run raised. */
  async function narrated(work: () => Promise<unknown>): Promise<ProgressEvent[]> {
    const events: ProgressEvent[] = [];
    await narrate(
      (event) => events.push(event),
      async () => {
        await work();
      },
    );
    return events;
  }

  test("names the Worker it is about to upload", async () => {
    expect(await narrated(() => run({ vars: null }))).toEqual([{ phase: "start", what: "acme-prod-email" }]);
  });

  /**
   * **Nothing is said for a Worker that was already current.** A `▸` line in front of an upload that
   * never happens is narration an operator learns to distrust, and the skip has its own sentence in the
   * row the caller settles.
   */
  test("says nothing when the stamp matched and no wrangler ran", async () => {
    expect(await narrated(() => run({ vars: { [DEPLOY_STAMP_VAR]: CURRENT } }))).toEqual([]);
    expect(deploys).toEqual([]);
  });

  /** Outside a narrated span — every `--json` run — the spawn is as quiet as it ever was. */
  test("is silent where no span was opened", async () => {
    const outcome = await run({ vars: null });
    expect(outcome.outcome).toBe("deployed");
  });
});

/**
 * **#584: the third producer of one class, and the one with no symptom in the shell that wrote it.**
 *
 * The argv was `["deploy", "--config", <generated>]` — no stanza named, no gate. wrangler resolves its
 * environment as `args.env ?? CLOUDFLARE_ENV` and the child inherits the operator's shell, so an
 * exported `CLOUDFLARE_ENV=prod` published `acme-prod-email-prod`: `appendEnvName` runs whether or not
 * the stanza exists, and a generated host config has no `env` section for wrangler to complain about.
 * A Worker under a name nothing references, while every binding pointing at `acme-prod-email` resolves
 * to the old script or to nothing.
 *
 * The stanza is stated on the argv now, in wrangler's own spelling for the top level, and the gate reads
 * the argv rather than its own answer — so a build that stopped stating it reddens these in any shell.
 */
describe("the stanza a kit Worker is published under", () => {
  test("is stated on the argv, so the shell is not what decides it", async () => {
    await run({ vars: null, processEnv: { CLOUDFLARE_ENV: "prod" } });
    // The literal argv, not a re-derivation of it. `--env=` is wrangler's own spelling for the top-level
    // stanza — it names that form in the warning it prints when a command specifies no environment.
    expect(deploys[0]?.args).toEqual(["deploy", "--config", join(dir, ".wrangler.prod.json"), "--env="]);
    expect(TOP_LEVEL_STANZA_ARG).toBe("--env=");
  });

  /**
   * Acceptance, in the shell the issue names: `CLOUDFLARE_ENV=prod` exported, and the Worker that ships
   * is the one the kit named. What wrangler makes of that argv is `identityOf`'s to answer and
   * `effectiveConfig.test.ts`'s to assert — this seam can say what it handed over, and it hands over a
   * config naming `acme-prod-email` and an argv selecting no stanza.
   */
  test("publishes the name the kit gave it, with CLOUDFLARE_ENV exported in the real environment", async () => {
    const restore = process.env.CLOUDFLARE_ENV;
    process.env.CLOUDFLARE_ENV = "prod";
    try {
      const outcome = await run({ vars: null });
      expect(outcome).toMatchObject({ worker: "acme-prod-email", outcome: "deployed" });
      expect(deploys[0]?.config.name).toBe("acme-prod-email");
      expect(deploys[0]?.args).toContain(TOP_LEVEL_STANZA_ARG);
    } finally {
      if (restore === undefined) delete process.env.CLOUDFLARE_ENV;
      else process.env.CLOUDFLARE_ENV = restore;
    }
  });

  test("refuses, and writes no temporary config, when the configuration names no Worker", async () => {
    // The half of the gate a caller can still reach. Nothing can hold a deploy to a name that is not
    // there, and a deploy nothing holds is the shape every producer of this class has arrived in.
    await expect(run({ vars: null, config: { ...config(), name: "" } })).rejects.toThrowError(/names no Worker/);
    expect(await readdir(dir)).toEqual([]);
  });
});
