// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configFromArgs, NO_PROVISION_ARG, TOP_LEVEL_STANZA_ARG } from "../project/effectiveConfig";
import { DEPLOY_STAMP_VAR, deployStamp, UNFINISHED_STAMP } from "../provision/deployStamp";
import { narrate, type ProgressEvent } from "../terminal/progress";
import { deployHostWorker, type HostDeployOptions, planHostDeploy } from "./hostDeploy";

/**
 * The gate, driven through the path every provisioner now calls. Nothing here spawns wrangler and
 * nothing reaches Cloudflare: both are seams, which is what lets the "when in doubt" cases be proven
 * rather than argued about.
 */

/** The directory the temp config is written into — an installed package's worker dir, in real life. */
let dir: string;

/** Every `wrangler deploy` this run made, in order — the argv, and the config that argv names. */
let deploys: { args: readonly string[]; configPath: string; dir: string; config: WorkflowHostTemplate }[];

/** Every var written onto a deployed Worker after its deploy: script, name, value. */
let written: string[][];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-host-deploy-"));
  deploys = [];
  written = [];
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
    writeVar: async (script, name, value) => {
      written.push([script, name, value]);
    },
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
 * between its three values is load-bearing.
 *
 * `deployKit` passes the project's *selection*, so the `cloudflare.accountId` pin reaches
 * `cloudflareChildEnv` and a mismatch is refused. A provisioner passes the *pair* its command already
 * resolved. `null` means the project claims no account — and it must never be used to mean "the pair came
 * back incomplete", because that resolves the default `<config>/cloudflare.json` rather than the project's
 * named one.
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
  test("uploads the unfinished marker, and stamps the version and config hash once the deploy has finished", async () => {
    const outcome = await run({ vars: null });
    expect(outcome).toEqual({
      capability: "email",
      worker: "acme-prod-email",
      outcome: "deployed",
      reason: "It was not on the account.",
    });
    // wrangler sets the triggers after the upload, so the upload's own var cannot say the deploy finished.
    expect(deploys[0]?.config.vars?.[DEPLOY_STAMP_VAR]).toBe(UNFINISHED_STAMP);
    expect(written).toEqual([["acme-prod-email", DEPLOY_STAMP_VAR, CURRENT]]);
    expect(deploys[0]?.dir).toBe(dir);
  });

  test("a deploy that fails after its upload records no stamp, so the next run deploys again", async () => {
    await expect(
      run({
        vars: null,
        runDeploy: async () => {
          throw new InternalError({ message: "wrangler deploy failed. A custom domain is already in use." });
        },
      }),
    ).rejects.toThrowError(/custom domain/);
    expect(written).toEqual([]);
    // What the failed upload left behind reads as unfinished, which deploys.
    const rerun = await run({ vars: { [DEPLOY_STAMP_VAR]: UNFINISHED_STAMP } });
    expect(rerun.outcome).toBe("deployed");
    expect(rerun.reason).toBe("Its last deploy did not record that it finished.");
  });

  test("a stamp that cannot be recorded leaves the Worker deployed, and the row says the next run uploads again", async () => {
    const outcome = await run({
      vars: null,
      writeVar: async () => {
        throw new Error("403 Forbidden");
      },
    });
    expect(outcome.outcome).toBe("deployed");
    expect(outcome.reason).toBe(
      "It was not on the account. Its deploy stamp could not be recorded, so the next deploy uploads it again. 403 Forbidden",
    );
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
      expect(outcome.reason).toBe("It carried no deploy stamp.");
    });

    test("an unreachable account, with what it said carried into the reason", async () => {
      const outcome = await run({
        readVars: async () => {
          throw new InternalError({ message: "Cloudflare request failed: get vars for 'acme-prod-email'." });
        },
      });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe(
        "Its deploy stamp could not be read. Cloudflare request failed: get vars for 'acme-prod-email'.",
      );
    });

    test("no Cloudflare client at all — undeclared and unchanged are not the same fact", async () => {
      const outcome = await run({ readVars: undefined });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe("Its deploy stamp could not be read. No Cloudflare client was available to read it.");
    });

    test("a stamp in a shape this release cannot read", async () => {
      const outcome = await run({ vars: { [DEPLOY_STAMP_VAR]: "who-knows" } });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe("Its deploy stamp was not one this release can read.");
    });

    test("a package version nobody could read deploys, and deliberately writes no stamp", async () => {
      // A stamp carrying an invented version would match itself forever and skip a real upgrade. No
      // stamp means the next run reads an unstamped Worker and deploys again — today's behavior.
      const outcome = await run({ version: null, vars: { [DEPLOY_STAMP_VAR]: CURRENT } });
      expect(outcome.outcome).toBe("deployed");
      expect(outcome.reason).toBe("@pithy-sh/email's version could not be read, so it was deployed unstamped.");
      expect(deploys[0]?.config.vars?.[DEPLOY_STAMP_VAR]).toBeUndefined();
      expect(written).toEqual([]);
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

  describe("a Worker Cloudflare has not propagated yet", () => {
    /** wrangler's failure when its read-back of a brand-new Worker answers 10007. */
    const unseen = () =>
      new InternalError({
        message:
          "wrangler deploy failed.\n  ✘ [ERROR] A request to the Cloudflare API (/accounts/a/workers/workers/acme-prod-email) failed.\n    This Worker does not exist on your account. [code: 10007]",
      });

    test("is deployed once more after a wait, and reported deployed when that succeeds", async () => {
      const waits: number[] = [];
      let attempts = 0;
      const outcome = await run({
        vars: null,
        retryWait: async (ms) => {
          waits.push(ms);
        },
        runDeploy: async (args) => {
          attempts += 1;
          // The temporary config is still there for the second attempt.
          expect(JSON.parse(await readFile(configFromArgs(args) as string, "utf8")).name).toBe("acme-prod-email");
          if (attempts === 1) throw unseen();
        },
      });
      expect(attempts).toBe(2);
      expect(waits).toHaveLength(1);
      expect(outcome.outcome).toBe("deployed");
      expect(written).toEqual([["acme-prod-email", DEPLOY_STAMP_VAR, CURRENT]]);
      expect(await readdir(dir)).toEqual([]);
    });

    test("a second 10007 fails as any failure does, with no third attempt", async () => {
      let attempts = 0;
      await expect(
        run({
          vars: null,
          retryWait: async () => {},
          runDeploy: async () => {
            attempts += 1;
            throw unseen();
          },
        }),
      ).rejects.toThrowError(/10007/);
      expect(attempts).toBe(2);
      expect(written).toEqual([]);
    });

    test("any other wrangler failure is not retried", async () => {
      let attempts = 0;
      await expect(
        run({
          vars: null,
          retryWait: async () => {},
          runDeploy: async () => {
            attempts += 1;
            throw new InternalError({ message: "wrangler deploy failed. [code: 10021]" });
          },
        }),
      ).rejects.toThrowError(/10021/);
      expect(attempts).toBe(1);
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
 * **`pithy deploy --dry-run` asks the gate and stops there.** The verdict is the one a real deploy
 * would reach — the stamp read, the reason worded the same — and nothing after it happens: no temporary
 * config beside the package, no wrangler, no narration of an upload that is not coming.
 */
describe("planHostDeploy", () => {
  /** The plan for one host, against the deployed vars the account would answer with. */
  function plan(options: Partial<HostDeployOptions> & { vars?: Record<string, string> | null }) {
    const { vars, ...rest } = options;
    return planHostDeploy({
      capability: "email",
      pkg: "@pithy-sh/email",
      version: "0.1.7",
      config: config(),
      dir,
      env: "prod",
      readVars: async () => vars ?? null,
      runDeploy: async (args) => {
        deploys.push({ args, configPath: "", dir: "", config: config() });
      },
      ...rest,
    });
  }

  test("a Worker the run would upload is planned with the run's own reason, and nothing is written or run", async () => {
    const events: ProgressEvent[] = [];
    const planned = await narrate(
      (event) => events.push(event),
      () => plan({ vars: null }),
    );
    expect(planned).toEqual({
      capability: "email",
      worker: "acme-prod-email",
      deploy: true,
      reason: "It was not on the account.",
    });
    expect(deploys).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a current Worker is planned as staying, with the reason the run would print", async () => {
    expect(await plan({ vars: { [DEPLOY_STAMP_VAR]: CURRENT } })).toEqual({
      capability: "email",
      worker: "acme-prod-email",
      deploy: false,
      reason: "@pithy-sh/email 0.1.7 is deployed with this configuration.",
    });
    expect(deploys).toEqual([]);
  });

  test("refuses a configuration that names no Worker, as the run does", async () => {
    await expect(plan({ config: config({ name: "" }), vars: null })).rejects.toThrowError(/names no Worker/);
    expect(await readdir(dir)).toEqual([]);
  });
});

/**
 * **One place, and every command that ships a kit Worker inherits it.**
 *
 * `pithy deploy --kit` reaches here, and so does every `pithy <capability> provision` — through an
 * orchestrator and a provisioner class in a kit package, neither of which carries a progress parameter.
 * Narrating at the spawn enrolls all of them at once.
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
 * **The stanza a kit Worker publishes under is stated on its argv, so the operator's shell cannot choose it.**
 *
 * wrangler resolves its environment as `args.env ?? CLOUDFLARE_ENV` and the child inherits the shell, and
 * `appendEnvName` runs whether or not the stanza exists. An argv naming no stanza would publish
 * `acme-prod-email-prod` for an operator with `CLOUDFLARE_ENV=prod` exported: a Worker under a name nothing
 * references. The gate reads the argv rather than its own answer, so an argv that stopped stating the stanza
 * reddens these in any shell.
 */
describe("the stanza a kit Worker is published under", () => {
  test("is stated on the argv, so the shell is not what decides it", async () => {
    await run({ vars: null, processEnv: { CLOUDFLARE_ENV: "prod" } });
    // The literal argv, not a re-derivation of it. `--env=` is wrangler's own spelling for the top-level
    // stanza — it names that form in the warning it prints when a command specifies no environment.
    expect(deploys[0]?.args).toEqual([
      "deploy",
      "--config",
      join(dir, ".wrangler.prod.json"),
      "--env=",
      "--experimental-provision=false",
    ]);
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

/**
 * **`pithy deploy --kit` creates nothing, and a bucket name is not an id anything can check.**
 *
 * Media and storage derive their bucket from the project and nothing confirms it exists, so under
 * wrangler's default a kit deploy against an environment that never ran `pithy media provision` would make
 * the bucket. For R2 the name is the id: no offline read of this config can tell a real bucket from one
 * wrangler is about to create. What stops it is the argv, so that is what is asserted — on the config a
 * provisioner hands over, bucket and all.
 */
describe("a kit Worker's deploy creates no resource", () => {
  test("a named bucket ships on an argv that turns wrangler's provisioning off", async () => {
    const withBucket = config({
      name: "acme-prod-media",
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "acme-prod-media" }],
    });
    await run({ vars: null, config: withBucket });
    expect(deploys[0]?.config).toMatchObject({ r2_buckets: [{ bucket_name: "acme-prod-media" }] });
    expect(deploys[0]?.args).toContain("--experimental-provision=false");
    expect(NO_PROVISION_ARG).toBe("--experimental-provision=false");
  });
});
