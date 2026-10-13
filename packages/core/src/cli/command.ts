// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "../error/pithyError";
import type { DEFAULT_ENVIRONMENTS, LOCAL_ENVIRONMENT } from "../naming/environment";
import { COMMANDS, GLOBAL_FLAGS, GROUPS } from "./commandCatalog.generated";
import {
  CONFIRM_FLAGS,
  CONFIRMATIONS,
  CREDENTIAL_FLAGS,
  DESTRUCTIVE_COMMANDS,
  DESTRUCTIVE_FLAGS,
  type DestructiveFlag,
  type DestructivePath,
  EVERY_ENVIRONMENT_ALWAYS,
  EVERY_ENVIRONMENT_WITHOUT_ENV,
  MEANING_FLAGS,
  MEANING_ONLY_WITH,
  NO_WORKER_MODES,
  PRODUCTION_CONFIRMS,
  PRODUCTION_ENVIRONMENTS,
  type ProductionPath,
  REQUIRED_BESIDE,
  WORKER_SCOPED,
  type WorkerScopedPath,
} from "./commandFacts";

/**
 * **The one place a `pithy` command line is spelled (#711).**
 *
 * #697 held every `fix` to one rule: it runs as written. The sentences beside it were held to nothing, and three
 * review rounds each found new ones that did not run — a `--worker` dropped, an `--env` left to default to `dev`,
 * a placeholder an agent pasted verbatim, a command that destroyed far more than the fault it was offered for.
 * Every one was a command spelled by hand at its own site, so every fix was one site, and the next site was
 * still spelled by hand.
 *
 * So no site spells one. A line that names a command gets it from here, and this module knows the tree
 * (`commandCatalog.generated.ts`, projected from the CLI's own parser) and the facts the parser cannot state
 * (`commandFacts.ts`). It refuses to build:
 *
 * - **a command that does not exist**, or a flag the command does not declare — at compile time for a literal
 *   path, at run time for one assembled from a capability's name;
 * - **a command missing a flag it needs**: one the parser requires, one a rule over several flags requires, an
 *   `--env` whose default would change what the command acts on, or the `--worker` a command acting on one
 *   Worker is refused without — and `--worker` takes a {@link WorkerDir}, the Worker's `apps/` directory, never
 *   its deployed script name;
 * - **a command that destroys something**, or a production provision. Those are a person's decision, and
 *   {@link personDecision} says so in a sentence that carries no command an agent would run.
 *
 * ## A builder reached at run time never throws because of data
 *
 * Every refusal above is about what **the program spells** — a command path, a flag name, an enum choice, the
 * shape of the line — and a value is one of two kinds:
 *
 * - **Spelled by the program**: the path, each flag's name, a choice from a flag's fixed set, a Worker directory
 *   (a {@link WorkerDir}, which only {@link workerDirOf} makes). These are checked, at compile time where the path
 *   is a literal.
 * - **Supplied by a caller**: a `--set` value, a secret's name, free text, anything a run read. These are
 *   shell-quoted as they are and never checked — `fromName=Acme <hi@acme.io>` is a value, not a placeholder, and a
 *   builder that read it as one turned `pithy add email` into `core/internal` after it had installed the package
 *   (#711). A `<placeholder>` is a fault of **spelling**, so the place that refuses one is the gate that reads
 *   spellings, `packages/cli/src/ci/runnableCommands.test.ts`, which reads every literal handed to a builder too.
 *
 * So whether a line is a person's decision never turns on a value at run time either. An environment a run reads —
 * a deployed Worker's `ENVIRONMENT`, a caller's `--env` — is data: {@link pithyCommand} takes no `--env` on a
 * command a production run makes a person's decision except a literal non-production one, {@link pithyCommandOf}
 * takes none there at all, and a line that names one it read is {@link remedy}'s or {@link rerunRemedy}'s, which
 * say a production one as a person's decision. {@link personDecision} takes only a command or flag that destroys
 * something, which is shape. What is left to throw is a program that spelled a line wrong, every time it runs.
 *
 * `packages/cli/src/ci/runnableCommands.test.ts` reads every string in every package's shipped source and fails
 * on a `pithy …` spelled anywhere but here, wherever it sits in the sentence.
 */

type Catalog = typeof COMMANDS;

/** The CLI itself: the first word of every line built here, and what a line names when it means no command. */
const CLI = "pithy";

/** A command the CLI runs, as typed after `pithy`. */
export type CommandPath = keyof Catalog;

/** A group, which only lists its subcommands. A sentence may name one in prose. */
export type GroupPath = (typeof GROUPS)[number];

declare const WORKER_DIR: unique symbol;

/**
 * **A Worker as `--worker` takes it: its `apps/` directory.** Branded, so the deployed script name — a `string`
 * every Worker also carries — cannot be passed where this is wanted. Made by {@link workerDirOf} from the
 * Worker's directory.
 */
export type WorkerDir = string & { readonly [WORKER_DIR]: true };

/**
 * The Worker a directory holds, as `--worker` names it: the directory's own name. Takes the directory rather
 * than a name, because a name in hand is as often the deployed script name, which `--worker` does not resolve.
 */
export function workerDirOf(worker: { readonly dir: string }): WorkerDir {
  const name = worker.dir
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .at(-1);
  if (name === undefined) throw new InternalError({ message: "A Worker directory has a name.", detail: worker.dir });
  return name as WorkerDir;
}

declare const BUILT: unique symbol;

/** A command line this module built, and so one that runs as written. The only thing a `fix` may carry. */
export type Command = string & { readonly [BUILT]: true };

type FlagDefs<P extends CommandPath> = Catalog[P]["flags"];
type FlagName<P extends CommandPath> = Extract<keyof FlagDefs<P>, string>;
type ConfirmFlag = (typeof CONFIRM_FLAGS)[number];
type MeaningFlag = (typeof MEANING_FLAGS)[number];

/**
 * An environment no project's production run is: the local one, and the deployed one that is not `prod`. The only
 * `--env` a literal line may give a command whose production run is a person's decision — so it is spelled, never
 * read, and an environment a run read goes through {@link remedy}, which decides by its value.
 */
export type QuietEnvironment =
  | typeof LOCAL_ENVIRONMENT
  | Exclude<(typeof DEFAULT_ENVIRONMENTS)[number], (typeof PRODUCTION_ENVIRONMENTS)[number]>;

/**
 * The value one flag takes: `true` for a boolean, a {@link WorkerDir} for `--worker`, one of a fixed set's choices,
 * a {@link QuietEnvironment} for the `--env` of a command a production run makes a person's decision, else a string.
 */
type FlagValue<P, D, F> = F extends "--worker"
  ? WorkerDir
  : D extends { type: "boolean" }
    ? true
    : F extends "--env"
      ? P extends ProductionPath
        ? QuietEnvironment
        : string
      : D extends { enum: readonly (infer E)[] }
        ? D extends { repeatable: true }
          ? E | readonly E[]
          : E
        : D extends { repeatable: true }
          ? string | readonly string[]
          : string;

/** Whether a line naming `P` must carry `F`. `add`'s Worker is its own builder's to name (`addCommand.ts`). */
type IsNeeded<P extends CommandPath, F extends FlagName<P>> = FlagDefs<P>[F] extends { required: true }
  ? true
  : F extends MeaningFlag
    ? FlagDefs<P>[F] extends { default: string }
      ? P extends keyof typeof MEANING_ONLY_WITH
        ? false
        : true
      : false
    : F extends "--worker"
      ? P extends Exclude<WorkerScopedPath, "add">
        ? true
        : false
      : false;

type NeededFlag<P extends CommandPath> = { [F in FlagName<P>]: IsNeeded<P, F> extends true ? F : never }[FlagName<P>];

/** The flags a line naming `P` passes: the ones it needs, and any other it declares that destroys nothing. */
export type CommandFlags<P extends CommandPath> = { [F in NeededFlag<P>]: FlagValue<P, FlagDefs<P>[F], F> } & {
  [F in Exclude<FlagName<P>, NeededFlag<P> | DestructiveFlag | ConfirmFlag>]?: FlagValue<P, FlagDefs<P>[F], F>;
};

type HasRequiredPositional<P extends CommandPath> = [
  Extract<Catalog[P]["positionals"][number], { required: true }>,
] extends [never]
  ? false
  : true;

/** What a line naming `P` passes: its positional arguments, and its flags, in the order they are written. */
export type CommandParts<P extends CommandPath> = (HasRequiredPositional<P> extends true
  ? { args: readonly [string, ...string[]] }
  : { args?: readonly string[] }) &
  ([NeededFlag<P>] extends [never] ? { flags?: CommandFlags<P> } : { flags: CommandFlags<P> });

type PartsArgument<P extends CommandPath> =
  HasRequiredPositional<P> extends true
    ? [parts: CommandParts<P>]
    : [NeededFlag<P>] extends [never]
      ? [parts?: CommandParts<P>]
      : [parts: CommandParts<P>];

/**
 * A command that is built like any other: one that destroys nothing, and that does not act on every environment on
 * every run — a line names that one through {@link remedy}, which says it as a person's decision.
 */
export type BuildablePath = Exclude<CommandPath, DestructivePath | (typeof EVERY_ENVIRONMENT_ALWAYS)[number]>;

/** Parts as a builder holds them when the path is a value rather than a literal. */
export interface LooseParts {
  readonly args?: readonly string[];
  readonly flags?: Readonly<Record<string, string | true | readonly string[] | undefined>>;
}

/** What {@link commandFaults} is asked to allow. */
export interface FaultOptions {
  /**
   * A person's decision: a destructive command or flag, or a production run, is named for a person to choose,
   * and the confirmation flags are theirs to add. {@link personDecision} asks for this; nothing else does.
   */
  readonly person?: boolean;
  /** The project's `seed.productionEnvironments`, beyond the {@link PRODUCTION_ENVIRONMENTS} every project has. */
  readonly productionEnvironments?: readonly string[];
  /**
   * A line said by a **deployed** Worker — into its own log, or to an HTTP caller — which cannot know the `apps/`
   * directory that provisioned it. Every rule holds but `--worker`. Only the files
   * `packages/cli/src/ci/runnableCommands.test.ts` lists as runtime lines may pass it.
   */
  readonly runtime?: boolean;
  /**
   * **Every value on the line was spelled by the program** — the gate, reading a line written in a literal — so a
   * `<placeholder>` or a blank among them is a fault. No builder says this: a value handed to a builder is a
   * caller's, and is shell-quoted as it is (see the module comment).
   */
  readonly spelled?: boolean;
  /** Treat `<x>`, the gate's mark for interpolation, as a value rather than a placeholder. */
  readonly interpolated?: boolean;
}

/**
 * What a builder adds to {@link FaultOptions}: that every value is the caller's own run, handed back as it was
 * given, so not even a fixed set of choices is held against it — the run's own parser has had its say.
 */
interface BuildOptions extends FaultOptions {
  readonly given?: boolean;
}

/** Whether `path` is a command the CLI runs. */
export function isCommandPath(path: string): path is CommandPath {
  return Object.hasOwn(COMMANDS, path);
}

/** Whether `path` is a group. */
export function isGroupPath(path: string): path is GroupPath {
  return (GROUPS as readonly string[]).includes(path);
}

/**
 * What the catalog says about one flag of one command — its type, whether it is required, its default — or
 * `undefined` when the command does not declare it.
 */
export function commandFlag(
  path: string,
  flag: string,
): { readonly type: "boolean" | "string"; readonly required: boolean; readonly default?: string } | undefined {
  if (!isCommandPath(path)) return undefined;
  return (COMMANDS[path] as unknown as CommandDef).flags[flag];
}

/** A flag's catalog entry, read loosely. */
interface FlagDef {
  readonly type: "boolean" | "string";
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly default?: string;
  readonly enum?: readonly string[];
}

/** A rule over several flags, read loosely. */
interface GroupDef {
  readonly kind: "exactlyOne" | "atMostOne" | "allOrNone" | "requires";
  readonly flags?: readonly string[];
  readonly flag?: string;
  readonly needs?: readonly string[];
  readonly any?: boolean;
}

/** One command's catalog entry, read loosely. */
interface CommandDef {
  readonly positionals: readonly { readonly name: string; readonly required: boolean; readonly variadic: boolean }[];
  readonly flags: Readonly<Record<string, FlagDef>>;
  readonly groups: readonly GroupDef[];
}

/** A value nobody can run: a `<placeholder>`, or nothing at all. */
function isPlaceholder(value: string, options: FaultOptions): boolean {
  if (value.trim().length === 0) return true;
  const marks = value.match(/<[^>]*>/g) ?? [];
  return marks.some((mark) => !(options.interpolated === true && mark === "<x>"));
}

/** Whether the environment a line names is a production one. */
function isProduction(env: string, options: FaultOptions): boolean {
  const name = env.trim().toLowerCase();
  return [...PRODUCTION_ENVIRONMENTS, ...(options.productionEnvironments ?? [])].some(
    (one) => one.trim().toLowerCase() === name,
  );
}

/**
 * **Every reason a command line would not run as written, or would do more than a remedy may.** Empty when it
 * runs. The builder throws on any; `runnableCommands.test.ts` holds every hand-spelled line it reads to the same
 * function, so the gate and the builder cannot disagree about a rule.
 */
export function commandFaults(path: string, parts: LooseParts = {}, options: BuildOptions = {}): string[] {
  const shown = `${CLI} ${path}`;
  if (!isCommandPath(path)) {
    return [isGroupPath(path) ? `\`${shown}\` is a group, which runs nothing.` : `\`${shown}\` is not a command.`];
  }
  const def = COMMANDS[path] as unknown as CommandDef;
  const faults: string[] = [];
  const args = parts.args ?? [];
  const flags = Object.entries(parts.flags ?? {}).filter(
    (entry): entry is [string, string | true | readonly string[]] => entry[1] !== undefined,
  );
  const named = new Set(flags.map(([flag]) => flag));

  const required = def.positionals.filter((one) => one.required).length;
  const variadic = def.positionals.some((one) => one.variadic);
  if (args.length < required) faults.push(`\`${shown}\` needs its ${def.positionals[args.length]?.name} argument.`);
  if (!variadic && args.length > def.positionals.length)
    faults.push(`\`${shown}\` takes ${def.positionals.length} arguments.`);
  // A value is checked only where the program spelled it; a caller's is quoted as it is.
  for (const arg of options.spelled === true ? args : []) {
    if (isPlaceholder(arg, options)) faults.push(`\`${shown}\` is given "${arg}", which nobody can run.`);
  }

  const global = new Set<string>(GLOBAL_FLAGS);
  for (const [flag, value] of flags) {
    const flagDef = def.flags[flag];
    if (flagDef === undefined) {
      if (!global.has(flag)) faults.push(`\`${shown}\` has no ${flag}.`);
      continue;
    }
    const values = typeof value === "string" ? [value] : value === true ? [] : [...value];
    if (flagDef.type === "boolean" && value !== true) faults.push(`\`${shown} ${flag}\` takes no value.`);
    if (flagDef.type === "string" && (value === true || values.length === 0)) {
      faults.push(`\`${shown} ${flag}\` needs a value.`);
    }
    if (values.length > 1 && !flagDef.repeatable) faults.push(`\`${shown} ${flag}\` is passed once.`);
    for (const one of values) {
      if (options.spelled === true && isPlaceholder(one, options)) {
        faults.push(`\`${shown} ${flag}\` is given "${one}", which nobody can run.`);
      } else if (
        options.given !== true &&
        flagDef.enum !== undefined &&
        !flagDef.enum.includes(one) &&
        !(options.interpolated && one === "<x>")
      ) {
        faults.push(`\`${shown} ${flag}\` takes ${flagDef.enum.join(", ")}, not ${one}.`);
      }
    }
  }

  const confirms = new Set<string>(CONFIRM_FLAGS);
  for (const flag of named) {
    if (confirms.has(flag)) faults.push(`\`${shown} ${flag}\` carries a confirmation only a person gives.`);
    if ((CREDENTIAL_FLAGS as readonly string[]).includes(flag)) {
      faults.push(`\`${shown} ${flag}\` carries a credential, which no line repeats.`);
    }
  }
  for (const [flag, flagDef] of Object.entries(def.flags)) {
    if (named.has(flag)) continue;
    if (flagDef.required && !(options.person === true && confirms.has(flag))) {
      faults.push(`\`${shown}\` is refused without ${flag}.`);
    }
    const onlyWith = (MEANING_ONLY_WITH as Readonly<Record<string, string>>)[path];
    const meaningful = onlyWith === undefined || named.has(onlyWith);
    if ((MEANING_FLAGS as readonly string[]).includes(flag) && flagDef.default !== undefined && meaningful) {
      faults.push(`\`${shown}\` without ${flag} acts on ${flagDef.default}; a line names the one it is about.`);
    }
  }
  for (const group of def.groups) faults.push(...groupFaults(shown, group, named));
  for (const rule of REQUIRED_BESIDE) {
    if (rule.path === path && named.has(rule.with) && !named.has(rule.unless) && !named.has(rule.needs)) {
      faults.push(`\`${shown} ${rule.with}\` is refused without ${rule.needs}.`);
    }
  }

  const noWorker = (NO_WORKER_MODES[path] ?? []).some((flag) => named.has(flag));
  if ((WORKER_SCOPED as readonly string[]).includes(path) && !noWorker && !named.has("--worker") && !options.runtime) {
    faults.push(`\`${shown}\` acts on one Worker and names none.`);
  }

  if (options.person !== true) {
    for (const consequence of consequencesOf(path, parts, options))
      faults.push(`\`${shown}\` ${consequence}: a person's decision.`);
  }
  return faults;
}

/**
 * **What a command does that only a person may decide**: what it deletes, or that it runs against production. Empty
 * for a command a remedy may name.
 */
export function consequencesOf(path: string, parts: LooseParts = {}, options: FaultOptions = {}): string[] {
  const consequences: string[] = [];
  if (Object.hasOwn(DESTRUCTIVE_COMMANDS, path)) {
    consequences.push(`deletes ${DESTRUCTIVE_COMMANDS[path as DestructivePath]}`);
  }
  for (const [flag, value] of Object.entries(parts.flags ?? {})) {
    if (value !== undefined && Object.hasOwn(DESTRUCTIVE_FLAGS, flag)) {
      consequences.push(`deletes ${DESTRUCTIVE_FLAGS[flag as DestructiveFlag]}`);
    }
  }
  const env = parts.flags?.["--env"];
  if (Object.hasOwn(PRODUCTION_CONFIRMS, path) && typeof env === "string" && isProduction(env, options)) {
    consequences.push(`runs against ${env}, a production environment`);
  }
  // Left off, `--env` is every environment for such a command, production included — and one with no `--env` to give
  // is every environment on every run (#711).
  if ((env === undefined && actsOnEveryEnvironment(path)) || actsOnEveryEnvironmentAlways(path)) {
    consequences.push("runs against every environment, production included");
  }
  return consequences;
}

/**
 * Whether `path` acts on every environment, production among them, when its `--env` is left off — `pithy testers
 * provision` (`commandFacts.ts`'s {@link EVERY_ENVIRONMENT_WITHOUT_ENV}). A line about one environment names it.
 */
export function actsOnEveryEnvironment(path: string): boolean {
  return (EVERY_ENVIRONMENT_WITHOUT_ENV as readonly string[]).includes(path);
}

/**
 * Whether `path` acts on every environment, production among them, on every run, with no `--env` to narrow it —
 * `pithy secrets provision` (`commandFacts.ts`'s {@link EVERY_ENVIRONMENT_ALWAYS}). A line naming it is a person's
 * decision, always.
 */
export function actsOnEveryEnvironmentAlways(path: string): boolean {
  return (EVERY_ENVIRONMENT_ALWAYS as readonly string[]).includes(path);
}

/** What one rule over several flags says about the flags a line names. */
function groupFaults(shown: string, group: GroupDef, named: ReadonlySet<string>): string[] {
  const among = (group.flags ?? []).filter((flag) => named.has(flag));
  const list = (group.flags ?? []).join(", ");
  switch (group.kind) {
    case "exactlyOne":
      return among.length === 1 ? [] : [`\`${shown}\` takes exactly one of ${list}.`];
    case "atMostOne":
      return among.length <= 1 ? [] : [`\`${shown}\` takes at most one of ${list}.`];
    case "allOrNone":
      return among.length === 0 || among.length === (group.flags ?? []).length
        ? []
        : [`\`${shown}\` takes all of ${list}, or none.`];
    case "requires": {
      if (group.flag === undefined || !named.has(group.flag)) return [];
      const needs = group.needs ?? [];
      const met = group.any === true ? needs.some((flag) => named.has(flag)) : needs.every((flag) => named.has(flag));
      return met ? [] : [`\`${shown} ${group.flag}\` needs ${needs.join(group.any === true ? " or " : " and ")}.`];
    }
  }
}

/** A word as a shell reads it back: quoted only when it has to be. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The line, spelled: arguments first, then each flag in the order the caller wrote it. */
function spell(path: string, parts: LooseParts): string {
  const words = [CLI, path, ...(parts.args ?? []).map(shellWord)];
  for (const [flag, value] of Object.entries(parts.flags ?? {})) {
    if (value === undefined) continue;
    if (value === true) words.push(flag);
    else for (const one of typeof value === "string" ? [value] : value) words.push(flag, shellWord(one));
  }
  return words.join(" ");
}

/** Throw what {@link commandFaults} found, or hand back nothing. */
function refuseFaults(path: string, parts: LooseParts, options: BuildOptions): void {
  const faults = commandFaults(path, parts, options);
  if (faults.length > 0) {
    throw new InternalError({
      message: `A line names a command that does not run as written: ${faults.join(" ")}`,
      detail: spell(path, parts),
    });
  }
}

/**
 * **A command line that runs as written**, from a literal path: the tree checks its command, its flags and the
 * flags it needs at compile time, and {@link commandFaults} checks the rest when it is built.
 */
export function pithyCommand<P extends BuildablePath>(path: P, ...parts: PartsArgument<P>): Command {
  // The compiler has held an `--env` here to a quiet one, so no value it carries can be a person's decision.
  return build(path, (parts[0] ?? {}) as LooseParts, {});
}

/** Check a line's shape, and spell it. */
function build(path: string, parts: LooseParts, options: BuildOptions): Command {
  refuseFaults(path, parts, options);
  return spell(path, parts) as Command;
}

/** Whether a production run of `path` is a person's decision, so its `--env` decides what kind of line it is. */
function isProductionPath(path: string): path is ProductionPath {
  return Object.hasOwn(PRODUCTION_CONFIRMS, path);
}

/** The parts of a line a deployed Worker builds: no `--env`, which it reads as data and names through {@link remedy}. */
export interface RuntimeParts extends LooseParts {
  readonly flags?: LooseParts["flags"] & { readonly "--env"?: never };
}

/**
 * **The same, from a path that is a value** — `` `${capability} provision` ``. Nothing is checked at compile
 * time, so everything is checked here, and a path the CLI does not have is refused rather than spelled.
 *
 * Whether a command is a person's decision never turns on a value here. A runtime line names no `--env`: a deployed
 * Worker's environment is data, and whether its command is a person's decision depends on it, so that line is
 * {@link remedy}'s. Nor does any line name the `--env` of a command a production run makes a person's decision —
 * `provision`, `seed`, `vector provision`. Each is refused for every value, so no environment is a surprise.
 */
export function pithyCommandOf(path: string, parts: RuntimeParts, options: { readonly runtime: true }): Command;
export function pithyCommandOf(path: string, parts?: LooseParts): Command;
export function pithyCommandOf(
  path: string,
  parts: LooseParts = {},
  options: Pick<FaultOptions, "runtime"> = {},
): Command {
  if (parts.flags?.["--env"] !== undefined && (options.runtime === true || isProductionPath(path))) {
    throw new InternalError({
      message: `A line names an environment it read through remedy, never through pithyCommandOf: \`${spell(path, parts)}\`.`,
    });
  }
  return build(path, parts, options);
}

/**
 * **A command a person decides on, said as one.** For a fault whose only remedy destroys something, or runs
 * against production: the sentence names the command, says what it does and that the choice is a person's, and
 * leaves every confirmation flag for them to add. It returns a sentence, never a {@link Command}, so it cannot
 * become a `fix`.
 *
 * It takes a command that destroys something, or a line naming a flag that does — shape, never a value. A command
 * whose production run is a person's decision is a decision only for a production `--env`, which is data, so that
 * line is {@link remedy}'s, which decides by the value; here it is refused for every value.
 */
export function personDecision(
  path: PersonPath,
  parts: LooseParts,
  options: Pick<FaultOptions, "productionEnvironments" | "runtime"> = {},
): string {
  const destroys =
    Object.hasOwn(DESTRUCTIVE_COMMANDS, path) ||
    Object.entries(parts.flags ?? {}).some(
      ([flag, value]) => value !== undefined && Object.hasOwn(DESTRUCTIVE_FLAGS, flag),
    );
  if (!destroys) {
    throw new InternalError({
      message: `\`${spell(path, parts)}\` destroys nothing; a person's decision names what it destroys, and a production run is remedy's to say.`,
    });
  }
  return decision(path, parts, options);
}

/** A command that destroys something, or one declaring a flag that does: what {@link personDecision} takes. */
export type PersonPath = {
  [P in CommandPath]: P extends DestructivePath
    ? P
    : [Extract<FlagName<P>, DestructiveFlag>] extends [never]
      ? never
      : P;
}[CommandPath];

/** The sentence {@link personDecision} says, for any command with something a person must decide. */
function decision(path: string, parts: LooseParts, options: BuildOptions): string {
  refuseFaults(path, parts, { ...options, person: true });
  const consequences = consequencesOf(path, parts, options);
  if (consequences.length === 0) {
    throw new InternalError({
      message: `\`${spell(path, parts)}\` has nothing a person must decide; build it as a command.`,
    });
  }
  const named = Object.keys(parts.flags ?? {});
  const env = parts.flags?.["--env"];
  const asked = CONFIRMATIONS.filter(
    (one) =>
      one.path === path &&
      (one.when === undefined || named.includes(one.when)) &&
      !(typeof env === "string" && (one.unlessEnv ?? []).includes(env)),
  );
  const flags = asked.map((one) => one.flag);
  const production = (PRODUCTION_CONFIRMS as Readonly<Record<string, string | null>>)[path];
  const everyEnvironment = (env === undefined && actsOnEveryEnvironment(path)) || actsOnEveryEnvironmentAlways(path);
  if (typeof production === "string" && ((typeof env === "string" && isProduction(env, options)) || everyEnvironment)) {
    flags.push(production);
  }
  const confirm =
    flags.length === 0
      ? ""
      : ` with its ${[...new Set(flags)].join(" and ")} ${flags.length === 1 ? "phrase" : "phrases"}, which only a person gives,`;
  // "deletes A and deletes B" reads as "deletes A and B".
  const deleted = consequences.filter((one) => one.startsWith("deletes ")).map((one) => one.slice("deletes ".length));
  const said = [
    ...(deleted.length === 0 ? [] : [`deletes ${deleted.join(" and ")}`]),
    ...consequences.filter((one) => !one.startsWith("deletes ")),
  ];
  return `\`${spell(path, parts)}\`${confirm} ${said.join(" and ")}. That is a person's decision, not a fix.`;
}

/** **A remedy**: the command a `fix` carries when one may, and the words a line says about it. */
export interface Remedy {
  /** The command, when it runs as written and a `fix` may carry it. `undefined` for a person's decision. */
  readonly fix: Command | undefined;
  /** The words: `wrap` around the command, or — for a person's decision — that sentence in its place. */
  say(wrap: (command: string) => string): string;
}

/**
 * **The remedy a line names**, decided by the command rather than by its site: a command a remedy may name is a
 * `fix` and goes into the sentence; one that destroys something or runs against production is a person's
 * decision, said as one, with no `fix`. A command that does not run is refused either way.
 */
export function remedy(
  path: string,
  parts: LooseParts = {},
  options: Pick<FaultOptions, "productionEnvironments" | "runtime"> = {},
): Remedy {
  return remedyOf(path, parts, options);
}

/** {@link remedy}, with what a builder knows about where the values came from. */
function remedyOf(path: string, parts: LooseParts, options: BuildOptions): Remedy {
  if (isCommandPath(path) && consequencesOf(path, parts, options).length > 0) {
    const sentence = decision(path, parts, options);
    return { fix: undefined, say: () => sentence };
  }
  const command = build(path, parts, options);
  return { fix: command, say: (wrap) => wrap(command) };
}

declare const CALLER: unique symbol;

/**
 * **The caller's own run (#711): the one input every rerun and every fix naming it again is built from.**
 *
 * Each review round of #711 found another run again that dropped what the caller gave — `--json`, `--worker`,
 * `--dry-run`, a `--set`, an option the Worker's config already answers — because each was rebuilt at its own site
 * from whatever flags that site held. So a rerun builder ({@link rerunCommand}, {@link rerunRemedy}, `pithy add`'s
 * `addAgain`) takes this and nothing else, and this is made only by {@link callerOf}, from a run's parsed arguments.
 * Branded, so loose flags do not type-check where one is wanted; `packages/cli/src/ci/runnableCommands.test.ts`
 * fails on a cast to it and on a {@link callerOf} handed anything but a run's own arguments.
 */
export interface Caller<P extends CommandPath = CommandPath> {
  /** The command the run was. */
  readonly path: P;
  /** Its parsed arguments, keyed as the parser keys them (`worker`, `routing-zone`, `dry-run`). */
  readonly given: Readonly<Record<string, unknown>>;
  /** Its `--set` values, by key, and every option it settled by a prompt ({@link settledBy}). */
  readonly set: Readonly<Record<string, string>>;
  /**
   * The options the Worker's config already answers, for a command that reads one (`pithy add`): settled, so a
   * rerun names no `--set` for them, which could contradict the config.
   */
  readonly answered: ReadonlySet<string>;
  readonly [CALLER]: true;
}

/** `key=value` entries, by key; an entry with no `=` names nothing. */
function setEntries(entries: unknown): Record<string, string> {
  const list = typeof entries === "string" ? [entries] : Array.isArray(entries) ? entries : [];
  const values: Record<string, string> = {};
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const at = entry.indexOf("=");
    if (at > 0) values[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return values;
}

/**
 * **A run's own context**, from its parsed arguments. `set` is the raw `--set` entries where the parser keeps only the
 * last (`collectSetFlags`); absent, they are read from `given.set`. `answered` is what the Worker's config states.
 */
export function callerOf<P extends CommandPath>(
  path: P,
  given: Readonly<Record<string, unknown>>,
  context: { readonly set?: readonly string[] | undefined; readonly answered?: Iterable<string> | undefined } = {},
): Caller<P> {
  return {
    path,
    given,
    set: setEntries(context.set ?? given.set),
    answered: new Set(context.answered ?? []),
  } as unknown as Caller<P>;
}

/** The same caller, with what the run settled on its way — a prompt's answers — carried as `--set` too. */
export function settledBy<P extends CommandPath>(
  caller: Caller<P>,
  values: Readonly<Record<string, string>>,
): Caller<P> {
  return { ...caller, set: { ...caller.set, ...values } };
}

/** The same caller, with the options its Worker's config answers. */
export function answeredBy<P extends CommandPath>(caller: Caller<P>, keys: Iterable<string>): Caller<P> {
  return { ...caller, answered: new Set([...caller.answered, ...keys]) };
}

/** What a run-again is told beyond the arguments the run was given. */
export interface RerunOptions {
  /** The positional arguments, as the command takes them. */
  readonly args?: readonly string[];
  /** What the run resolved for itself — the Worker it picked when it was not named — or `undefined` to drop one. */
  readonly flags?: LooseParts["flags"];
  /** The project's `seed.productionEnvironments`, beyond the ones every project has. */
  readonly productionEnvironments?: readonly string[] | undefined;
}

/**
 * A run again, as parts: each flag the command declares, carried when it was given — a boolean when true, a value
 * when it differs from its default or when its default would change the meaning (`--env`, where the command reads
 * it). A confirmation or a credential is never carried: each is a person's to give again.
 */
function rerunParts(caller: Caller, options: RerunOptions): LooseParts {
  const { path, given } = caller;
  const def = COMMANDS[path] as unknown as CommandDef;
  const flags: Record<string, string | true | readonly string[]> = {};
  for (const [flag, flagDef] of Object.entries(def.flags)) {
    if ((CONFIRM_FLAGS as readonly string[]).includes(flag)) continue;
    if ((CREDENTIAL_FLAGS as readonly string[]).includes(flag)) continue;
    // `--set` is the caller's by key: every value it passed, and every option it settled on the way.
    const value =
      flag === "--set" ? Object.entries(caller.set).map(([key, one]) => `${key}=${one}`) : given[flag.slice(2)];
    if (flagDef.type === "boolean") {
      if (value === true) flags[flag] = true;
      continue;
    }
    if (Array.isArray(value)) {
      const values = value.filter((one): one is string => typeof one === "string" && one.length > 0);
      if (values.length > 0) flags[flag] = values;
      continue;
    }
    if (typeof value !== "string" || value.length === 0) continue;
    // A default `--env` names nothing on a command that reads it only under another flag (`upgrade` without
    // `--migrate`), and is carried as soon as that flag is.
    const onlyWith = (MEANING_ONLY_WITH as Readonly<Record<string, string>>)[path];
    const meaning =
      (MEANING_FLAGS as readonly string[]).includes(flag) &&
      (onlyWith === undefined || given[onlyWith.slice(2)] === true);
    if (value !== flagDef.default || meaning) flags[flag] = value;
  }
  return { args: options.args ?? [], flags: { ...flags, ...options.flags } };
}

/** A command whose run again is always a command: it destroys nothing, and no production run of it is a person's. */
export type RerunPath = Exclude<CommandPath, DestructivePath | ProductionPath>;

/**
 * **The caller's own command, to run again (#711)**, as a {@link Command} — rebuilt from the run's {@link Caller}, so
 * a rerun asks for nothing the first run did not. `options.flags` adds what the run resolved for itself (the Worker it
 * picked) or drops a flag whose work is done (`undefined`).
 *
 * It takes no command whose run again could be a person's decision — one that destroys something, or one a
 * production `--env` makes a person's: that run again is {@link rerunRemedy}'s, which says so rather than throwing.
 */
export function rerunCommand(
  caller: Caller<RerunPath>,
  options: Omit<RerunOptions, "productionEnvironments"> = {},
): Command {
  const path: string = caller.path;
  if (!isCommandPath(path)) return pithyCommandOf(path);
  if (Object.hasOwn(DESTRUCTIVE_COMMANDS, path) || Object.hasOwn(PRODUCTION_CONFIRMS, path)) {
    throw new InternalError({
      message: `\`${commandName(path)}\` may be a person's decision to run again; name it with rerunRemedy.`,
    });
  }
  return build(path, rerunParts(caller, options), { given: true });
}

/**
 * **The caller's own command, as a line names it to run again (#711)** — the {@link Remedy} for
 * {@link rerunCommand}'s parts, for any command. A run again that a production `--env` makes a person's decision is
 * said as one, with no `fix`, rather than thrown after the run did its work. `say` hands `wrap` the command in code
 * and — where the run was given a credential by flag, which no line repeats — the flags to pass again beside it.
 */
export function rerunRemedy(caller: Caller, options: RerunOptions = {}): Remedy {
  const { path, given } = caller;
  if (!isCommandPath(path)) return remedy(path);
  const parts = rerunParts(caller, options);
  const found = remedyOf(path, parts, { productionEnvironments: options.productionEnvironments ?? [], given: true });
  const withheld = (CREDENTIAL_FLAGS as readonly string[]).filter((flag) => {
    const value = given[flag.slice(2)];
    return typeof value === "string" && value.length > 0;
  });
  const credentials = withheld.join(" and ");
  if (found.fix === undefined) {
    const sentence = found.say((command) => command);
    return {
      fix: undefined,
      say: () => (withheld.length === 0 ? sentence : `${sentence} It takes the ${credentials} this run was given.`),
    };
  }
  const line =
    withheld.length === 0 ? `\`${found.fix}\`` : `\`${found.fix}\` with the ${credentials} this run was given`;
  return { fix: found.fix, say: (wrap) => wrap(line) };
}

/**
 * **A command named in prose, not given to run** — "as `pithy add` wrote it". Checked to exist, and spelled with
 * nothing after it. A line that tells somebody to run a command builds it with {@link pithyCommand}.
 */
export function commandName(path: CommandPath | GroupPath): string {
  return `${CLI} ${path}`;
}

/** {@link commandName}, for a path that is a value: refused when the CLI has no such command or group. */
export function commandNameOf(path: string): string {
  if (!isCommandPath(path) && !isGroupPath(path)) {
    throw new InternalError({ message: `A line names \`pithy ${path}\`, which is not a command.` });
  }
  return `${CLI} ${path}`;
}

/**
 * {@link commandNameOf}, for a path as a parser walked it, word by word. Empty is the root, which is the CLI
 * itself rather than a command, and is named as such.
 */
export function commandNameOfPath(path: readonly string[]): string {
  return path.length === 0 ? CLI : commandNameOf(path.join(" "));
}

/**
 * **The CLI at a version** — `pithy 0.9.5`, as a line names a release rather than a command. A line never spells
 * `pithy` before an interpolation: the gate reads that as a command it cannot check.
 */
export function cliAtVersion(version: string): string {
  return `${CLI} ${version}`;
}

/**
 * **How each package manager runs a project's own binary**: `bun x`, `pnpm exec`, `yarn`, `npx`. The one table
 * both a spawned process (`packages/cli/src/project/packageManager.ts`'s `execArgs`) and a line naming one read.
 */
export const PACKAGE_EXEC = {
  bun: ["bun", "x"],
  pnpm: ["pnpm", "exec"],
  yarn: ["yarn"],
  npm: ["npx"],
} as const satisfies Readonly<Record<string, readonly [string, ...string[]]>>;

/** A package manager a project runs its own binaries through. */
export type ExecPackageManager = keyof typeof PACKAGE_EXEC;

/**
 * **A built command, run through the project's own package manager** — the `pithy` the project installed, never
 * a global one, which may be an older CLI than the line is about. Takes a {@link Command}, so what follows the
 * prefix was built and runs as written.
 */
export function viaPackageManager(pm: ExecPackageManager, command: Command): Command {
  return [...PACKAGE_EXEC[pm], command].join(" ") as Command;
}

/** `a`, `a or b`, `a, b or c`, each in code: commands a reader picks one of. */
export function commandAlternatives(commands: readonly string[]): string {
  const coded = commands.map((command) => `\`${command}\``);
  return coded.length <= 1 ? coded.join("") : `${coded.slice(0, -1).join(", ")} or ${coded.at(-1)}`;
}

/** `a`, `a and b`, `a, b and c`, each in code: commands that all run. */
export function commandSequence(commands: readonly string[]): string {
  const coded = commands.map((command) => `\`${command}\``);
  return coded.length <= 1 ? coded.join("") : `${coded.slice(0, -1).join(", ")} and ${coded.at(-1)}`;
}
