// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName, personDecision } from "@pithy-sh/core/src/cli/command";
import { PersonRequiredError, UpstreamError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { secretsFieldKeyRotateWorkflowName } from "@pithy-sh/secrets/src/manager/dispatcher";
import { type FieldKeyCommand, FieldKeyReport } from "@pithy-sh/secrets/src/rotation/fieldKeyRotation";
import { defineCommand } from "citty";
import { cloudflareWorkflows } from "../cloudflare/clients";
import { commandCredentials } from "../cloudflare/commandCredentials";
import { withContract } from "../contract/commandContract";
import { loadProject, projectCloudflareAccount, projectEnvironments, requireProjectName } from "../project/config";
import { requireManagedEnvironment } from "../project/environment";
import { mayPrompt } from "../terminal/inputMode";
import { formatDone, withErrorReporting } from "../terminal/output";

/**
 * **`pithy secrets retire-version <v> --env <env> --past-guard` — the one way past a dirty guard** (#390).
 *
 * Retiring a field-key version is the one irreversible act in field encryption: every ciphertext still under it
 * becomes unopenable, with no remedy. The rotator retires a version itself when the guard reads clean, so this
 * command exists only for the other case, and it is built so that nothing but a person who has read the cost can
 * run it:
 *
 * - **It shows what the guard could not see first** — the stale count per column under `<v>`, every unrotatable
 *   field, and every schema source the guard could not read — read from the manager, which holds the stamp of
 *   encrypted columns.
 * - **Then it asks for `<env>/<v>` to be typed back.** There is no `--yes`. Anything else typed retires nothing.
 * - **Off a terminal or under `--json` it refuses with `core/person_required`**, exit 5, before anything is read,
 *   so neither an agent nor a CI script can run it.
 */

/** What the command needs from the world: the manager's two answers, a prompt, and a place to write. */
export interface RetireVersionDeps {
  /** Read the guard and the stale counts under `version`, writing nothing. */
  guard(version: number): Promise<FieldKeyReport>;
  /** Retire the version past the guard. */
  retire(version: number): Promise<FieldKeyReport>;
  /** Ask a question at the terminal and return what was typed, or `null` when the prompt was canceled. */
  ask(question: string): Promise<string | null>;
  /** Write one line of output. */
  write(line: string): void;
}

/** What the operator asked for. */
export interface RetireVersionOptions {
  env: string;
  version: string;
  pastGuard: boolean;
  json: boolean;
  /** Whether a person can be asked: a terminal on both ends, and nothing forbade a prompt. */
  interactive: boolean;
}

/** The phrase that confirms one retirement: the environment and the version, as `<env>/<v>`. */
export function retirePhrase(env: string, version: number): string {
  return `${env}/${version}`;
}

/** The refusal for every run nobody can be asked in. Raised before anything is read. */
function personRequired(env: string, version: string): PersonRequiredError {
  return new PersonRequiredError({
    message: "Retiring a field-key version past its guard needs a person at a terminal.",
    action: `${personDecision("secrets retire-version", { args: [version], flags: { "--env": env, "--past-guard": true } })} It is run at a terminal, where the person reads what the guard could not see and types ${env}/${version} back. There is no --yes.`,
  });
}

/** The lines the operator reads before typing the version back. Counts, paths and names; never a key. */
export function retireGuardLines(report: FieldKeyReport, env: string, version: number): string[] {
  const lines = [`${env}: field-key versions live: ${report.liveVersions.join(", ")}.`];
  const stale = report.columns.filter((column) => column.stale !== 0);
  if (stale.length === 0) lines.push(`No stamped column still holds a row under version ${version}.`);
  for (const column of stale) {
    lines.push(
      column.stale === null
        ? `  ${column.table}.${column.column} (${column.path}): could not be counted.`
        : `  ${column.table}.${column.column} (${column.path}): ${column.stale} ${column.stale === 1 ? "row" : "rows"} still under version ${version}.`,
    );
  }
  for (const field of report.unrotatable) lines.push(`  Unrotatable, never re-sealed: ${field}.`);
  for (const source of report.unread) lines.push(`  Not read by the guard: ${source}.`);
  lines.push(`Retiring version ${version} makes every ciphertext still under it unopenable. Nothing brings it back.`);
  return lines;
}

/**
 * Run the command. Refuses, before reading anything, a run that is not past the guard, a version that is not a
 * number, and a run nobody can be asked in. Resolves with the manager's report after a retirement, or `null` when
 * the operator typed anything but the phrase.
 */
export async function runRetireVersion(
  options: RetireVersionOptions,
  deps: RetireVersionDeps,
): Promise<FieldKeyReport | null> {
  if (options.json || !options.interactive) throw personRequired(options.env, options.version);
  if (!options.pastGuard) {
    throw new ValidationError({
      message: "The rotator retires a version itself once its guard reads clean.",
      action: `Nothing to run while the guard is clean. Past a dirty one: ${personDecision("secrets retire-version", { args: [options.version], flags: { "--env": options.env, "--past-guard": true } })}`,
    });
  }
  if (!/^\d+$/.test(options.version)) {
    throw new ValidationError({
      message: `"${options.version}" is not a field-key version.`,
      action: "Name a version by its number, as the guard lists it.",
    });
  }
  const version = Number(options.version);
  const report = await deps.guard(version);
  // The counts are what the operator decides from, so they must be the named version's and nobody else's.
  if (report.counted.length !== 1 || report.counted[0] !== version) {
    throw new UpstreamError({
      message: `The ${options.env} secrets manager did not count the rows under version ${version}.`,
      action: `Redeploy the manager with ${commandName("secrets provision")}, then run this again.`,
      detail: `retire-version: the guard counted [${report.counted.join(", ")}], not [${version}]`,
    });
  }
  if (!report.liveVersions.includes(version)) {
    throw new ValidationError({
      message: `Version ${version} is not a live field-key version in ${options.env}.`,
      action: `Name one of ${report.liveVersions.join(", ")}.`,
    });
  }
  for (const line of retireGuardLines(report, options.env, version)) deps.write(line);
  const phrase = retirePhrase(options.env, version);
  const typed = await deps.ask(`Type ${phrase} to retire it:`);
  if (typed === null || typed.trim() !== phrase) {
    deps.write("Not retired.");
    return null;
  }
  return deps.retire(version);
}

/**
 * `pithy secrets retire-version <v> --env <env> --past-guard` — retire a field-key version past a dirty guard
 * (#390). Human-only by design, like `pithy remove`: it shows what the guard could not see, asks for `<env>/<v>` to
 * be typed back, has no `--yes`, and refuses with `core/person_required` off a terminal or under `--json`,
 * before anything is read. See `capabilities/retireFieldKey.ts`.
 */
export const retireVersion = withContract(
  defineCommand({
    meta: { name: "retire-version", description: "Retire a field-key version past its guard (irreversible)" },
    args: {
      version: {
        type: "positional",
        required: true,
        description: "The field-key version to retire, as the guard lists it",
      },
      env: { type: "string", description: "The environment whose field key it is" },
      "past-guard": {
        type: "boolean",
        default: false,
        description: "Retire it although the guard is not clean. Every ciphertext still under it becomes unopenable",
      },
      json: { type: "boolean", default: false, description: "Not supported — retiring past the guard is manual-only" },
    },
    // Errors always render as terminal problem/action lines: this command has no machine-readable surface.
    run: ({ args }) =>
      withErrorReporting(false, async () => {
        // Refused before anything is read: a run nobody can be asked in cannot take this step.
        const interactive = mayPrompt(args.json);
        const options = {
          env: args.env ?? "",
          version: args.version,
          pastGuard: args["past-guard"],
          json: args.json,
          interactive,
        };
        if (args.json || !interactive) await runRetireVersion(options, refusingDeps);
        const projectDir = process.cwd();
        const env = requireManagedEnvironment(args.env ?? "", await projectEnvironments(projectDir));
        const { accountId, apiToken } = commandCredentials(await projectCloudflareAccount(projectDir));
        const project = requireProjectName(await loadProject(projectDir));
        const workflows = await cloudflareWorkflows({ accountId, apiToken });
        const workflow = secretsFieldKeyRotateWorkflowName(project, env);
        const dispatch = async (command: FieldKeyCommand): Promise<FieldKeyReport> => {
          const parsed = FieldKeyReport.safeParse(await workflows.dispatchAndPoll(workflow, command));
          if (!parsed.success) {
            throw new UpstreamError({
              message: `The ${env} secrets manager gave no usable account of its field key.`,
              action: `Redeploy the manager with ${commandName("secrets provision")}, then run this again.`,
              detail: `retire-version: unexpected ${command.mode} output from ${workflow}`,
            });
          }
          return parsed.data;
        };
        const retired = await runRetireVersion(
          { ...options, env },
          {
            guard: (version) => dispatch({ mode: "guard", version }),
            retire: (version) => dispatch({ mode: "retire", version, pastGuard: true }),
            ask: askRetirePhrase,
            write: (line) => void process.stdout.write(`${line}\n`),
          },
        );
        if (retired === null) return;
        process.stdout.write(
          `${env}: retired field-key version ${retired.retired.join(", ")}. Live: ${retired.liveVersions.join(", ")}.\n`,
        );
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    // Manual by design: `--json` is declared so it can be refused before anything is read.
    output: "none",
    mutates: true,
    idempotent: false,
    needsNetwork: true,
  },
);

/**
 * Ask for the typed-back `<env>/<v>`, or `null` on a cancel. Opened only after `mayPrompt` said a person is there;
 * `runRetireVersion` refuses every other run before it is reached.
 */
async function askRetirePhrase(question: string): Promise<string | null> {
  const clack = await import("@clack/prompts");
  const typed = await clack.text({ message: question });
  return clack.isCancel(typed) ? null : typed;
}

/** The world a refused run would have used: it never reaches any of it, because the refusal comes first. */
const refusingDeps: RetireVersionDeps = {
  guard: async () => {
    throw new UpstreamError({ detail: "retire-version: a refused run reached the manager" });
  },
  retire: async () => {
    throw new UpstreamError({ detail: "retire-version: a refused run reached the manager" });
  },
  ask: async () => null,
  write: () => undefined,
};
