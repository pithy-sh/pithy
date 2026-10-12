// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputRequiredError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CreateCliAuditOptions } from "../audit/cliAudit";
import type { AddResult } from "../capabilities/flow";
import type { AddPlan } from "../capabilities/planAdd";
import { emptyPlan } from "../plan/plan";
import type { WorkerConfig } from "../project/config";
import { scaffoldProject } from "../project/scaffold";
import type { WorkerTarget } from "../project/workers";
import { latchInputMode, mayPrompt } from "../terminal/inputMode";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import add, { addPlanText, addPrompts, buildAudit, targetWorker } from "./add";

/**
 * The add flow itself — install, wire, migrate — is `capabilities/flow.test.ts`'s. Here it is replaced
 * with what it returned, so the command's own body runs: the Worker it resolves, the payload it writes.
 */
const flow = vi.hoisted(() => ({ result: undefined as unknown }));
vi.mock("../capabilities/flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities/flow")>()),
  runAdd: async () => flow.result,
}));

/**
 * What the command handed the follow-up read (#697), recorded rather than performed: which environments it
 * read as ready, and whether it read the add as having brought a migration. The reads themselves are
 * `capabilities/addFollowUp.test.ts`'s; a ready environment the stub names stands in for a provisioned one.
 */
const followUp = vi.hoisted(() => ({
  asked: [] as { ready: readonly string[]; brought: boolean; productionEnvironments?: readonly string[] }[],
}));
vi.mock("../capabilities/addFollowUp", async (importOriginal) => {
  const real = await importOriginal<typeof import("../capabilities/addFollowUp")>();
  return {
    ...real,
    readyEnvironments: async () => ["staging"],
    addFollowUp: async (options: Parameters<typeof real.addFollowUp>[0]) => {
      followUp.asked.push({
        ready: options.ready,
        brought: options.brought,
        ...(options.productionEnvironments !== undefined
          ? { productionEnvironments: options.productionEnvironments }
          : {}),
      });
      return real.addFollowUp({
        ...options,
        reachable: true,
        unprovisioned: async () => [],
        readLedger: async () => ({ state: "read", pending: 1, undeclared: [] }),
      });
    },
  };
});

/** Discovery seam: the `apps/*` set, without a filesystem. */
function discovery(...names: string[]) {
  return async (): Promise<WorkerTarget[]> => names.map((name) => ({ name, dir: `/project/apps/${name}` }));
}

/** Config seam: every worker composes nothing — this suite is about *which* worker, not what's in it. */
const loadConfig = async (): Promise<WorkerConfig> => ({ capabilities: [] });

describe("add command", () => {
  test("meta and args shape — --worker names the worker to wire", () => {
    const args = add.args as Record<string, { type: string; default?: unknown; required?: boolean }>;
    expect(add.meta).toMatchObject({ name: "add" });
    expect(Object.keys(args)).toEqual([
      "capability",
      "list",
      "worker",
      "set",
      "eject",
      "force",
      "with-prerequisites",
      "dry-run",
      "json",
    ]);
    expect(args.capability).toMatchObject({ type: "positional", required: false });
    expect(args.worker).toMatchObject({ type: "string" });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });
});

describe("buildAudit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("looks the audit database up from the project root, narrowed to the target worker", async () => {
    // The audit database is discovered by enumerating `<projectDir>/apps`, so `projectDir` must be the
    // project root. Passing the Worker's own directory finds no `apps/` beneath it, and every add/remove
    // event is silently dropped — the Worker is named through `worker`, which is what narrows the lookup.
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-add-audit-"));
    // Through the environment: the credentials are account-scoped since #182, so a `.dev.vars` in the
    // project supplies nothing. The overlay is what CI uses and needs no config directory here.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
    const seen: CreateCliAuditOptions[] = [];
    try {
      const emit = await buildAudit({
        projectDir,
        account: null,
        worker: "api",
        env: "staging", // the shape `pithy remove --drop --env staging` builds
        capabilities: [],
        create: async (options) => {
          seen.push(options);
          return async () => {};
        },
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]?.projectDir).toBe(projectDir);
      expect(seen[0]?.projectDir).not.toBe(join(projectDir, "apps", "api"));
      expect(seen[0]?.worker).toBe("api");
      expect(seen[0]?.env).toBe("staging");
      // Always callable, whatever the factory returned.
      await expect(emit({ action: "capability/removed", outcome: "success" })).resolves.toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("is an inert emitter — and builds nothing — without Cloudflare credentials", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-add-audit-"));
    try {
      const emit = await buildAudit({
        projectDir,
        account: null,
        worker: "api",
        env: "dev",
        capabilities: [],
        create: async () => {
          throw new Error("must not build an emitter without credentials");
        },
      });
      await expect(emit({ action: "capability/added", outcome: "success" })).resolves.toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("targetWorker", () => {
  test("a single-worker project needs no --worker", async () => {
    const target = await targetWorker("dev", {
      projectDir: "/project",
      interactive: false,
      discoverWorkers: discovery("api"),
      loadConfig,
    });
    expect(target.name).toBe("api");
    expect(target.dir).toBe("/project/apps/api");
  });

  test("--worker picks one out of several", async () => {
    const target = await targetWorker("dev", {
      projectDir: "/project",
      worker: "edge",
      interactive: false,
      discoverWorkers: discovery("api", "edge"),
      loadConfig,
    });
    expect(target.dir).toBe("/project/apps/edge");
  });

  test("several workers and no --worker fails non-interactively, naming them", async () => {
    // The `--json` / no-TTY path: an agent gets told exactly what to pass, never a prompt it can't answer.
    const failure = await targetWorker("dev", {
      projectDir: "/project",
      interactive: false,
      discoverWorkers: discovery("api", "edge"),
      loadConfig,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InputRequiredError);
    const payload = (failure as InputRequiredError).payload;
    expect(payload.action).toContain("--worker");
    expect(payload.action).toContain("api, edge");
    expect(payload).toMatchObject({ code: "input/required", flag: "--worker", choices: ["api", "edge"] });
  });

  test("an unknown --worker fails, naming the known ones", async () => {
    const failure = await targetWorker("dev", {
      projectDir: "/project",
      worker: "ghost",
      interactive: false,
      discoverWorkers: discovery("api", "edge"),
      loadConfig,
    }).catch((error: unknown) => error);

    // The call's mistake, exit 2: a different `--worker`, not something to set up first.
    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).payload.message).toContain("ghost");
  });

  test("a project with no workers fails with the worker-add action", async () => {
    // A real project root (it has a pithy.config.ts) that simply holds no workers yet.
    const projectDir = await mkdtemp(join(tmpdir(), "pithy-add-noworkers-"));
    await writeFile(join(projectDir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    try {
      const failure = await targetWorker("dev", {
        projectDir,
        interactive: false,
        discoverWorkers: discovery(),
        loadConfig,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NotFoundError);
      expect((failure as NotFoundError).payload.action).toContain("pithy worker add");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("outside a project entirely, it points at pithy init instead", async () => {
    // Being in the wrong directory is a different problem from having no workers — don't conflate them.
    const failure = await targetWorker("dev", {
      projectDir: join(tmpdir(), "pithy-not-a-project-at-all"),
      interactive: false,
      discoverWorkers: discovery(),
      loadConfig,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).payload.action).toContain("pithy init");
  });
});

/**
 * **The two prompts `pithy add` hands its flow, and when (#697).** The flow asks only through what it is
 * handed, so this is the whole gate: both prompts when the run may ask, neither when it may not, and the
 * flow's own refusals — `input/required`, naming `--set` or `--with-prerequisites` — do the rest.
 */
describe("addPrompts", () => {
  afterEach(() => latchInputMode(false));

  test("a run that may ask hands the flow both prompts", () => {
    const prompts = addPrompts(true);
    expect(typeof prompts.prompt).toBe("function");
    expect(typeof prompts.askPrerequisites).toBe("function");
  });

  test("a run that may not ask hands it neither", () => {
    expect(addPrompts(false)).toEqual({});
  });

  test("the switch reaches it through the seam, terminal or not", () => {
    latchInputMode(true);
    expect(addPrompts(mayPrompt(false, { stdin: { isTTY: true }, stdout: { isTTY: true } }))).toEqual({});
  });
});

/** Held to the schema `pithy schema add` publishes, from a real run in a scaffolded project (#697). */
describe("pithy add --json conforms to its published payload", () => {
  let dir: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function project(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "pithy-add-json-"));
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
    await linkKitPackages(dir, ["core"]);
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  }

  test("--list", async () => {
    await project();
    await expectConforms("add", await runCaptured("add", ["--list", "--json"]));
  });

  test("an add, ejected, with a shared database and a proposed KV title", async () => {
    await project();
    flow.result = {
      capability: "auth",
      worker: "api",
      deployedAs: "acme-api",
      package: "@pithy-sh/auth",
      packageManager: "bun",
      databases: [
        {
          database: "app",
          binding: "DB",
          results: [{ migrationName: "0300_auth_0001_init", direction: "Up", status: "Success" }],
          sharedWith: ["web"],
        },
      ],
      kvNamespaces: [{ binding: "SESSIONS", env: "dev", name: "acme-dev-sessions" }],
      notes: ["Run pithy provision --env staging."],
      prerequisites: ["secrets"],
      eject: { capability: "auth", path: "capabilities/auth", promotedDependencies: ["hono@4.0.0"], forced: false },
    } satisfies AddResult;
    await expectConforms("add", await runCaptured("add", ["auth", "--json"]));
  });

  /**
   * **`next` names the migrate an add left a provisioned environment, and nothing when it brought none (#697).**
   * Read off the add's own `dev` run: a migration it applied there is one a deployed environment lacks.
   */
  test("next carries migrate when the add brought migrations, and no key when it brought none", async () => {
    await project();
    const brought = {
      capability: "auth",
      worker: "api",
      deployedAs: "acme-api",
      package: "@pithy-sh/auth",
      packageManager: "bun",
      databases: [
        {
          database: "app",
          binding: "DB",
          results: [{ migrationName: "0300_auth_0001_init", direction: "Up", status: "Success" }],
        },
      ],
      kvNamespaces: [],
      notes: [],
      prerequisites: [],
    } satisfies AddResult;
    followUp.asked.length = 0;
    flow.result = brought;
    const line = (await runCaptured("add", ["auth", "--json"])).join("");
    expect(JSON.parse(line).next).toEqual([
      { command: "pithy migrate --env staging", why: "1 migration is not applied to staging. Add migrates only dev." },
    ]);
    await expectConforms("add", line);

    flow.result = { ...brought, databases: [{ database: "app", binding: "DB", results: [] }] };
    const none = (await runCaptured("add", ["auth", "--json"])).join("");
    expect(Object.hasOwn(JSON.parse(none), "next")).toBe(false);
    expect(followUp.asked).toEqual([
      { ready: ["staging"], brought: true, productionEnvironments: [] },
      { ready: ["staging"], brought: false, productionEnvironments: [] },
    ]);
  });

  /** A production environment's provision stops at a person's phrase, so the follow-up must know which are. */
  test("hands the follow-up the project's own production environments", async () => {
    await project();
    await writeFile(
      join(dir, "pithy.config.ts"),
      'const config = { name: "acme", seed: { productionEnvironments: ["live"] } };\nexport default config;\n',
    );
    flow.result = {
      capability: "auth",
      worker: "api",
      deployedAs: "acme-api",
      package: "@pithy-sh/auth",
      packageManager: "bun",
      databases: [],
      kvNamespaces: [],
      notes: [],
      prerequisites: [],
    } satisfies AddResult;
    followUp.asked.length = 0;
    await runCaptured("add", ["auth", "--json"]);
    expect(followUp.asked).toEqual([{ ready: ["staging"], brought: false, productionEnvironments: ["live"] }]);
  });
});

/**
 * `pithy add --dry-run` in text: what it would compose first, what it would wire, the plan, the notes the
 * real add prints, and the closing line — in that order, because that is the order the real run does them.
 */
describe("addPlanText", () => {
  /** A planned add of `auth` into `api`, with the prerequisites and notes each case sets. */
  function planned(prerequisites: string[]): AddPlan {
    const plan = emptyPlan();
    plan.files.push({ path: "apps/api/pithy.config.ts", action: "edit", changes: ["Composes auth()."] });
    plan.notes.push("Plan note.");
    return {
      capability: "auth",
      worker: "api",
      prerequisites,
      notes: ["Run pithy provision --env staging for the Workflow."],
      plan,
    } as unknown as AddPlan;
  }

  test("prerequisites are named first, before the capability they make room for", () => {
    expect(addPlanText(planned(["secrets", "email"]))).toEqual([
      "Would compose secrets, email into api first.",
      "Would wire auth into api.",
      "Would edit apps/api/pithy.config.ts.",
      "  Composes auth().",
      "Plan note.",
      "Run pithy provision --env staging for the Workflow.",
      "Dry run. Nothing written.",
    ]);
  });

  test("with no prerequisites there is no compose line, and the wire line leads", () => {
    const lines = addPlanText(planned([]));
    expect(lines.some((line) => line.startsWith("Would compose"))).toBe(false);
    expect(lines[0]).toBe("Would wire auth into api.");
    expect(lines.at(-1)).toBe("Dry run. Nothing written.");
  });
});
