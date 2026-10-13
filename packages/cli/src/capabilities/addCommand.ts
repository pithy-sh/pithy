// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Caller,
  type Command,
  callerOf,
  commandAlternatives,
  commandName,
  pithyCommandOf,
  type WorkerDir,
} from "@pithy-sh/core/src/cli/command";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { workerDirName } from "../project/workerIdentity";
import { configuredWorkerDirs } from "../project/workers";
import { withFix } from "../terminal/exitClass";
import { installedManifestPath } from "./catalog";
import { type AddFacts, kitAddFacts } from "./kitAddFacts";
import { KIT_ADD_FACTS } from "./kitAddFacts.generated";
import { prerequisiteClosure } from "./prerequisiteClosure";
import { isRegistered } from "./registration";

/**
 * **Every `pithy add` a line names, built from what the capability declares (#711).**
 *
 * `pithy add` is the one command whose runnable spelling depends on a manifest, not only on the tree: a
 * capability with prerequisites is refused without `--with-prerequisites`, and one with an option it states no
 * default for is refused without `--set` for it. Each was a line that did not run. So a line never spells
 * `pithy add`; it asks this module, which reads the manifest — the project's, or the kit's own when the package
 * is not installed yet — and answers with the commands that run as written, or with what a person must decide.
 *
 * - **`--worker` always**, by `apps/` directory. The command acts on one Worker; naming it costs nothing in a
 *   project with one and is the difference between running and `input/required` in a project with several.
 * - **`--with-prerequisites`** when the capability brings any the Worker lacks.
 * - **Every required option settled**: the caller's `--set` carried over, and an option nobody answered named as
 *   one command per value it takes. That is a choice, so it is never a `fix`: the kit does not pick a billing
 *   model. An option with no fixed set of values is a person's to answer, and the line says so.
 * - **A prerequisite with a required option** cannot be composed by `--with-prerequisites`, which gives it its
 *   defaults; the line names that prerequisite's own add first.
 */

/** The flags of `pithy add` a caller passes beyond the capability, its Worker and its `--set`. */
export type AddFlags = Readonly<{
  "--with-prerequisites"?: true;
  "--eject"?: true;
  "--force"?: true;
  "--dry-run"?: true;
  "--json"?: true;
}>;

/** What a run of `pithy add` was given, as its options name it — `RunAddOptions` in `flow.ts`. */
export interface AddRun {
  /** The capability, as the caller named it. */
  readonly capability: string;
  /** The raw `--set key=value` entries. */
  readonly setFlags?: readonly string[] | undefined;
  readonly withPrerequisites?: boolean | undefined;
  readonly eject?: boolean | undefined;
  readonly force?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly json?: boolean | undefined;
}

/**
 * **A run of `pithy add`, as its own context (#711)**: the one input every line naming it again is built from — its
 * flags, its `--set`, and `answered`, the options its Worker's config already states, which a rerun settles rather
 * than naming a `--set` that could contradict the config. `flow.ts` builds it once per run, from the run's options.
 */
export function addCallerOf(run: AddRun, answered: Iterable<string>): Caller<"add"> {
  return callerOf(
    "add",
    {
      capability: run.capability,
      ...(run.withPrerequisites === true ? { "with-prerequisites": true } : {}),
      ...(run.eject === true ? { eject: true } : {}),
      ...(run.force === true ? { force: true } : {}),
      ...(run.dryRun === true ? { "dry-run": true } : {}),
      ...(run.json === true ? { json: true } : {}),
    },
    { set: run.setFlags ?? [], answered },
  );
}

/** The capability a caller of `pithy add` asked for. */
function callerCapability(caller: Caller<"add">): string | undefined {
  const named = caller.given.capability;
  return typeof named === "string" ? named : undefined;
}

/** Every flag of `pithy add` a caller passed beyond its capability, Worker and `--set`. */
function callerFlags(caller: Caller<"add"> | undefined): AddFlags {
  const given = caller?.given ?? {};
  return {
    ...(given["with-prerequisites"] === true ? { "--with-prerequisites": true } : {}),
    ...(given.eject === true ? { "--eject": true } : {}),
    ...(given.force === true ? { "--force": true } : {}),
    ...(given["dry-run"] === true ? { "--dry-run": true } : {}),
    ...(given.json === true ? { "--json": true } : {}),
  };
}

/**
 * **The caller's flags a step on the way carries** — an add of something the capability needs, named before it.
 * A dry run's every step is a dry run, and a caller that asked for JSON reads JSON from each (#711). `--eject` and
 * `--force` were asked of the capability, not of what it needs, and its `--set` answered the capability's options.
 */
function stepFlags(caller: Caller<"add"> | undefined): AddFlags {
  const flags = callerFlags(caller);
  return {
    ...(flags["--dry-run"] === true ? { "--dry-run": true } : {}),
    ...(flags["--json"] === true ? { "--json": true } : {}),
  };
}

/** What a line about composing a capability knows. */
export interface AddRequest {
  /** The capability, as `pithy add` takes it. */
  capability: string;
  /**
   * The Workers it could be added to, by `apps/` directory. One names one command; several name one each, and
   * which is the reader's choice. Empty when the project has none.
   */
  workers: readonly WorkerDir[];
  /** A capability's manifest facts: the project's installed manifest first, then the kit's. */
  factsFor: (name: string) => AddFacts | undefined;
  /** What the Worker composes already, when the line knows. A prerequisite it composes is not missing. */
  composed?: ReadonlySet<string> | undefined;
  /**
   * The options the Worker's `pithy.config.ts` already states for this capability, for a line with no caller behind
   * it (doctor's). `pithy add` skips each (`flow.ts`'s `answeredConfigKeys`), so one is settled — and no `--set` is
   * named for it, which could contradict the config. A caller's own are in its context.
   */
  answered?: ReadonlySet<string> | undefined;
  /**
   * **The caller's own run (#711)**, when the line names it or a step on its way: the only source of the flags and
   * `--set` a line carries. For the caller's own capability, every flag, every `--set` and every option its config
   * answers; for another — a prerequisite named first — only `--dry-run` and `--json`, the run's mode.
   */
  caller?: Caller<"add"> | undefined;
}

/** What a line says about composing a capability. */
export interface AddPlan {
  /** The commands the line names, each runnable as written. A reader runs one. Empty when a person decides first. */
  commands: Command[];
  /** The `fix`: the one command, when there is exactly one and nothing in it is a choice. */
  fix: Command | undefined;
  /** What a person must decide before any `pithy add` runs, as a whole sentence. Absent when `commands` are named. */
  decide?: string;
}

/**
 * **The words a line says about composing a capability**: `wrap` around the commands, in code and joined by "or" —
 * `Run ${add}, then retry.` — or, when no command runs yet, what a person must decide, in place of the sentence.
 */
export function addAction(plan: AddPlan, wrap: (add: string) => string): string {
  return plan.decide ?? wrap(commandAlternatives(plan.commands));
}

/** Every combination of one value from each list, in order. */
function combinations(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>((done, list) => done.flatMap((prefix) => list.map((one) => [...prefix, one])), [[]]);
}

/** The values `--set` takes for an option, as `key=value`, without the ones `pithy add` refuses. `undefined` when open. */
function setValues(option: AddFacts["requiredOptions"][number]): string[] | undefined {
  const refused = option.choicesNeedingCode ?? {};
  const choices = option.choices?.filter((choice) => refused[choice] === undefined) ?? [];
  return choices.length === 0 ? undefined : choices.map((choice) => `${option.key}=${choice}`);
}

/** The prerequisites `--with-prerequisites` would compose for this request, deepest first. */
function prerequisitesOf(request: AddRequest, facts: AddFacts): string[] {
  return prerequisiteClosure({
    manifest: facts,
    composed: request.composed ?? new Set(),
    manifestFor: (name) => request.factsFor(name),
  });
}

/**
 * **The `pithy add` lines for one request**, and the `fix` among them when there is one. See the module comment
 * for every rule.
 */
export function addPlan(request: AddRequest): AddPlan {
  const { capability, workers } = request;
  if (workers.length === 0) {
    return {
      commands: [],
      fix: undefined,
      decide: `This project has no Worker to compose ${capability} into. Name one and create it with ${commandName("worker add")}, then compose ${capability} into it.`,
    };
  }
  const facts = request.factsFor(capability);
  // Neither installed nor the kit's: there is no capability by that name to compose, and naming a command for
  // it sends the reader to a refusal.
  if (facts === undefined) {
    return {
      commands: [],
      fix: undefined,
      decide: `No capability named ${capability} is installed or in the kit. Check the name against ${addListCommand()}.`,
    };
  }
  const prerequisites = prerequisitesOf(request, facts);
  const withPrerequisites = prerequisites.length > 0;

  // A prerequisite `--with-prerequisites` would compose with its defaults, when it has none to give.
  for (const name of prerequisites) {
    const peer = request.factsFor(name);
    if (peer !== undefined && peer.requiredOptions.length > 0) {
      const first = addPlan({ ...request, capability: name, answered: undefined });
      // That add composes `name` and what `name` brings, and nothing else: a prerequisite outside it is still
      // missing, and the command after it still needs --with-prerequisites to compose it (#711).
      const brought = prerequisitesOf({ ...request, capability: name }, peer);
      const then = addPlan({ ...request, composed: new Set([...(request.composed ?? []), name, ...brought]) });
      const firstWords = addAction(first, (add) => `Compose it first with ${add}`);
      const thenWords = addAction(then, (add) => `Then run ${add}.`);
      return {
        commands: [],
        fix: undefined,
        decide: `${capability} needs ${name}, and --with-prerequisites would give ${name} defaults it does not have. ${firstWords.replace(/\.$/, "")}. ${thenWords}`,
      };
    }
  }

  // The caller's own capability carries everything the caller gave; a step on its way only the run's mode.
  const own = request.caller !== undefined && callerCapability(request.caller) === capability;
  const caller: Readonly<Record<string, string>> = own ? (request.caller?.set ?? {}) : {};
  const answered = new Set([...(request.answered ?? []), ...(own ? (request.caller?.answered ?? []) : [])]);
  const flags = own ? callerFlags(request.caller) : stepFlags(request.caller);
  const unsettled = facts.requiredOptions.filter(
    (option) => caller[option.key] === undefined && !answered.has(option.key),
  );
  const open = unsettled.filter((option) => setValues(option) === undefined);
  if (open.length > 0) {
    const keys = open.map((option) => option.key).join(" and ");
    return {
      commands: [],
      fix: undefined,
      decide: `${capability} needs ${keys} decided, and only you can. Pass each to ${commandName("add")} with --set.`,
    };
  }
  const settled = Object.entries(caller).map(([key, value]) => `${key}=${value}`);
  const choices = combinations(unsettled.map((option) => setValues(option) ?? []));
  const commands = workers.flatMap((worker) =>
    choices.map((choice) => {
      const sets = [...settled, ...choice];
      return pithyCommandOf("add", {
        args: [capability],
        flags: {
          "--worker": worker,
          ...(withPrerequisites ? { "--with-prerequisites": true as const } : {}),
          ...(sets.length === 0 ? {} : { "--set": sets }),
          ...flags,
        },
      });
    }),
  );
  return { commands, fix: commands.length === 1 && unsettled.length === 0 ? commands[0] : undefined };
}

/** `pithy add --list`: the kit's catalog, which acts on no Worker. */
export function addListCommand(): Command {
  return pithyCommandOf("add", { flags: { "--list": true } });
}

/** Attach a plan's `fix` to `error`, when it has one, and hand the same error back. */
export function withAddFix<E extends PithyError>(error: E, plan: AddPlan): E {
  return plan.fix === undefined ? error : withFix(error, plan.fix);
}

/** A capability's facts: the project's installed manifest, when there is one, then the kit's. */
export function projectAddFacts(projectDir: string | undefined): (name: string) => AddFacts | undefined {
  return (name) => (projectDir === undefined ? undefined : installedAddFacts(projectDir, name)) ?? kitAddFacts(name);
}

/** The installed manifest's facts, read synchronously: a classifier building a sentence in a `catch` cannot await. */
function installedAddFacts(projectDir: string, name: string): AddFacts | undefined {
  try {
    const raw = JSON.parse(readFileSync(installedManifestPath(projectDir, name), "utf8")) as Partial<AddFacts> & {
      configOptions?: {
        key: string;
        default?: unknown;
        choices?: string[];
        choicesNeedingCode?: Record<string, string>;
      }[];
    };
    return {
      name,
      peerCapabilities: raw.peerCapabilities ?? [],
      requiredOptions: (raw.configOptions ?? [])
        .filter((option) => option.default === undefined)
        .map(({ key, choices, choicesNeedingCode }) => ({ key, choices, choicesNeedingCode })),
    };
  } catch {
    return undefined;
  }
}

/** What one Worker's `pithy.config.ts` composes, by registration, read synchronously. */
export function composedBy(workerDir: string, names: readonly string[]): Set<string> {
  let source = "";
  try {
    source = readFileSync(join(workerDir, "pithy.config.ts"), "utf8");
  } catch {
    return new Set();
  }
  return new Set(names.filter((name) => isRegistered(source, name)));
}

/**
 * **The Workers a line offers an add into, when it names none (#711)**: the ones already composing
 * `alongside`, when any does, and every configured Worker only when none does. `pithy add secrets --worker x`
 * offered for a Worker that composes nothing of secrets composed secrets into an unrelated Worker.
 */
export function offeredWorkers(projectDir: string, alongside?: string): WorkerDir[] {
  const dirs = configuredWorkerDirs(projectDir);
  const composing = alongside === undefined ? [] : dirs.filter((dir) => composedBy(dir, [alongside]).has(alongside));
  return (composing.length > 0 ? composing : dirs).map((dir) => workerDirName({ dir }));
}

/**
 * **The `pithy add secrets` a line names** — the command that records `SECRETS_STORE_ID`, since its bootstrap
 * resolves the account's store on every run. Offered for the Workers that compose secrets already, or every
 * Worker when none does.
 */
export function addSecretsPlan(projectDir: string): AddPlan {
  return addPlan({
    capability: "secrets",
    workers: offeredWorkers(projectDir, "secrets"),
    factsFor: projectAddFacts(projectDir),
  });
}

/** Where the run a refusal inside `pithy add` sends its caller back to acts. */
export interface AddWhere {
  /** The Worker the caller's capability is being added to. */
  workerDir: string;
  /** The project root, for the manifests; absent where the caller has none, and the kit's facts answer. */
  projectDir?: string | undefined;
}

/**
 * **The caller's own `pithy add`, again (#711)**, as a sentence names it: built from the caller's context and nothing
 * else — its capability on the same Worker, every option it settled, every option its Worker's config already
 * answers, and every flag it was given — so the rerun asks for nothing the first run did not. A rerun that dropped
 * the run's `--set` was refused for the option the first run had answered; one that ignored the config named a
 * choice the config had already made.
 */
export function addAgain(caller: Caller<"add">, where: AddWhere): string {
  const capability = callerCapability(caller) ?? "";
  const { workerDir, projectDir } = where;
  const factsFor = projectAddFacts(projectDir);
  const plan = addPlan({
    capability,
    workers: [workerDirName({ dir: workerDir })],
    factsFor,
    // What the Worker composes now: a prerequisite the run composed on the way is not missing on the rerun.
    composed: composedBy(workerDir, [...Object.keys(KIT_ADD_FACTS), ...(factsFor(capability)?.peerCapabilities ?? [])]),
    caller,
  });
  return addAction(plan, (add) => add);
}
