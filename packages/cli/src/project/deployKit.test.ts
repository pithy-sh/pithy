// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { email } from "@pithy-sh/email/src/capability";
import { PACKAGE_VERSION } from "@pithy-sh/email/src/version.generated";
import { media } from "@pithy-sh/media/src/capability";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readHostTemplate } from "../capabilities/hostRegistry";
import { DEPLOY_STAMP_VAR } from "../provision/deployStamp";
import { linkKitPackages } from "../test-utils/linkKit";
import {
  deployKitWorkers,
  type KitDeployReport,
  type KitWorkerDeploy,
  kitDeployFailed,
  summarizeKitDeploy,
  summarizeKitProblem,
} from "./deployKit";
import type { WorkerTarget } from "./workers";

/**
 * `pithy deploy --kit`, driven end to end through the real registry entry and the real resolver, with
 * only the network and wrangler replaced.
 *
 * The fixture is a project with one app Worker that composes `email`. Its `wrangler.jsonc` is the same
 * file `pithy provision` writes ids into, so the binding ids this reads are read the way the real run
 * reads them: off disk, offline, with nothing created.
 *
 * **And the capabilities it composes are the real composed objects, not `{ name: "email" }`.** They were
 * the latter, which meant no adopter configuration ever reached a resolver here and every case passed
 * against a registry that read schema defaults — the #537 defect this file is the end-to-end test for,
 * invisible to the end-to-end test. `capabilities/hostConfigParity.test.ts` holds the same property at
 * the seam, per capability; this holds it through the command.
 */

let projectDir: string;
/** Every config handed to `wrangler deploy --config` this run, parsed. */
let deployed: WorkflowHostTemplate[];

/** A minimal committed template — the real one's shape, without its comment essay. */
const template: WorkflowHostTemplate = {
  name: "pithy-email",
  main: "./worker.ts",
  compatibility_date: "2026-06-01",
  d1_databases: [
    { binding: "DB", database_name: "pithy-app", database_id: "<filled-at-provision>" },
    { binding: "EMAIL_SUPPRESSIONS", database_name: "pithy-email-suppressions", database_id: "<filled-at-provision>" },
    { binding: "SECRETS", database_name: "pithy-secrets", database_id: "<filled-at-provision>" },
  ],
  secrets_store_secrets: [
    { binding: "SECRETS_ENCRYPTION_KEYS", store_id: "<filled-at-provision>", secret_name: "<filled-at-provision>" },
  ],
  vars: { EMAIL_THEME: "<filled-at-provision>", BASE_URL: "<filled-at-provision>" },
};

/** Every D1 binding the email host asks for, with an id, as a provisioned project's stanza holds them. */
const PROVISIONED = [
  { binding: "DB", database_id: "db-1" },
  { binding: "EMAIL_SUPPRESSIONS", database_id: "sup-1" },
  { binding: "SECRETS", database_id: "sec-1" },
];

/**
 * The email capability as an adopter composes it. Tuned away from its defaults, so a resolver reading
 * schema defaults instead of this object produces a visibly different config.
 */
const EMAIL = email({
  fromAddress: "hello@acme.example",
  fromName: "Acme Support",
  baseUrl: "https://api.acme.example",
  theme: "midnight",
});

/** Write the app Worker's `wrangler.jsonc` — the file this reads binding ids and the origin from. */
async function writeApp(
  bindings: { binding: string; database_id: string }[],
  baseUrl = "https://acme.example",
  namespaces: { binding: string; id: string }[] = [],
) {
  const dir = join(projectDir, "apps", "api");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "wrangler.jsonc"),
    `${JSON.stringify(
      {
        name: "api",
        env: { prod: { d1_databases: bindings, kv_namespaces: namespaces, vars: { BASE_URL: baseUrl } } },
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pithy-deploy-kit-"));
  await linkKitPackages(projectDir, ["email", "media"]);
  deployed = [];
  // **The account's Secrets Store id, which every host that binds the store now requires.** Unset by
  // `vitest.shared`'s `NO_ACCOUNT` for every unit test, so a case that wants a deploy has to say so —
  // which is the same thing a CI runner has to do, and the whole point of the skip below.
  vi.stubEnv("SECRETS_STORE_ID", "store-1a2b3c");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(projectDir, { recursive: true, force: true });
});

/** What one run may vary. */
interface RunOptions {
  bindings?: { binding: string; database_id: string }[];
  baseUrl?: string;
  vars?: Record<string, string> | null;
  force?: boolean;
  namespaces?: { binding: string; id: string }[];
  composes?: Capability[];
  readTemplate?: (projectDir: string, entry: string) => Promise<WorkflowHostTemplate>;
  /** Extra app Workers beside `api` — a second Worker, or one whose config will not load. */
  alsoWorkers?: WorkerTarget[];
  /** The capabilities one Worker composes, per directory. Defaults to `composes` for every Worker. */
  capabilitiesFor?: (dir: string) => Promise<Capability[]>;
}

/** One `pithy deploy --kit` run against the fixture — the rows. {@link runReport} for the whole report. */
async function run(options: RunOptions = {}): Promise<KitWorkerDeploy[]> {
  return (await runReport(options)).workers;
}

/** One `pithy deploy --kit` run against the fixture, rows and problems both. */
async function runReport(options: RunOptions = {}): Promise<KitDeployReport> {
  const dir = await writeApp(options.bindings ?? PROVISIONED, options.baseUrl, options.namespaces);
  const workers: WorkerTarget[] = [{ name: "api", dir, hasWrangler: true }, ...(options.alsoWorkers ?? [])];
  return deployKitWorkers({
    projectDir,
    project: "acme",
    env: "prod",
    account: null,
    force: options.force,
    workers,
    capabilitiesFor: options.capabilitiesFor ?? (async () => options.composes ?? [EMAIL]),
    readTemplate: options.readTemplate ?? (async () => structuredClone(template)),
    readVars: async () => options.vars ?? null,
    runDeploy: async (configPath) => {
      const { readFile } = await import("node:fs/promises");
      deployed.push(JSON.parse(await readFile(configPath, "utf8")));
    },
  });
}

describe("deployKitWorkers", () => {
  test("deploys a composed capability's Worker, resolved for the target environment", async () => {
    const rows = await run();
    expect(rows).toEqual([
      {
        capability: "email",
        worker: "acme-prod-email",
        outcome: "deployed",
        reason: "acme-prod-email is not deployed.",
      },
    ]);
    const config = deployed[0];
    expect(config?.name).toBe("acme-prod-email");
    // The ids come off the app Worker's own stanza — the file `pithy provision` writes. Nothing was
    // created to learn them, which is the whole difference between deploying and provisioning.
    expect(config?.d1_databases?.find((entry) => entry.binding === "DB")?.database_id).toBe("db-1");
    expect(config?.vars?.BASE_URL).toBe("https://acme.example");
    expect(config?.vars?.[DEPLOY_STAMP_VAR]).toBe(
      `${PACKAGE_VERSION}/${config?.vars?.[DEPLOY_STAMP_VAR]?.split("/")[1]}`,
    );
    // **The adopter's configuration, off the composed capability.** The Secrets Store entry proves the
    // id reached the resolver rather than the `""` that used to; the theme proves the config did.
    expect(config?.secrets_store_secrets?.[0]?.store_id).toBe("store-1a2b3c");
    expect(JSON.parse(config?.vars?.EMAIL_THEME as string).accent).toBe(EMAIL.emailConfig.theme.accent);
  });

  test("a capability nothing composes is not in the set at all", async () => {
    expect(await run({ composes: [{ name: "auth" } as Capability, { name: "turnstile" } as Capability] })).toEqual([]);
  });

  test("skips a Worker whose stamp matches, and says which version is live", async () => {
    const first = await run();
    expect(first[0]?.outcome).toBe("deployed");
    const stamp = deployed[0]?.vars?.[DEPLOY_STAMP_VAR] as string;
    deployed = [];
    const second = await run({ vars: { [DEPLOY_STAMP_VAR]: stamp } });
    expect(second[0]).toEqual({
      capability: "email",
      worker: "acme-prod-email",
      outcome: "unchanged",
      reason: `@pithy-sh/email ${PACKAGE_VERSION} is deployed with this configuration.`,
    });
    expect(deployed).toEqual([]);
  });

  test("a changed base URL redeploys the Worker the stamp said was current", async () => {
    await run();
    const stamp = deployed[0]?.vars?.[DEPLOY_STAMP_VAR] as string;
    deployed = [];
    const rows = await run({ baseUrl: "https://acme.dev", vars: { [DEPLOY_STAMP_VAR]: stamp } });
    expect(rows[0]?.outcome).toBe("deployed");
    expect(rows[0]?.reason).toBe("Its resolved configuration changed.");
    expect(deployed[0]?.vars?.BASE_URL).toBe("https://acme.dev");
  });

  test("--force deploys a Worker whose stamp matches", async () => {
    await run();
    const stamp = deployed[0]?.vars?.[DEPLOY_STAMP_VAR] as string;
    deployed = [];
    const rows = await run({ force: true, vars: { [DEPLOY_STAMP_VAR]: stamp } });
    expect(rows[0]).toMatchObject({ outcome: "deployed", reason: "--force was given." });
    expect(deployed).toHaveLength(1);
  });

  describe("it creates nothing, so what is missing is a skip that names the fix", () => {
    test("a database this environment has no id for", async () => {
      const rows = await run({ bindings: [{ binding: "DB", database_id: "db-1" }] });
      expect(rows[0]).toEqual({
        capability: "email",
        worker: null,
        outcome: "skipped",
        reason: "prod has no EMAIL_SUPPRESSIONS, SECRETS database yet. Run pithy email provision --env prod.",
      });
      expect(deployed).toEqual([]);
    });

    test("a placeholder id left by the scaffold is not an id", async () => {
      const rows = await run({
        bindings: [
          { binding: "DB", database_id: "<database_id>" },
          { binding: "EMAIL_SUPPRESSIONS", database_id: "sup-1" },
          { binding: "SECRETS", database_id: "sec-1" },
        ],
      });
      expect(rows[0]?.outcome).toBe("skipped");
      expect(rows[0]?.reason).toContain("no DB database yet");
    });

    test("an environment the composing Worker has no address for", async () => {
      const rows = await run({ baseUrl: "" });
      expect(rows[0]).toEqual({
        capability: "email",
        worker: null,
        outcome: "skipped",
        reason:
          "api composes email and has no prod address, so the links it sends would go nowhere. Declare domains.prod in its pithy.config.ts.",
      });
    });

    /**
     * **The hole a `database_id` check could not see (#537).**
     *
     * `SECRETS_STORE_ID` is account-scoped and lives in `~/.config/pithy`, written by `pithy add
     * secrets` — which a CI runner does not have unless the job exports it, and a CI runner is exactly
     * who runs `pithy deploy --kit`. It went through as `""`, so the Worker deployed bound to a Secrets
     * Store entry with no store behind it, unable to read the master key that decrypts every secret it
     * holds, and the row printed `deployed`.
     */
    test("a Secrets Store id nothing on this machine supplied", async () => {
      vi.stubEnv("SECRETS_STORE_ID", "");
      const report = await runReport();
      expect(report.workers[0]).toEqual({
        capability: "email",
        worker: null,
        outcome: "skipped",
        reason:
          "SECRETS_STORE_ID is not set, so email's Worker would deploy unable to read its master key. Run pithy add secrets on this machine, or export SECRETS_STORE_ID for this run.",
      });
      expect(deployed).toEqual([]);
      // And it fails the command, because a run that skipped every kit Worker shipped none of them.
      expect(kitDeployFailed(report)).toBe(true);
    });

    test("a KV namespace the adopter's configuration asks for and the environment has no id for", async () => {
      const rows = await run({
        composes: [media({ recordStore: "kv" })],
        bindings: [
          { binding: "DB", database_id: "db-1" },
          { binding: "SECRETS", database_id: "sec-1" },
        ],
        readTemplate: readHostTemplate,
      });
      expect(rows[0]).toEqual({
        capability: "media",
        worker: null,
        outcome: "skipped",
        reason: "prod has no MEDIA namespace yet. Run pithy media provision --env prod.",
      });
      expect(deployed).toEqual([]);
    });
  });

  /**
   * The blocker, through the command: `pithy deploy --kit` must ship the adopter's configuration, not
   * the capability's schema defaults.
   *
   * Media is the sharpest case because the config decides a *binding*. On `recordStore: "kv"` the
   * registry read `MediaConfig.parse({})`, saw `"d1"`, and dropped the `MEDIA` binding — which
   * `pithy media provision` then bound again on its next run. Two commands, one Worker, each undoing
   * the other, and nothing anywhere said so.
   */
  test("ships the adopter's own capability configuration, bindings included", async () => {
    const rows = await run({
      composes: [media({ recordStore: "kv" })],
      namespaces: [{ binding: "MEDIA", id: "kv-media-1" }],
      bindings: [
        { binding: "DB", database_id: "db-1" },
        { binding: "SECRETS", database_id: "sec-1" },
      ],
      readTemplate: readHostTemplate,
    });
    expect(rows[0]).toMatchObject({ capability: "media", worker: "acme-prod-media", outcome: "deployed" });
    const config = deployed[0];
    expect(config?.kv_namespaces).toEqual([{ binding: "MEDIA", id: "kv-media-1" }]);
    expect(JSON.parse(config?.vars?.MEDIA_CONFIG as string).recordStore).toBe("kv");
  });

  test("a capability that will not resolve fails, and the row carries both halves of the refusal", async () => {
    // `capabilityLoadError`'s shape: the message explains it and the *action* is the whole remedy. A
    // row carrying only one of them is unactionable, and this row is the only place either is printed.
    const rows = await run({
      readTemplate: async () => {
        throw new ValidationError({
          message: "The email capability is not installed.",
          action: "Run pithy add email.",
          detail: "import: @pithy-sh/email/src/workflows/worker — ERR_MODULE_NOT_FOUND",
        });
      },
    });
    expect(rows[0]).toEqual({
      capability: "email",
      worker: null,
      outcome: "failed",
      reason: "The email capability is not installed. Run pithy add email.",
    });
    expect(deployed).toEqual([]);
  });

  /**
   * **Discovery's own failures, which used to leave no trace at all (#537).**
   *
   * `discoverHostWorkers` drops what it cannot read and says so in a note. This function took the
   * hosts and dropped the notes, so an adopter with a broken `apps/admin/pithy.config.ts` got a run
   * that shipped no email Worker, printed nothing about the kit, and exited 0 — indistinguishable
   * from a project that composes no kit Worker at all. That is the silent staleness the issue is
   * about, arriving through the command that exists to close it.
   */
  describe("what it could not read is a problem, and problems fail the command", () => {
    /** A second app Worker in the fixture — the one whose config is the subject of each case. */
    function alsoAdmin(hasWrangler: boolean): WorkerTarget[] {
      return [{ name: "admin", dir: join(projectDir, "apps", "admin"), hasWrangler }];
    }

    test("a Worker whose capabilities cannot be read, beside a Worker that shipped", async () => {
      const report = await runReport({
        alsoWorkers: alsoAdmin(true),
        capabilitiesFor: async (dir) => {
          if (dir.endsWith("admin")) throw new InternalError({ message: "Could not load pithy.config.ts." });
          return [EMAIL];
        },
      });

      expect(report.workers.map((row) => row.outcome)).toEqual(["deployed"]);
      expect(report.problems).toEqual([
        "admin: its capabilities could not be read, so its capability hosts will not run.",
        "  Could not load pithy.config.ts.",
      ]);
      // The whole point: a green build was the old answer to this.
      expect(kitDeployFailed(report)).toBe(true);
    });

    test("a composition that will not assemble, which leaves no hosts and used to leave no rows", async () => {
      const refuses: Capability = {
        ...EMAIL,
        compose: () => {
          throw new ValidationError({ message: "email needs auth composed alongside it." });
        },
      };

      const report = await runReport({ composes: [refuses] });

      expect(report.workers).toEqual([]);
      expect(report.problems).toEqual([
        "The capability hosts could not be assembled, so none of them will run.",
        "  email needs auth composed alongside it.",
      ]);
      expect(kitDeployFailed(report)).toBe(true);
      expect(deployed).toEqual([]);
    });

    /**
     * **A dev-only process is not a broken Worker.** A Vite frontend joins the set through
     * `pithy.worker.jsonc` alone: no `pithy.config.ts`, none expected, nothing composed. Failing a
     * deploy because a project has a front end would be a worse defect than the one above it.
     */
    test("a process with no config and no wrangler.jsonc is neither a host nor a problem", async () => {
      const report = await runReport({
        alsoWorkers: alsoAdmin(false),
        capabilitiesFor: async (dir) => {
          if (dir.endsWith("admin")) throw new NotFoundError({ message: `No pithy.config.ts in ${dir}.` });
          return [EMAIL];
        },
      });

      expect(report.problems).toEqual([]);
      expect(report.workers.map((row) => row.outcome)).toEqual(["deployed"]);
      expect(kitDeployFailed(report)).toBe(false);
    });

    /**
     * **The pass itself must not throw (#537).**
     *
     * It runs *after* `deployProject`, so a throw here aborts the `--json` line for Workers that are
     * already live: a CI step reads no `workers[]` payload for a deploy that happened. Every such
     * failure is a problem on the report instead, and the exit code still says the run failed.
     */
    test("a throw from the pass is a problem, not a lost payload", async () => {
      const report = await runReport({
        alsoWorkers: [{ name: "email", dir: join(projectDir, "apps", "email"), hasWrangler: true }],
      });

      expect(report.workers).toEqual([]);
      expect(report.problems).toEqual([
        'A Worker in apps/ is named "email", which is also the email capability\'s host. Rename that Worker with pithy worker add, or move it, so EMAIL_ORIGIN names one process.',
      ]);
      expect(kitDeployFailed(report)).toBe(true);
    });
  });
});

describe("kitDeployFailed", () => {
  /** A report with no problems — the shape every row-only case is about. */
  const rows = (workers: KitWorkerDeploy[]): KitDeployReport => ({ workers, problems: [] });

  test("a failed row fails the command", () => {
    expect(kitDeployFailed(rows([{ capability: "email", worker: "w", outcome: "failed", reason: "boom" }]))).toBe(true);
  });

  test("a run where every Worker was skipped fails, because it deployed no kit Worker at all", () => {
    expect(
      kitDeployFailed(
        rows([
          { capability: "email", worker: null, outcome: "skipped", reason: "run provision" },
          { capability: "media", worker: null, outcome: "skipped", reason: "run provision" },
        ]),
      ),
    ).toBe(true);
  });

  test("one skip beside one deploy does not, because something did ship", () => {
    expect(
      kitDeployFailed(
        rows([
          { capability: "email", worker: null, outcome: "skipped", reason: "run provision" },
          { capability: "media", worker: "acme-prod-media", outcome: "deployed", reason: "not deployed" },
        ]),
      ),
    ).toBe(false);
  });

  test("every Worker unchanged is a success — nothing needed shipping", () => {
    expect(
      kitDeployFailed(
        rows([{ capability: "email", worker: "acme-prod-email", outcome: "unchanged", reason: "current" }]),
      ),
    ).toBe(false);
  });

  test("a project composing no kit Worker at all is a success", () => {
    expect(kitDeployFailed(rows([]))).toBe(false);
  });

  /**
   * **A problem outranks every row, including a Worker that shipped (#537).**
   *
   * A problem means the *set* is short: a Worker whose capabilities could not be read composes hosts
   * nothing in this run ever saw. Deploying the hosts it did see is not the job half done, it is the
   * job done to an unknown extent — and the only place that can be said is the exit code.
   */
  test("a problem fails the command even beside a Worker that deployed", () => {
    expect(
      kitDeployFailed({
        workers: [{ capability: "email", worker: "acme-prod-email", outcome: "deployed", reason: "changed" }],
        problems: ["admin: its capabilities could not be read, so its capability hosts will not run."],
      }),
    ).toBe(true);
  });

  test("a problem on its own fails it too — the empty set that used to exit 0", () => {
    expect(kitDeployFailed({ workers: [], problems: ["The capability hosts could not be assembled."] })).toBe(true);
  });
});

describe("summarizeKitDeploy", () => {
  test("names the Worker, the outcome and the reason, in that order", () => {
    expect(
      summarizeKitDeploy({
        capability: "email",
        worker: "acme-prod-email",
        outcome: "unchanged",
        reason: "@pithy-sh/email 0.1.7 is deployed with this configuration.",
      }),
    ).toBe("acme-prod-email: unchanged. @pithy-sh/email 0.1.7 is deployed with this configuration.");
  });

  test("falls back to the capability when there is no Worker name to print", () => {
    expect(
      summarizeKitDeploy({
        capability: "email",
        worker: null,
        outcome: "skipped",
        reason: "Run pithy email provision.",
      }),
    ).toBe("email: skipped. Run pithy email provision.");
  });

  // Color is off for every unit test (`vitest.shared`), so this asserts the sentence rather than the
  // escape codes — what matters here is that a problem is printed whole, not summarized away.
  test("a problem prints as it was written", () => {
    expect(summarizeKitProblem("admin: its capabilities could not be read.")).toBe(
      "admin: its capabilities could not be read.",
    );
  });
});
