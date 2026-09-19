// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { featureResourceName } from "@pithy-sh/core/src/naming/feature";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { email } from "@pithy-sh/email/src/capability";
import { PACKAGE_VERSION } from "@pithy-sh/email/src/version.generated";
import { ledger } from "@pithy-sh/ledger/src/capability";
import { media } from "@pithy-sh/media/src/capability";
import { payments } from "@pithy-sh/payments/src/capability";
import { testers } from "@pithy-sh/testers/src/capability";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readHostTemplate } from "../capabilities/hostRegistry";
import { DEPLOY_STAMP_VAR } from "../provision/deployStamp";
import { narrate, type ProgressEvent } from "../terminal/progress";
import { linkKitPackages, materializeKitPackage } from "../test-utils/linkKit";
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
    runDeploy: async (args) => {
      const { readFile } = await import("node:fs/promises");
      const { configFromArgs } = await import("./effectiveConfig");
      // Through the argv, the way wrangler resolves it: an argv that stopped naming the generated
      // config would otherwise still read back as a deploy of it (#584).
      deployed.push(JSON.parse(await readFile(configFromArgs(args) as string, "utf8")));
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
        reason: "It was not on the account.",
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

  /**
   * **A host that deployed is never reported as not deployed** (#645). Kit hosts are deployed with
   * `workers_dev: false` — they are reached through bindings, never by an address — so nothing about them may
   * be established by probing a `workers.dev` URL, and nothing here does: whether one is there is read off the
   * account's own API (`readVars`), before the upload. The line printed after the upload used to restate that
   * reading in the present tense — `acme-prod-email: deployed. acme-prod-email is not deployed.` — two
   * statements, the second false by the time it was read.
   */
  test("a first deploy of a workers.dev-less host reads as one true statement, and probes no address", async () => {
    const probes: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      probes.push(String(input instanceof Request ? input.url : input));
      throw new Error("no network in this test");
    }) as typeof fetch;
    try {
      const rows = await run({
        vars: null,
        readTemplate: async () => ({ ...structuredClone(template), workers_dev: false }),
      });
      expect(deployed[0]?.workers_dev).toBe(false);
      expect(rows.map(summarizeKitDeploy)).toEqual(["acme-prod-email: deployed. It was not on the account."]);
      expect(rows.map(summarizeKitDeploy).join("\n")).not.toContain("not deployed");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(probes).toEqual([]);
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
        reason: "prod has no EMAIL_SUPPRESSIONS, SECRETS database yet. Run pithy email provision.",
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
        reason: "prod has no MEDIA namespace yet. Run pithy media provision.",
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

/**
 * **The kit half accounts for itself while the run is still going (#578).**
 *
 * The `▸` line for a Worker that actually uploads comes from `capabilities/hostDeploy.ts`, at the spawn.
 * This is the other half: the row, as it settles — and it covers the three outcomes that never reach a
 * spawn at all, `unchanged`, `skipped` and `failed`, so an operator reads every capability's answer
 * beside the work rather than in a block after the last upload finished.
 */
describe("each capability settles as it is decided", () => {
  test("streams the row it would otherwise have held to the end", async () => {
    const events: ProgressEvent[] = [];
    const rows = await narrate(
      (event) => events.push(event),
      async () => run({ vars: null }),
    );

    expect(events.filter((event) => event.phase === "settled")).toEqual(
      rows.map((row) => ({ phase: "settled", line: summarizeKitDeploy(row) })),
    );
    // Not an empty set dressed up as agreement: the fixture composes email, so there is a row to settle.
    expect(rows).toHaveLength(1);
  });

  test("a capability this project cannot deploy yet settles too, with the reason", async () => {
    const events: ProgressEvent[] = [];
    const rows = await narrate(
      (event) => events.push(event),
      async () => run({ bindings: [{ binding: "DB", database_id: "db-1" }] }),
    );

    expect(rows[0]?.outcome).toBe("skipped");
    expect(events).toEqual([{ phase: "settled", line: summarizeKitDeploy(rows[0] as KitWorkerDeploy) }]);
  });
});

/**
 * **A feature's kit Workers (#643).** A feature's ids are in the generated config under `.wrangler/`, in its
 * `env.feature` stanza; the top level of that file is the tracked one's, which is `dev`'s. `stanzaFor` read the
 * whole file, so every kit Worker on a feature found `dev`'s ids — the local binding names — or none. And a
 * feature's host is named for the feature, never `<project>-feature-<capability>`, which every branch shares.
 */
describe("a feature's kit Workers", () => {
  const FEATURE = { project: "acme", issue: "643", slug: "feature-address" };
  const ORIGIN = "https://acme-f643-feature-address--api.acme.workers.dev";

  /** The generated feature config provisioning writes: the tracked top level, and the feature's own stanza. */
  async function writeFeatureApp(): Promise<string> {
    const dir = join(projectDir, "apps", "api");
    const generated = join(dir, ".wrangler", "pithy");
    await mkdir(generated, { recursive: true });
    await writeFile(join(dir, "wrangler.jsonc"), `${JSON.stringify({ name: "api" })}\n`);
    await writeFile(
      join(generated, "wrangler.feature.jsonc"),
      // JSONC, as `writeJsonc` leaves it: a comment the generation carried over from the tracked file.
      `// The generated feature config.\n${JSON.stringify(
        {
          name: "api",
          d1_databases: [
            { binding: "DB", database_id: "DB" },
            { binding: "EMAIL_SUPPRESSIONS", database_id: "EMAIL_SUPPRESSIONS" },
            { binding: "SECRETS", database_id: "SECRETS" },
          ],
          env: {
            feature: {
              name: "acme-f643-feature-address--api",
              routes: [],
              d1_databases: [
                { binding: "DB", database_id: "feature-db" },
                { binding: "EMAIL_SUPPRESSIONS", database_id: "feature-sup" },
                { binding: "SECRETS", database_id: "feature-sec" },
              ],
              vars: { ENVIRONMENT: "feature", BASE_URL: ORIGIN },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    return dir;
  }

  /** The feature's own databases, as the account would answer for them: each id, under the feature's name. */
  const OWNED = async () => ({
    d1: new Map([
      ["feature-db", featureResourceName(FEATURE, "DB", "d1")],
      ["feature-sup", featureResourceName(FEATURE, "EMAIL_SUPPRESSIONS", "d1")],
      ["feature-sec", featureResourceName(FEATURE, "SECRETS", "d1")],
    ]),
    kv: new Map<string, string>(),
  });

  function deployFeature(
    dir: string,
    feature: typeof FEATURE | undefined,
    composes: Capability[] = [EMAIL],
    owned: typeof OWNED | null = OWNED,
  ) {
    return deployKitWorkers({
      projectDir,
      project: "acme",
      env: "feature",
      account: null,
      ...(feature ? { feature } : {}),
      ...(owned ? { featureOwned: owned } : {}),
      workers: [{ name: "api", dir, hasWrangler: true }],
      capabilitiesFor: async () => composes,
      readTemplate: async () => structuredClone(template),
      readVars: async () => null,
      runDeploy: async (args) => {
        const { readFile } = await import("node:fs/promises");
        const { configFromArgs } = await import("./effectiveConfig");
        deployed.push(JSON.parse(await readFile(configFromArgs(args) as string, "utf8")));
      },
    });
  }

  test("reads env.feature from the generated config, and names the host for the feature", async () => {
    const report = await deployFeature(await writeFeatureApp(), FEATURE);

    expect(report.problems).toEqual([]);
    expect(report.workers.map((row) => [row.worker, row.outcome])).toEqual([
      ["acme-f643-feature-address--email", "deployed"],
    ]);
    const config = deployed[0];
    expect(config?.d1_databases?.map((entry) => entry.database_id)).toEqual([
      "feature-db",
      "feature-sup",
      "feature-sec",
    ]);
    expect(config?.vars?.BASE_URL).toBe(ORIGIN);
    expect(config?.vars?.ENVIRONMENT).toBe("feature");
    expect(config?.secrets_store_secrets?.[0]?.secret_name).toBe("acme-f643-feature-address--secrets-encryption-keys");
  });

  /**
   * **The host gate follows every bound id to what owns it (#643).** A feature host bound to a database the feature
   * did not create — production's, by id — fails rather than deploys, whatever name sits beside the id; and with
   * no way to ask the account, the feature owns nothing a host could bind by id.
   */
  test("refuses a feature host bound to a database the feature did not create", async () => {
    const notOurs = async () => ({ d1: new Map([["feature-db", "acme-prod-db"]]), kv: new Map<string, string>() });
    const report = await deployFeature(await writeFeatureApp(), FEATURE, [EMAIL], notOurs);
    expect(report.workers.map((row) => row.outcome)).toEqual(["failed"]);
    expect(report.workers[0]?.reason).toContain("d1 DB: acme-prod-db");
    expect(report.workers[0]?.reason).toContain("id feature-sup is not one this feature created");
    expect(deployed).toEqual([]);

    const blind = await deployFeature(await writeFeatureApp(), FEATURE, [EMAIL], null);
    expect(blind.workers.map((row) => row.outcome)).toEqual(["failed"]);
    expect(deployed).toEqual([]);
  });

  test("refuses a feature pass that does not know which feature it is — deploying nothing", async () => {
    const report = await deployFeature(await writeFeatureApp(), undefined);

    expect(report.problems).toEqual([
      "A feature's kit Workers are named for the feature. Run this from its feature/<issue>-<slug> branch.",
    ]);
    expect(deployed).toEqual([]);
  });

  /**
   * **Every composed host, not email's alone (#643).** Media joins a feature the way email does — the same
   * registry entry, handed the feature — so its Worker, its Workflows and its bucket are the feature's own.
   */
  test("deploys every composed host for the feature, each named for it", async () => {
    const report = await deployFeature(await writeFeatureApp(), FEATURE, [EMAIL, media({})]);

    expect(report.problems).toEqual([]);
    expect(report.workers.map((row) => [row.capability, row.worker, row.outcome])).toEqual([
      ["email", "acme-f643-feature-address--email", "deployed"],
      ["media", "acme-f643-feature-address--media", "deployed"],
    ]);
    const mediaHost = deployed.find((config) => config.name === "acme-f643-feature-address--media");
    for (const workflow of mediaHost?.workflows ?? []) expect(workflow.name.startsWith("acme-f643-")).toBe(true);
  });

  /** F3 of the review: an app Worker whose feature name is a kit host's is refused, deploying nothing. */
  test("refuses an app Worker named like a kit host, deploying nothing", async () => {
    const dir = await writeFeatureApp();
    const report = await deployKitWorkers({
      projectDir,
      project: "acme",
      env: "feature",
      account: null,
      feature: FEATURE,
      workers: [
        { name: "api", dir, hasWrangler: true },
        { name: "acme-payments", dir: join(projectDir, "apps", "payments"), hasWrangler: true },
      ],
      capabilitiesFor: async (workerDir) => (workerDir === dir ? [EMAIL] : []),
      readTemplate: async () => structuredClone(template),
      readVars: async () => null,
      runDeploy: async () => {},
    });
    expect(report.problems.join(" ")).toContain("the name this feature's payments host takes");
    expect(report.workers).toEqual([]);
    expect(deployed).toEqual([]);
  });
});

/**
 * **A host that composes nothing is handed the peers the project composes** (#645).
 *
 * The payments reconcile host credits a balance when a pass repairs a purchase whose product has a
 * `grants.ledger` clause — and it may not import `@pithy-sh/ledger` to do it, because a project that never
 * installed the ledger then cannot bundle the host at all. So `pithy deploy --kit` deploys it from a generated
 * entry that imports the ledger's surface from the project's own install and hands it over.
 *
 * This runs the command end to end with the real registry, the real payments template and resolver, and — in
 * place of the upload — **wrangler's own bundler** over exactly the config and entry the command wrote. So what
 * is proved is not that a string was generated but that the Worker it describes builds, with the ledger in it.
 */
describe("a kit host handed the peers the project composes", () => {
  const GRANTING = {
    billingSubject: "user" as const,
    rails: { apple: true },
    products: {
      coins_100: {
        type: "consumable" as const,
        name: "100 coins",
        grants: { ledger: { currency: "coins", amount: 100 } },
        apple: { productId: "com.acme.coins100" },
      },
    },
  };

  /** What `runDeploy` saw: the config, the entry it named, and what wrangler made of them. */
  interface Shipped {
    config: WorkflowHostTemplate;
    entry: string | null;
    bundle: { status: number | null; output: string; code: string | null };
  }

  async function deployPayments(capabilities: Capability[]): Promise<{ report: KitDeployReport; shipped: Shipped[] }> {
    await linkKitPackages(projectDir, ["ledger"]);
    // A copy, never the link: a deploy writes its temp config and generated entry beside the host's worker,
    // and through a link that is the repository's own `packages/payments/src/workflows` — where
    // `turboInputs.test.ts`, running beside this file, hashes `packages/**` twice and saw the file once (#645
    // review, CI run 35468486220). `linkKit.ts` states the rule: the link or the write, never both.
    await materializeKitPackage(projectDir, "payments");
    const dir = await writeApp(PROVISIONED);
    const shipped: Shipped[] = [];
    const report = await deployKitWorkers({
      projectDir,
      project: "acme",
      env: "prod",
      account: null,
      workers: [{ name: "api", dir, hasWrangler: true }],
      capabilitiesFor: async () => capabilities,
      readTemplate: readHostTemplate,
      readVars: async () => null,
      runDeploy: async (args, cwd) => {
        const { spawnSync } = await import("node:child_process");
        const { existsSync, readFileSync } = await import("node:fs");
        const { configFromArgs } = await import("./effectiveConfig");
        const configPath = configFromArgs(args) as string;
        const config = JSON.parse(readFileSync(configPath, "utf8")) as WorkflowHostTemplate;
        const main = join(cwd, config.main);
        const outdir = join(projectDir, "out");
        const home = join(projectDir, "home");
        await mkdir(join(home, ".config"), { recursive: true });
        // The bundler wrangler deploys with, and nothing past it: `--dry-run` builds and stops, with no
        // account and no credentials in its environment.
        const result = spawnSync(
          process.execPath,
          [
            join(import.meta.dirname, "..", "..", "node_modules", "wrangler", "bin", "wrangler.js"),
            "deploy",
            "--dry-run",
            "--outdir",
            outdir,
            "--config",
            configPath,
          ],
          {
            cwd,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              HOME: home,
              XDG_CONFIG_HOME: join(home, ".config"),
              WRANGLER_LOG_PATH: join(projectDir, "logs"),
              WRANGLER_SEND_METRICS: "false",
              CI: "1",
            },
          },
        );
        const bundled = join(outdir, `${config.main.replace(/^\.\//, "").replace(/\.ts$/, "")}.js`);
        shipped.push({
          config,
          entry: config.main.endsWith("worker.ts") ? null : readFileSync(main, "utf8"),
          bundle: {
            status: result.status,
            output: `${result.stdout}\n${result.stderr}`,
            code: existsSync(bundled) ? readFileSync(bundled, "utf8") : null,
          },
        });
      },
    });
    return { report, shipped };
  }

  test("a catalog that credits a balance deploys its reconcile host with the project's ledger in it", async () => {
    const { report, shipped } = await deployPayments([
      payments(GRANTING),
      ledger({ currencies: [{ code: "coins", name: "Coins" }] }),
    ]);

    expect(report.problems).toEqual([]);
    expect(report.workers.map((row) => [row.worker, row.outcome])).toEqual([["acme-prod-payments", "deployed"]]);
    const [host] = shipped;
    expect(host?.config.main).toBe("./.pithy-host.prod.ts");
    expect(host?.entry).toContain('providePeers({ "ledger": peer0 });');
    expect(host?.entry).toContain("ledger/src/peer.ts");
    expect(host?.bundle.status, host?.bundle.output).toBe(0);
    // The ledger's own primitive, bundled into the host — the credit a repair owes can now be made.
    expect(host?.bundle.code).toContain("pithy_ledger_accounts");
    // And the generated entry is gone again: it names paths on this machine and lives inside a package.
    const { existsSync } = await import("node:fs");
    expect(
      existsSync(join(projectDir, "node_modules", "@pithy-sh", "payments", "src", "workflows", ".pithy-host.prod.ts")),
    ).toBe(false);
  }, 180_000);

  test("a catalog that credits nothing deploys the host from its own entry, with no ledger to resolve", async () => {
    const { coins_100: _credits, ...features } = GRANTING.products;
    const { report, shipped } = await deployPayments([
      payments({
        ...GRANTING,
        products: {
          ...features,
          pro: { type: "non_consumable", name: "Pro", entitlements: ["pro"], apple: { productId: "com.acme.pro" } },
        },
      }),
    ]);

    expect(report.workers.map((row) => row.outcome)).toEqual(["deployed"]);
    expect(shipped[0]?.config.main).toBe("./worker.ts");
    expect(shipped[0]?.entry).toBeNull();
  }, 180_000);
});

/**
 * **A host released before the seam deploys exactly as it did** (#645 review). The CLI and the packages it
 * deploys are released apart, and the dashboard runs testers 0.2.9 beside auth — a testers with no `hostPeers`,
 * whose own `worker.ts` reaches auth itself. The first cut of #645 generated an entry importing `hostPeers`
 * anyway, and that deploy failed. Staged here by copying the workspace package and removing the module the
 * release predates; what is asserted is what the command hands wrangler, which is what changed.
 */
describe("a kit host older than the peer seam", () => {
  test("testers from before the seam, beside auth, deploys from its own worker with no entry written", async () => {
    await linkKitPackages(projectDir, ["auth"]);
    // Copies, because this deploys both hosts and each writes beside its worker — see the note on `payments`.
    await materializeKitPackage(projectDir, "email");
    await materializeKitPackage(projectDir, "testers");
    const home = join(projectDir, "node_modules", "@pithy-sh", "testers");
    await rm(join(home, "src", "workflows", "hostPeers.ts"));
    await rm(join(home, "dist", "workflows", "hostPeers.js"), { force: true });
    const dir = await writeApp(PROVISIONED);
    const shipped: { cwd: string; main: string; files: string[] }[] = [];
    // A current auth: the testers() composed here is the workspace's, whose compose refuses an auth too old to
    // read. What is from before the seam is the installed testers the command deploys.
    const auth = {
      name: "auth",
      requiredBindings: [],
      authConfig: {},
      authPeer: { authDatabase: () => undefined },
    } as unknown as Capability;
    const report = await deployKitWorkers({
      projectDir,
      project: "acme",
      env: "prod",
      account: null,
      workers: [{ name: "api", dir, hasWrangler: true }],
      capabilitiesFor: async () => [EMAIL, auth, testers({ baseUrl: "https://acme.example" })],
      readTemplate: readHostTemplate,
      readVars: async () => null,
      runDeploy: async (args, cwd) => {
        const { readdirSync } = await import("node:fs");
        const { configFromArgs } = await import("./effectiveConfig");
        const config = JSON.parse(await readFile(configFromArgs(args) as string, "utf8")) as WorkflowHostTemplate;
        shipped.push({ cwd, main: config.main, files: readdirSync(cwd) });
      },
    });

    const row = report.workers.find((entry) => entry.capability === "testers");
    expect(row?.outcome, JSON.stringify(report)).toBe("deployed");
    const host = shipped.find((entry) => entry.cwd.includes(join("@pithy-sh", "testers")));
    expect(host?.main).toBe("./worker.ts");
    // Nothing generated beside the config wrangler read: the release reaches auth itself, as it always did.
    expect(host?.files.filter((file) => file.startsWith(".pithy-host."))).toEqual([]);
  });
});

/**
 * **A failed wrangler step shows wrangler's own reason** (#645). The payments host failed to bundle for weeks
 * as `wrangler deploy failed.`, with the one line that said why — `Could not resolve
 * "@pithy-sh/ledger/src/ledger"` — only in wrangler's log file.
 *
 * Driven through the command and the real `runWrangler`, spawning **real wrangler** as a dry run over a host
 * whose entry imports a package the project does not have: the upload is the only thing replaced, so what
 * fails is the bundle, exactly as it failed on the account.
 */
describe("a kit host whose bundle cannot resolve an import", () => {
  test("prints wrangler's error lines under the failure line", async () => {
    await materializeKitPackage(projectDir, "email");
    const workflows = join(projectDir, "node_modules", "@pithy-sh", "email", "src", "workflows");
    await writeFile(
      join(workflows, "broken.ts"),
      [
        'import { openLedger } from "@pithy-sh/ledger/src/ledger";',
        "export default { fetch: () => new Response(String(openLedger)) };",
        "",
      ].join("\n"),
    );
    const home = join(projectDir, "home");
    await mkdir(join(home, ".config"), { recursive: true });
    const { runWrangler } = await import("./wrangler");
    const dir = await writeApp(PROVISIONED);
    const report = await deployKitWorkers({
      projectDir,
      project: "acme",
      env: "prod",
      account: null,
      workers: [{ name: "api", dir, hasWrangler: true }],
      capabilitiesFor: async () => [EMAIL],
      readTemplate: async () => ({ ...structuredClone(template), main: "./broken.ts" }),
      readVars: async () => null,
      // The default runner's call, with `--dry-run` added so wrangler bundles and stops: no account, no upload.
      runDeploy: async (args, cwd) => {
        await runWrangler([...args, "--dry-run"], {
          account: null,
          cwd,
          bin: join(import.meta.dirname, "..", "..", "node_modules", "wrangler", "bin", "wrangler.js"),
          env: {
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            WRANGLER_LOG_PATH: join(projectDir, "logs"),
            WRANGLER_SEND_METRICS: "false",
          },
        });
      },
    });

    expect(report.workers.map((row) => row.outcome)).toEqual(["failed"]);
    const [line, ...under] = summarizeKitDeploy(report.workers[0] as KitWorkerDeploy).split("\n");
    expect(line).toMatch(/^acme-prod-email: failed\. .*wrangler\.js deploy failed\.$/);
    expect(under.join("\n")).toContain('✘ [ERROR] Could not resolve "@pithy-sh/ledger/src/ledger"');
    expect(under.join("\n")).toContain("broken.ts");
  }, 180_000);
});
