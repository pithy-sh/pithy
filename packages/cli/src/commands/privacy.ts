// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative } from "node:path";
import { causeMessage } from "@pithy-sh/core/src/error/cause";
import { InputRequiredError } from "@pithy-sh/core/src/error/pithyError";
import { BUILT_IN_PRIVACY_CLASSES, privacyClass } from "@pithy-sh/core/src/privacy/classes";
import { defineCommand, runCommand } from "citty";
import { z } from "zod";
import { withContract } from "../contract/commandContract";
import { closeConsole } from "../privacy/closeConsole";
import type { ConsoleGateReading } from "../privacy/consoleGate";
import { declarePrivacyClasses } from "../privacy/declare";
import { ScanFinding, scanCapabilities } from "../privacy/scan";
import { allCapabilities, loadProject, loadProjectPrivacy, loadWorkerConfig } from "../project/config";
import { workerDirName } from "../project/workerIdentity";
import { discoverWorkers } from "../project/workers";
import { canceled } from "../terminal/exitClass";
import { mayPrompt } from "../terminal/inputMode";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";

/**
 * `pithy privacy` (#132): declare the privacy classes a project handles, and find the fields it has not marked.
 * `docs/commands/privacy.md`, and `docs/PRIVACY.md` for what a class is.
 */

/** Every `--class` a run was given, repeated or comma-separated. citty keeps only the last of a repeated flag. */
export function collectClasses(rawArgs: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--class") {
      const value = rawArgs[i + 1];
      if (value !== undefined) {
        values.push(value);
        i++;
      }
    } else if (arg?.startsWith("--class=")) {
      values.push(arg.slice("--class=".length));
    }
  }
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** The console gate, as `--json` reports it. */
const ConsoleGate = z
  .object({
    state: z
      .enum(["enforced", "off", "unverifiable"])
      .describe("`enforced`, `off` (deploy refuses), or `unverifiable` (no Biome config Pithy can read)."),
    file: z.string().nullable().describe("The Biome config read, project-relative, or null when there is none."),
    reason: z.string().nullable().describe("Why it is not enforced, in one sentence. Null when it is."),
  })
  .describe("Whether `suspicious/noConsole` closes console in the project's Worker source.");

/** The gate reading as `--json` carries it. */
function gateView(gate: ConsoleGateReading): z.output<typeof ConsoleGate> {
  return { state: gate.state, file: gate.file, reason: gate.state === "enforced" ? null : gate.reason };
}

/** `pithy privacy enable --json`. */
const PrivacyEnablePayload = z
  .object({
    command: z.literal("privacy enable").describe('`"privacy enable"`.'),
    classes: z.array(z.string().describe("A class name.")).describe("Every class the root config now declares."),
    configChanged: z.boolean().describe("Whether the root `pithy.config.ts` was written. False on a re-run."),
    biomeChanged: z.boolean().describe("Whether the Biome config was written. False when the rule was already on."),
    consoleGate: ConsoleGate.describe("The console gate after this run, as `pithy deploy` will read it."),
  })
  .describe("What `pithy privacy enable` declared, and the console gate it left.");

/** The human line for the gate after `enable`. */
function gateLine(gate: ConsoleGateReading, written: boolean): string {
  if (gate.state === "enforced") {
    return written
      ? `Wrote suspicious/noConsole into ${gate.file}. Console is closed.`
      : `Console is closed in ${gate.file}.`;
  }
  if (gate.state === "unverifiable") return `Console gate unverifiable. ${gate.reason} Deploy proceeds and reports it.`;
  return `${gate.reason} Deploy refuses until it is \`error\`.`;
}

/** Ask which classes to declare, preselecting what is declared already. */
async function promptClasses(declared: readonly string[]): Promise<string[]> {
  const { isCancel, multiselect } = await import("@clack/prompts");
  const answer = await multiselect({
    message: "Which privacy classes does this project handle?",
    options: BUILT_IN_PRIVACY_CLASSES.map((name) => ({
      value: name,
      label: name,
      hint: privacyClass(name)?.description,
    })),
    initialValues: declared.filter((name): name is (typeof BUILT_IN_PRIVACY_CLASSES)[number] =>
      (BUILT_IN_PRIVACY_CLASSES as readonly string[]).includes(name),
    ),
    required: true,
  });
  if (isCancel(answer)) canceled();
  return answer as string[];
}

/**
 * The classes `enable` declares: the `--class` values, or — when none were passed — the answer to a question, which
 * only a run that may ask gets. A run that cannot ask is refused `input/required`, naming `--class` and the
 * built-in choices: there is no default, because which classes a project handles is not Pithy's to guess.
 */
export async function classesToDeclare(
  given: readonly string[],
  interactive: boolean,
  ask: () => Promise<string[]>,
): Promise<string[]> {
  if (given.length > 0) return [...given];
  if (!interactive) {
    throw new InputRequiredError({
      message: "Name a class to declare.",
      action: "Pass --class, once per class: --class pii --class phi.",
      flag: "--class",
      choices: BUILT_IN_PRIVACY_CLASSES,
    });
  }
  return ask();
}

/** Whether any Worker under `apps/` composes the audit capability. A Worker that will not load counts as not. */
export async function composesAudit(projectDir: string): Promise<boolean> {
  for (const worker of await discoverWorkers(projectDir)) {
    try {
      if (allCapabilities(await loadWorkerConfig(worker.dir)).some((capability) => capability.name === "audit")) {
        return true;
      }
    } catch {
      // A config that will not load answers nothing here; `pithy doctor` is where it is named.
    }
  }
  return false;
}

/** How an offer asks, and what it runs on a yes. Seams, so a test answers without a terminal. */
export interface OfferSeams {
  /** Ask one yes-or-no question. Defaults to clack's `confirm`, where a cancel is a no. */
  confirm?: (message: string) => Promise<boolean>;
  /** What a yes runs. */
  run?: () => Promise<void>;
}

/** clack's `confirm`, defaulting to no, with a cancel read as no: an offer declined is never an error. */
async function askConfirm(message: string): Promise<boolean> {
  const { confirm, isCancel } = await import("@clack/prompts");
  const answer = await confirm({ message, initialValue: false });
  return !isCancel(answer) && answer === true;
}

/**
 * The offer `enable` makes once the classes are declared: turn on auditing too. An offer at the moment it is
 * relevant, never a requirement — declining leaves the project exactly as working as it was.
 */
export async function offerAudit(projectDir: string, seams: OfferSeams = {}): Promise<void> {
  if (await composesAudit(projectDir)) return;
  const ask = seams.confirm ?? askConfirm;
  if (!(await ask("Turn on auditing too? It records who did what, which is the other half of the same question."))) {
    return;
  }
  const run =
    seams.run ??
    (async () => {
      const add = (await import("./add")).default;
      await runCommand(add, { rawArgs: ["audit"] });
    });
  await run();
}

/**
 * The offer `pithy add audit` makes in return (#132): an audit trail and a privacy declaration answer halves of one
 * question, so each command knows the other exists. Only when nothing is declared yet; declining changes nothing.
 */
export async function offerPrivacy(projectDir: string, seams: OfferSeams = {}): Promise<void> {
  if (loadProjectPrivacy(await loadProject(projectDir, { fresh: true })).length > 0) return;
  const ask = seams.confirm ?? askConfirm;
  if (
    !(await ask("Declare the privacy classes this project handles too? It closes console and reports what you hold."))
  ) {
    return;
  }
  await (seams.run ?? (() => runCommand(enable, { rawArgs: [] }).then(() => undefined)))();
}

const enable = withContract(
  defineCommand({
    meta: {
      name: "enable",
      description: "Declare the privacy classes this project handles, and close console",
    },
    args: {
      class: {
        type: "string",
        description: "A class to declare: secret, pii, phi, pci, or one you registered (repeatable)",
      },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args, rawArgs }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const interactive = mayPrompt(args.json);
        const classes = await classesToDeclare(collectClasses(rawArgs), interactive, async () =>
          promptClasses(loadProjectPrivacy(await loadProject(projectDir))),
        );
        const declared = await declarePrivacyClasses({ projectDir, classes });
        const closed = await closeConsole(projectDir);
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "privacy enable",
              classes: declared.classes,
              configChanged: declared.changed,
              biomeChanged: closed.written,
              consoleGate: gateView(closed.gate),
            })}\n`,
          );
          return;
        }
        const configFile = relative(projectDir, declared.path);
        process.stdout.write(
          declared.changed
            ? `Declared ${declared.classes.join(", ")} in ${configFile}.\n`
            : `Already declared: ${declared.classes.join(", ")}.\n`,
        );
        process.stdout.write(`${gateLine(closed.gate, closed.written)}\n`);
        if (interactive) await offerAudit(projectDir);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: PrivacyEnablePayload,
    // Writes the root config and the Biome config, and the same bytes on a re-run: both writers are no-ops then.
    mutates: true,
    idempotent: true,
    needsNetwork: false,
    flags: { class: { repeatable: true } },
  },
);

/** One Worker the scan could not read, and why. */
const UnreadableWorker = z
  .object({
    worker: z.string().describe("The Worker under `apps/`."),
    reason: z.string().describe("Why its `pithy.config.ts` did not load, in one sentence."),
  })
  .describe("A Worker whose schemas the scan could not reach.");

/** `pithy privacy scan --json`. */
const PrivacyScanPayload = z
  .object({
    command: z.literal("privacy scan").describe('`"privacy scan"`.'),
    findings: z.array(ScanFinding).describe("Every candidate and every covered field, Worker by Worker."),
    candidates: z.number().int().nonnegative().describe("How many findings are unmarked candidates."),
    covered: z.number().int().nonnegative().describe("How many findings are fields already marked."),
    unreadable: z
      .array(UnreadableWorker)
      .describe("Workers whose config did not load. Their schemas were not scanned."),
  })
  .describe("What `pithy privacy scan` found. Advice only: it edits nothing and always exits 0.");

/** The human lines for a scan. */
export function renderScan(
  findings: readonly ScanFinding[],
  unreadable: readonly { worker: string; reason: string }[],
): string[] {
  const lines: string[] = [];
  for (const finding of findings) {
    const where = `${finding.worker} ${finding.capability} ${finding.schema}.${finding.path}`;
    if (finding.status === "covered") {
      lines.push(dim(`${where}: covered, ${finding.class}.`));
    } else if (finding.owner === "kit") {
      lines.push(`${where}: reads as ${finding.class}. A kit schema — the kit marks it, not you.`);
    } else {
      lines.push(`${where}: reads as ${finding.class}. Mark it ${finding.marker}`);
    }
  }
  for (const worker of unreadable) lines.push(`${worker.worker}: not scanned. ${worker.reason}`);
  const candidates = findings.filter((finding) => finding.status === "candidate").length;
  const covered = findings.length - candidates;
  lines.push(`${candidates} to consider, ${covered} covered. Advice only: nothing was changed.`);
  return lines;
}

const scan = withContract(
  defineCommand({
    meta: {
      name: "scan",
      description: "Find stored fields whose names read as private and are not marked",
    },
    args: {
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const findings: ScanFinding[] = [];
        const unreadable: { worker: string; reason: string }[] = [];
        for (const worker of await discoverWorkers(projectDir)) {
          const name = workerDirName(worker);
          try {
            findings.push(...scanCapabilities(name, allCapabilities(await loadWorkerConfig(worker.dir))));
          } catch (cause) {
            unreadable.push({ worker: name, reason: causeMessage(cause) ?? "Its pithy.config.ts did not load." });
          }
        }
        const candidates = findings.filter((finding) => finding.status === "candidate").length;
        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "privacy scan",
              findings,
              candidates,
              covered: findings.length - candidates,
              unreadable,
            })}\n`,
          );
          return;
        }
        for (const line of renderScan(findings, unreadable)) process.stdout.write(`${line}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: PrivacyScanPayload,
    mutates: false,
    idempotent: true,
    needsNetwork: false,
  },
);

export default defineCommand({
  meta: { name: "privacy", description: "Declare privacy classes and find unmarked fields" },
  subCommands: { enable, scan },
});
