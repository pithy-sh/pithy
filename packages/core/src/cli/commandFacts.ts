// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **What the catalog cannot say about a `pithy` command, written down once (#711).**
 *
 * `commandCatalog.generated.ts` is the parser's own account of every command: its arguments, its flags, which
 * are required, which have defaults, which go together. Four facts are not in any parser, and each was the
 * fault behind a line that did not run as written:
 *
 * - **Which commands act on one Worker**, and are refused `input/required` without `--worker` where a project
 *   has several. `packages/cli/src/ci/runnableCommands.test.ts` proves every entry by running it in a
 *   two-Worker project, and fails on a command that takes `--worker` and is not classified here.
 * - **Which flag's default changes what the command acts on.** `pithy vector provision` with no `--env`
 *   provisions `dev`, so a line about staging that leaves it off sends the reader to the wrong environment.
 * - **Which commands destroy something**, and are never a remedy for a smaller fault. `pithy feature destroy`
 *   was offered as the fix for one mis-shaped vector index.
 * - **Which flag needs another beside it** that the parser does not enforce: `pithy provision --env` is refused
 *   without `--yes`, at run time.
 *
 * `command.ts` builds every command a line names from these and the catalog, and refuses one that breaks them.
 * Nothing here imports anything, so a Worker that names a command pays for two tables and nothing more.
 */

/**
 * The commands that act on exactly one Worker, and refuse `input/required` without `--worker` when a project
 * has several and the run cannot ask. Every line that names one names the Worker, by its `apps/` directory.
 */
export const WORKER_SCOPED = [
  "add",
  "dashboard connect",
  "email provision",
  "media provision",
  "payments provision",
  "storage provision",
  "support provision",
  "testers provision",
  "turnstile deprovision",
  "turnstile provision",
  "ui add",
  "ui sync",
  "vector provision",
  "vector reprocess",
  "vector reset",
  "worker sync",
] as const;

/** A command that acts on one Worker. */
export type WorkerScopedPath = (typeof WORKER_SCOPED)[number];

/**
 * The commands that take `--worker` and do not need it: each fans out over every Worker, or falls back to the
 * first that answers, and the flag narrows.
 */
export const WORKER_NARROWS = [
  "contract",
  "dashboard disconnect",
  "dashboard revoke-key",
  "dashboard rotate",
  "dashboard status",
  "doctor",
  "env",
  "init",
  "migrate",
  "seed",
  "support deprovision",
  "upgrade",
] as const;

/**
 * A command only a person runs, at a terminal, where the Worker is asked for. `pithy remove` refuses every run
 * that cannot ask (`core/person_required`).
 */
export const PERSON_ONLY = ["remove"] as const;

/** A flag that turns a Worker-scoped command into one that acts on no Worker: `pithy add --list` reads the catalog. */
export const NO_WORKER_MODES: Readonly<Record<string, readonly string[]>> = { add: ["--list"] };

/**
 * **A flag whose default decides what the command acts on.** Left off a line, the command still runs — on the
 * default, which is rarely the environment the line was about. Every `--env` with a default is one: `dev` for
 * `vector provision`, `migrate` and `testers list`, `staging` for `payments reconcile`. A line names it, always.
 */
export const MEANING_FLAGS = ["--env"] as const;

/**
 * The commands whose `--env` decides nothing until another flag asks it to: `pithy remove` touches no database
 * without `--drop`, and `pithy upgrade` migrates none without `--migrate`. Without that flag a line need not
 * name the environment; with it, it must.
 */
export const MEANING_ONLY_WITH = { remove: "--drop", upgrade: "--migrate" } as const;

/**
 * **The commands that destroy something, by what they destroy.** None is ever built as a remedy: a line that
 * names one says it is a person's decision and what it deletes (`command.ts`'s `personDecision`), and carries
 * no `fix`. `packages/core/src/cli/command.test.ts` holds every command the catalog has to this list or to
 * {@link NOT_DESTRUCTIVE}, so a new one cannot arrive unexamined.
 */
export const DESTRUCTIVE_COMMANDS = {
  "dashboard disconnect": "the environment's dashboard connection and the key it signs with",
  "dashboard revoke-key": "a signing key the dashboard holds",
  "email deprovision": "the email Workers, and with --suppression the suppression database",
  "feature destroy": "the feature's worktree, its branch and every resource it provisioned",
  "media deprovision": "the media Worker, and with --storage its bucket",
  remove: "a capability's wiring",
  "secrets deprovision": "the secrets manager, and with --keys the store's keys",
  "secrets rm": "a stored secret",
  "storage deprovision": "the storage Worker, and with --storage its bucket",
  "support deprovision": "the support Workers, and with --storage its attachments",
  "testers deprovision": "the testers Worker",
  "token revoke": "an API token",
  "turnstile deprovision": "the Turnstile widget, whose sitekey every client embeds",
  "vector reset": "every vector in the index",
  "worker remove": "a Worker's directory",
} as const;

/** A command that destroys something. */
export type DestructivePath = keyof typeof DESTRUCTIVE_COMMANDS;

/**
 * **The flags that make a command destroy something**, on any command that declares them. Each is refused by
 * the builder; a line that needs one is a person's decision.
 */
export const DESTRUCTIVE_FLAGS = {
  "--destroy-retained": "a resource kept for recovery",
  "--drop": "a capability's tables",
  "--redo": "the data a seed wrote",
  "--rollback": "the schema a migration group applied",
} as const;

/** A flag that makes a command destroy something. */
export type DestructiveFlag = keyof typeof DESTRUCTIVE_FLAGS;

/**
 * The commands whose name reads as destructive and which are not, and why. A command named here is built like
 * any other.
 */
export const NOT_DESTRUCTIVE: Readonly<Record<string, string>> = {
  "cloudflare disconnect": "revokes a sign-in and deletes no data, which `cloudflare connect` gives back",
  "docs disconnect": "removes the docs server from an editor's config, which `docs connect` restores",
  "feature prune": "forgets worktrees that are already gone",
  "testers close": "stops a cohort accruing, and keeps its history",
  "testers remove": "takes one tester off a roster, which `testers invite` reverses",
};

/**
 * **A flag whose value is a person's confirmation**, never written into a line an agent reads: a phrase spelled
 * in a remedy is a confirmation nobody gave. A person's decision names the flag and leaves the phrase to them.
 */
export const CONFIRM_FLAGS = ["--confirm", "--confirm-production", "--confirm-reset", "--confirm-rollback"] as const;

/**
 * When a command asks for a confirmation: always, when a flag is passed (`when`), or in every environment but the
 * ones it trusts (`unlessEnv`) — `vector reset` asks nothing of `dev`, whose index is a laptop's.
 */
export const CONFIRMATIONS: readonly { path: string; when?: string; unlessEnv?: readonly string[]; flag: string }[] = [
  { path: "vector reset", unlessEnv: ["dev"], flag: "--confirm-reset" },
  { path: "migrate", when: "--rollback", flag: "--confirm-rollback" },
  { path: "seed", when: "--redo", flag: "--confirm-reset" },
];

/**
 * **A flag whose value is a credential**, never written into a line: an error's action reaches logs, a terminal
 * scrollback and a `--json` consumer, none of which should hold a key. A run named again carries the flag's name
 * and leaves its value to whoever passed it.
 */
export const CREDENTIAL_FLAGS = [
  "--api-token",
  "--r2-access-key-id",
  "--r2-api-token",
  "--r2-secret-access-key",
] as const;

/**
 * The environments every project treats as production. A project can name more in `seed.productionEnvironments`;
 * a builder that has them passes them.
 */
export const PRODUCTION_ENVIRONMENTS = ["prod", "production"] as const;

/**
 * **What a production run of a command needs from a person**, by command: the confirmation it asks for, or `null`
 * for one that asks none. A production provision or seed is never a remedy — a line names it as a person's
 * decision either way, and names a confirmation only when the command declares it: `testers provision` and
 * `vector provision` take no `--confirm`, and a line that told a person to pass one would be refused.
 */
export const PRODUCTION_CONFIRMS = {
  provision: "--confirm",
  seed: "--confirm-production",
  "secrets provision": null,
  "testers provision": null,
  "vector provision": null,
} as const satisfies Readonly<Record<string, string | null>>;

/** A command whose production run is a person's decision. */
export type ProductionPath = keyof typeof PRODUCTION_CONFIRMS;

/**
 * **A command that acts on every environment when its `--env` is left off (#711)**, production among them. `pithy
 * testers provision` with no `--env` provisions every declared environment, so the bare line touches production as
 * surely as `--env prod` does, and is a person's decision for the same reason. Each declares `--env` with no
 * default; `command.test.ts` holds that against the catalog.
 */
export const EVERY_ENVIRONMENT_WITHOUT_ENV = ["testers provision"] as const satisfies readonly ProductionPath[];

/**
 * **A command that acts on every environment on every run (#711)**, production among them, with no `--env` to narrow
 * it. `pithy secrets provision` deploys each declared environment's manager and mints its store entries, so every line
 * naming it touches production and is a person's decision — never the fix for one binding, one database or one
 * setting. None declares `--env`; `command.test.ts` holds that against the catalog.
 */
export const EVERY_ENVIRONMENT_ALWAYS = ["secrets provision"] as const satisfies readonly ProductionPath[];

/**
 * A flag a command refuses to run without, beside another, that the parser does not enforce. `pithy provision
 * --env <env>` with no `--yes` is refused before it does anything; a dry run needs neither.
 */
export const REQUIRED_BESIDE: readonly { path: string; with: string; needs: string; unless: string }[] = [
  { path: "provision", with: "--env", needs: "--yes", unless: "--dry-run" },
];
