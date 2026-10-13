// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pithyCommandOf } from "@pithy-sh/core/src/cli/command";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runAdd } from "../capabilities/flow";
import { readSecretValue } from "../capabilities/secretValue";
import { addPrompts, targetWorker } from "../commands/add";
import { confirmOrRefuse } from "../commands/dashboard";
import { requireScopeAnswerable } from "../commands/docs";
import { rollbackPhrase } from "../commands/migrate";
import { requireDropConfirmable } from "../commands/remove";
import { canPrompt } from "../commands/secrets";
import { assertRollbackConfirmed } from "../migrations/confirm";
import { requireEditor } from "../platform/editor";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { assertProvisionConfirmed } from "../provision/confirm";
import { assertResetConfirmed, assertSeedConfirmed } from "../seed/safety";
import { latchInputMode, mayPrompt } from "../terminal/inputMode";
import { isTestFile, readSource, sourcePaths } from "./sourceFiles";

/**
 * **Every prompt in the CLI, enumerated, and each held to what it does when this run may not ask (#697).**
 *
 * `PITHY_NONINTERACTIVE=1`, `--no-input` and `--json` forbid prompts. What a forbidden prompt does
 * depends on whether its question has a default, so every site is one of two kinds:
 *
 * - **required** — no default exists, so the run cannot finish without an answer. It fails
 *   `input/required`, naming the flag that answers it (or `null` when no flag can) and, when the set is
 *   known, the choices — **unless the answer is a person's to give**: a typed confirmation phrase, or
 *   `remove --drop`. Those fail `core/person_required` (exit 5) instead, so an agent stops and asks rather
 *   than trying variations, and their action line names the flag for the person. Each is driven below
 *   with input forbidden and a terminal attached on both streams, so the latch is the only thing that
 *   could have stopped the prompt.
 * - **optional** — a default exists and a run that asks nobody takes it, as it always has. `pithy init`
 *   with no flags still scaffolds; it simply asks nothing.
 *
 * **The population is read off the source, not off this table.** Every module that imports
 * `@clack/prompts` must appear below, so a new prompt fails here until somebody decides which kind it
 * is — and a site that disappears fails too, rather than leaving a row that tests nothing.
 */

/** The CLI's source root. */
const SRC = resolve(import.meta.dirname, "..");

/** How a module reaches the prompt library. Always dynamic, so a match is a real site. */
const CLACK = /import\(\s*["']@clack\/prompts["']\s*\)/;

/** A call into the seam. */
const SEAM_CALL = /\b(?:mayPrompt|mayDraw|mayReadKeys|stdinTakesInput|inputForbidden)\(/;

/** One prompt module: what it asks, of which kind, and the module that consults the seam for it. */
interface PromptSite {
  /** The prompts it opens, by the function that opens them. */
  prompts: readonly string[];
  /** `required`: no default, so forbidden means `input/required`. `optional`: a default is taken. */
  kind: "required" | "optional" | "mixed";
  /** The `src`-relative module whose call into the seam decides whether these prompts open. */
  gatedBy: string;
}

const SITES: Record<string, PromptSite> = {
  "commands/add.ts": {
    prompts: ["promptWorker", "promptConfigValues", "promptPrerequisites"],
    kind: "required",
    gatedBy: "commands/add.ts",
  },
  "commands/dashboard.ts": {
    // The scopes take the default grant. The two confirmations default to no, so they are required:
    // `--yes` answers them, and a run that cannot ask without it is refused.
    prompts: ["promptScopes", "confirmRevokeKey", "confirmDisconnect"],
    kind: "mixed",
    gatedBy: "commands/dashboard.ts",
  },
  "commands/docs.ts": { prompts: ["askScope", "offerDocs"], kind: "mixed", gatedBy: "commands/docs.ts" },
  "commands/init.ts": {
    // Every question has a default: the directory name, `api`, the three environments, no account, no domain.
    prompts: ["offerAlias", "ask", "clackPrompt"],
    kind: "optional",
    gatedBy: "commands/init.ts",
  },
  "commands/migrate.ts": { prompts: ["promptRollback"], kind: "required", gatedBy: "commands/migrate.ts" },
  "commands/provision.ts": { prompts: ["confirmPrompt"], kind: "required", gatedBy: "commands/provision.ts" },
  "commands/remove.ts": { prompts: ["dropConfirm"], kind: "required", gatedBy: "commands/remove.ts" },
  "commands/seed.ts": { prompts: ["resetPrompt", "productionPrompt"], kind: "required", gatedBy: "commands/seed.ts" },
  "commands/ui.ts": { prompts: ["promptScreens"], kind: "optional", gatedBy: "commands/ui.ts" },
  "commands/vector.ts": { prompts: ["resetPrompt"], kind: "required", gatedBy: "commands/vector.ts" },
  "project/askDomains.ts": {
    // Skippable: a project with no domain yet is legitimate. Asked by `init` and `worker add`.
    prompts: ["askDomains"],
    kind: "optional",
    gatedBy: "commands/worker.ts",
  },
  "capabilities/secretValue.ts": {
    prompts: ["clackPrompter"],
    kind: "required",
    gatedBy: "commands/secrets.ts",
  },
  "dev/orchestrator.ts": {
    // Reached only by the `l` key, and a run that forbade input reads no keys (`terminal/keys.ts`).
    prompts: ["chooseDevLoginDefault"],
    kind: "optional",
    gatedBy: "terminal/keys.ts",
  },
};

/** Every shipped module that opens a prompt, as `src`-relative paths. */
function clackModules(): string[] {
  return sourcePaths(SRC)
    .filter((path) => path.endsWith(".ts") && !isTestFile(path))
    .filter((path) => CLACK.test(blankComments(readSource(path) ?? "")))
    .map((path) => relative(SRC, path))
    .sort();
}

describe("the prompt sites", () => {
  test("are exactly the modules that import @clack/prompts — a new one is classified before it ships", () => {
    expect(clackModules()).toEqual(Object.keys(SITES).sort());
  });

  test.each(Object.entries(SITES))("%s opens the prompts it is listed with", (path, site) => {
    const code = blankComments(readSource(resolve(SRC, path)) ?? "");
    for (const prompt of site.prompts) expect(code).toMatch(new RegExp(`\\b${prompt}\\b`));
  });

  test.each(Object.entries(SITES))("%s is gated through the seam", (_path, site) => {
    expect(blankComments(readSource(resolve(SRC, site.gatedBy)) ?? "")).toMatch(SEAM_CALL);
  });
});

/** A terminal on every stream, so that only the latch can be what forbids. */
const TERMINAL = { stdin: { isTTY: true }, stdout: { isTTY: true } };

/** The `input/required` payload a thunk raised, or a failure naming what it raised instead. */
async function refusalOf(run: () => unknown): Promise<Record<string, unknown>> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof PithyError)) throw new Error(`expected a PithyError, got ${String(thrown)}`);
  return thrown.payload as unknown as Record<string, unknown>;
}

/**
 * Each required prompt, driven through the function its command decides with, with input forbidden.
 *
 * Most rows call the very function the command calls to decide whether to ask: `targetWorker`,
 * `addPrompts` feeding the real `runAdd`, `rollbackPhrase` feeding `assertRollbackConfirmed`,
 * `requireScopeAnswerable`, `confirmOrRefuse`, `requireDropConfirmable`, `requireEditor`, `canPrompt`. Each
 * reads the seam itself, so a gate taken out of it fails its row — or reaches a prompt and hangs the suite,
 * which is the same failure, louder.
 *
 * Three hand a prompt to a confirmation gate the way their command does (`handedOff`): `provision`, `seed`
 * and `vector` compute `interactive` from `mayPrompt` and pass their prompt only when it is true. Those
 * rows mirror that hand-off, and the wiring check below holds the command source to it, so a prompt passed
 * unconditionally fails there rather than here.
 */
const REQUIRED: readonly {
  site: string;
  prompt: string;
  flag: string | null;
  choices?: readonly string[];
  /** The answer is a person's to give: the refusal is `core/person_required`, and its action names `flag`. */
  person?: true;
  /** The prompt factory the command hands its gate under `interactive ?`, checked against the source. */
  handedOff?: string;
  run: (interactive: boolean) => unknown;
}[] = [
  {
    site: "commands/add.ts",
    prompt: "promptWorker",
    flag: "--worker",
    choices: ["api", "admin"],
    run: (interactive) =>
      targetWorker("dev", {
        projectDir: "/project",
        interactive,
        discoverWorkers: async () => ["api", "admin"].map((name) => ({ name, dir: `/project/apps/${name}` })),
        loadConfig: async () => ({ capabilities: [] }),
      }),
  },
  {
    site: "commands/add.ts",
    prompt: "promptConfigValues",
    flag: "--set",
    choices: ["billingSubject=user", "billingSubject=organization"],
    run: (interactive) => addInScaffold("payments", interactive),
  },
  {
    site: "commands/add.ts",
    prompt: "promptPrerequisites",
    flag: "--with-prerequisites",
    run: (interactive) => addInScaffold("auth", interactive),
  },
  {
    site: "commands/migrate.ts",
    prompt: "promptRollback",
    flag: "--confirm-rollback",
    person: true,
    run: async () =>
      assertRollbackConfirmed("staging", await rollbackPhrase({ env: "staging", json: false, rollback: true })),
  },
  {
    site: "commands/provision.ts",
    prompt: "confirmPrompt",
    flag: "--confirm",
    person: true,
    handedOff: "confirmPrompt",
    run: (interactive) =>
      assertProvisionConfirmed({
        env: "prod",
        yes: true,
        json: false,
        ...(interactive ? { prompt: async () => "" } : {}),
      }),
  },
  {
    site: "commands/seed.ts",
    prompt: "resetPrompt",
    flag: "--confirm-reset",
    person: true,
    handedOff: "resetPrompt",
    run: (interactive) =>
      assertResetConfirmed({ env: "staging", json: false, ...(interactive ? { prompt: async () => "" } : {}) }),
  },
  {
    site: "commands/seed.ts",
    prompt: "productionPrompt",
    flag: "--confirm-production",
    person: true,
    handedOff: "productionPrompt",
    run: (interactive) =>
      assertSeedConfirmed({
        env: "prod",
        yes: true,
        json: false,
        ...(interactive ? { prompt: async () => "" } : {}),
      }),
  },
  {
    site: "commands/vector.ts",
    prompt: "resetPrompt",
    flag: "--confirm-reset",
    person: true,
    handedOff: "resetPrompt",
    run: (interactive) =>
      assertResetConfirmed({ env: "prod", json: false, ...(interactive ? { prompt: async () => "" } : {}) }),
  },
  {
    site: "commands/remove.ts",
    prompt: "dropConfirm",
    flag: null,
    person: true,
    run: (interactive) => requireDropConfirmable("auth", { drop: true, interactive, env: "dev" }),
  },
  {
    site: "commands/dashboard.ts",
    prompt: "confirmDisconnect",
    flag: "--yes",
    run: () =>
      confirmOrRefuse({
        message: "Disconnect the management client from prod?",
        action: "Pass --yes to disconnect it without asking.",
        json: false,
        yes: false,
        ask: async () => {
          throw new Error("asked a run that forbade prompts");
        },
      }),
  },
  {
    site: "commands/dashboard.ts",
    prompt: "confirmRevokeKey",
    flag: "--yes",
    run: () =>
      confirmOrRefuse({
        message: "Revoke key k1 on prod?",
        action: "Pass --yes to revoke it without asking.",
        json: false,
        yes: false,
        ask: async () => {
          throw new Error("asked a run that forbade prompts");
        },
      }),
  },
  {
    site: "capabilities/secretValue.ts",
    prompt: "clackPrompter",
    flag: null,
    run: () =>
      readSecretValue({
        name: "API_KEY",
        mode: "create",
        rerun: pithyCommandOf("secrets create", { args: ["API_KEY"] }),
        // `secrets` asks the seam's output half, as the command does.
        canPrompt: canPrompt(false),
        stdin: {
          isTTY: true,
          async *[Symbol.asyncIterator]() {
            // A terminal hands a value to a prompt, never to the reader.
          },
        },
      }),
  },
  {
    site: "commands/docs.ts",
    prompt: "askScope",
    flag: "--scope",
    choices: ["project", "user"],
    // The gate both subcommands run. `commands/docs.test.ts` drives the whole command and reads the
    // `--json` line, for `--client` as well as `--scope`.
    run: () => requireScopeAnswerable(undefined, false),
  },
  {
    site: "platform/editor.ts",
    // Not a clack prompt, but a question all the same: `pithy secrets edit` opens an editor for a person.
    prompt: "requireEditor",
    flag: null,
    run: (interactive) => requireEditor("/tmp/secrets.jsonc", { interactive }),
  },
];

/**
 * The manifests `addInScaffold` installs: `payments` with an option nobody may pick for you, and `auth`
 * with a prerequisite the scaffold does not compose. Binding-free, so nothing but the question is at stake.
 */
const MANIFESTS: Record<string, unknown> = {
  payments: {
    name: "payments",
    package: "@pithy-sh/payments",
    requiredBindings: [],
    configOptions: [
      { key: "billingSubject", choices: ["user", "organization"], describe: "Who holds a subscription." },
    ],
  },
  auth: { name: "auth", package: "@pithy-sh/auth", requiredBindings: [], peerCapabilities: ["secrets"] },
  secrets: { name: "secrets", package: "@pithy-sh/secrets", requiredBindings: [] },
};

/**
 * `pithy add <capability>` in a fresh scaffold, handed exactly the prompts `add.ts` hands it — `addPrompts`
 * of whether this run may ask. The real flow decides what to do without them.
 */
async function addInScaffold(capability: string, interactive: boolean): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-prompt-sites-"));
  try {
    await scaffoldProject({ targetDir: dir, appName: "prompt-sites" });
    return await runAdd({
      account: null,
      projectDir: dir,
      workerDir: join(dir, "apps", DEFAULT_WORKER),
      project: "acme",
      capability,
      install: async ({ projectDir, pkg }: { projectDir: string; pkg: string }) => {
        const pkgDir = join(projectDir, "node_modules", pkg);
        await mkdir(pkgDir, { recursive: true });
        await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(MANIFESTS[pkg.replace("@pithy-sh/", "")]));
        return { packageManager: "bun" as const };
      },
      migrate: async () => [],
      ...addPrompts(interactive),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("a required prompt, with input forbidden", () => {
  const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
  beforeEach(() => {
    latchInputMode(true);
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
  });
  afterEach(() => {
    latchInputMode(false);
    process.stdin.isTTY = tty.stdin;
    process.stdout.isTTY = tty.stdout;
  });

  test("every required site is in the table", () => {
    const covered = new Set(REQUIRED.map((row) => row.site));
    const required = Object.entries(SITES).filter(([, site]) => site.kind !== "optional");
    expect(required.map(([path]) => path).filter((path) => !covered.has(path))).toEqual([]);
  });

  test.each(REQUIRED.map((row) => [`${row.site} ${row.prompt}`, row] as const))(
    "%s fails input/required naming its flag, or core/person_required where only a person may answer",
    async (_name, row) => {
      const interactive = mayPrompt(false, TERMINAL);
      expect(interactive).toBe(false);
      const payload = await refusalOf(() => row.run(interactive));
      if (row.person) {
        expect(payload.code).toBe("core/person_required");
        if (row.flag !== null) expect(payload.action).toContain(row.flag);
        return;
      }
      expect(payload.code).toBe("input/required");
      expect(payload.flag).toBe(row.flag);
      if (row.choices !== undefined) expect(payload.choices).toEqual(row.choices);
    },
  );

  test("anti-vacuous: both kinds of refusal are exercised", () => {
    expect(REQUIRED.filter((row) => row.person).length).toBeGreaterThanOrEqual(4);
    expect(REQUIRED.filter((row) => !row.person).length).toBeGreaterThanOrEqual(8);
  });
});

/** What precedes a prompt factory's call when it is handed over only to a run that may ask. */
const HANDED_OFF_UNDER_INTERACTIVE = /interactive \? (?:\{ \w+: )?$/;

describe("a prompt handed to a confirmation gate", () => {
  const rows = REQUIRED.filter((row) => row.handedOff !== undefined);

  test("the hand-off rows exist", () => {
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  test.each(rows.map((row) => [`${row.site} ${row.handedOff}`, row] as const))(
    "%s is handed over only under interactive, which the seam decides",
    (_name, row) => {
      const code = blankComments(readSource(resolve(SRC, row.site)) ?? "");
      expect(code).toMatch(/\bconst interactive = mayPrompt\(/);
      const calls = [...code.matchAll(new RegExp(`(?<!function )\\b${row.handedOff}\\(`, "g"))];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(code.slice(Math.max(0, (call.index ?? 0) - 40), call.index)).toMatch(HANDED_OFF_UNDER_INTERACTIVE);
      }
    },
  );

  test("an unconditional hand-off is caught", () => {
    const planted = "const interactive = mayPrompt(args.json);\n  prompt: confirmPrompt(env),\n";
    const call = planted.indexOf("confirmPrompt(");
    expect(planted.slice(call - 40, call)).not.toMatch(HANDED_OFF_UNDER_INTERACTIVE);
  });
});
