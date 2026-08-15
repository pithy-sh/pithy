// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename, join, resolve } from "node:path";
import { type CfAccount, listCloudflareAccounts } from "@pithy-sh/cloudflare/src/client/accounts";
import { DEFAULT_ENVIRONMENTS, DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { kebab } from "@pithy-sh/core/src/naming/resource";
import { PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { defineCommand } from "citty";
import {
  CloudflareAccountName,
  type CloudflareConfigOptions,
  cloudflareAccountFile,
  cloudflareConfigPath,
  resolveCloudflare,
  writeCloudflareConfig,
} from "../cloudflare/config";
import { stateDir } from "../notifier/state";
import { askDomains, writeDomains } from "../project/askDomains";
import { writeFileAtomic } from "../project/atomic";
import { renderDomainsBlock } from "../project/domainPrompt";
import { readOptionalFile } from "../project/readOptionalFile";
import { DEFAULT_WORKER, ensureScaffoldable, kitRange, scaffoldProject } from "../project/scaffold";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { dim } from "../terminal/style";
import { installAlias } from "./alias";

/**
 * Offer the `p.` shortcut once, right after scaffolding (docs/CLI.md §2.7). Interactive only — a `--json`
 * or non-TTY run never prompts. Asked at most once per project because a second `pithy init` in the same
 * directory never reaches this line — it collides on the files the first one wrote — so there is no
 * "asked before" flag to persist. On yes, the alias installs silently (its own Added/Reload lines are
 * the only output).
 */
async function offerAlias(): Promise<void> {
  const { isCancel, confirm } = await import("@clack/prompts");
  const wants = await confirm({ message: "Want a shortcut? Type `p.` instead of `pithy`." });
  if (!isCancel(wants) && wants) await installAlias({ silent: true });
}

/** Whether a human is attached — the only condition under which `init` prompts for anything. */
function interactive(json: boolean): boolean {
  return !json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/**
 * Ask one question, falling back to `fallback` when there is nobody to ask. A cancel aborts the whole
 * run rather than proceeding on a value the user did not choose.
 */
async function ask(message: string, fallback: string, json: boolean): Promise<{ value: string; prompted: boolean }> {
  if (!interactive(json)) return { value: fallback, prompted: false };
  const { isCancel, text } = await import("@clack/prompts");
  const answer = await text({ message, defaultValue: fallback, placeholder: fallback });
  if (isCancel(answer)) {
    process.stderr.write("Cancelled.\n");
    process.exit(1);
  }
  return { value: answer, prompted: true };
}

/**
 * The prompts `init` asks, as a seam.
 *
 * `@clack/prompts` needs a TTY, and the account flow below is the part of `init` most worth testing:
 * it lists accounts, slugifies a free-text name into something that becomes a *file name*, and decides
 * what goes into the repository. A suite that could only reach it through a terminal would not reach it.
 */
export interface InitPrompt {
  text(options: { message: string; defaultValue?: string; placeholder?: string }): Promise<string | symbol>;
  password(options: { message: string }): Promise<string | symbol>;
  select(options: { message: string; options: { value: string; label: string }[] }): Promise<string | symbol>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
  isCancel(value: unknown): boolean;
}

/** The real prompts. Imported lazily, as every other `@clack/prompts` use here is. */
async function clackPrompt(): Promise<InitPrompt> {
  const clack = await import("@clack/prompts");
  return {
    text: (options) => clack.text(options),
    password: (options) => clack.password(options),
    select: (options) => clack.select(options) as Promise<string | symbol>,
    confirm: (options) => clack.confirm(options),
    isCancel: (value) => clack.isCancel(value as never),
  };
}

/** What {@link askEnvironments} decided. */
export interface EnvironmentsAnswer {
  /** The environments the project has. Always valid, always at least one. */
  environments: DeclaredEnvironments;
  /** Whether anything was actually asked. */
  prompted: boolean;
  /** Whether the answer differs from the default — the only case that writes a line into the config. */
  declared: boolean;
}

/** What {@link askEnvironments} needs. Both seams default to the real prompts and stderr. */
export interface AskEnvironmentsOptions {
  /** Whether a human is attached. False asks nothing and takes the default. */
  interactive: boolean;
  /** Seam: the prompts. Defaults to `@clack/prompts`. */
  prompt?: InitPrompt;
  /** Seam: where a re-ask explains itself. Defaults to stdout. */
  note?: (line: string) => void;
}

/** How a typed answer is split: commas, whitespace, or both. `staging,prod` and `staging, prod` are one answer. */
function parseEnvironments(answer: string): string[] {
  return answer
    .split(/[,\s]+/)
    .map((environment) => environment.trim())
    .filter((environment) => environment.length > 0);
}

/**
 * Ask which environments this project has (#241).
 *
 * **Asked here for the same reason `name` is.** `<project>-<env>-<thing>` has a 33-character ceiling;
 * `name` is capped at 26 and asked at `init` because a provisioned project cannot be renamed. The
 * environment sits in the middle of that same name, is measured against the same ceiling, and was asked
 * about nowhere — it was scaffolded from a template and then contradicted by a closed enum in one place
 * and an open policy field in another. One of the two segments was a decision; the other was an accident.
 *
 * **One keypress for the common case.** The default is offered as the placeholder, so an adopter who has
 * never thought about this presses enter and gets exactly what the scaffold always wrote — and no
 * `environments` line in their config, because a declaration that repeats the default teaches nothing.
 *
 * **An illegal answer is re-asked, not accepted.** `dev` is the one people try, and it is the one that
 * has to be refused: it is local, always present, and never deployed. Three attempts, then the default —
 * a scaffold that cannot be completed is worse than one on the default set.
 *
 * **Skipped when nobody is at a terminal**, exactly as the account and domain questions are. CI scaffolds
 * projects, there is nobody to ask, and the default is what the template already held.
 */
export async function askEnvironments(options: AskEnvironmentsOptions): Promise<EnvironmentsAnswer> {
  const fallback: EnvironmentsAnswer = {
    environments: [...DEFAULT_ENVIRONMENTS],
    prompted: false,
    declared: false,
  };
  if (!options.interactive) return fallback;

  const prompt = options.prompt ?? (await clackPrompt());
  const note = options.note ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const offered = DEFAULT_ENVIRONMENTS.join(", ");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = asString(
      await prompt.text({
        message: "Environments this project deploys to:",
        defaultValue: offered,
        placeholder: offered,
      }),
      prompt,
    );
    // Cancelled. The default is the honest fallback: it is what the template holds, and it is what a
    // non-interactive run gets, so nothing is scaffolded that an unanswered question decided.
    if (answer === null) return { ...fallback, prompted: true };

    const parsed = DeclaredEnvironments.safeParse(parseEnvironments(answer));
    if (parsed.success) {
      const declared = parsed.data.join(", ") !== offered;
      return { environments: parsed.data, prompted: true, declared };
    }
    // The schema's own sentences — `dev` gets the reason it is not declarable, an over-long name gets the
    // number. Re-asked rather than refused, because this is a prompt and the adopter is still here.
    for (const issue of parsed.error.issues) note(issue.message);
  }
  return { ...fallback, prompted: true };
}

/** The `cloudflare` block `init` writes into the root config, or `null` when it discovered nothing. */
export interface CloudflareBlock {
  /** The nickname selecting `<config>/cloudflare.<name>.json`. Always a validated bare token. */
  accountName?: string;
  /** The pin — written by default, declinable. Always the id read from the account, never one typed. */
  accountId?: string;
}

/** What {@link askCloudflareAccount} decided. */
export interface CloudflareAccountAnswer {
  /** The block to write into `pithy.config.ts`, or `null` when nothing named an account. */
  block: CloudflareBlock | null;
  /** Lines to print. Paths and names only — never a token. */
  notes: string[];
  /** Whether anything was actually asked. */
  prompted: boolean;
}

/** What {@link askCloudflareAccount} needs. Both seams default to the real account and the real prompts. */
export interface AskCloudflareAccountOptions {
  /** Whether a human is attached. False asks nothing and writes nothing. */
  interactive: boolean;
  /** Where the config directory is, and which account inside it. Defaults to the real one. */
  paths?: CloudflareConfigOptions;
  /** Seam: the accounts a token can see. Defaults to the real REST call. */
  listAccounts?: (apiToken: string) => Promise<CfAccount[]>;
  /** Seam: the prompts. Defaults to `@clack/prompts`. */
  prompt?: InitPrompt;
}

/**
 * Record the Cloudflare credentials and discover which account they belong to.
 *
 * **This is the one moment the operator is holding the token**, which is the whole reason it belongs in
 * `init`: the token is needed to list zones two prompts later, and every command after this needs it.
 * The credentials are account-scoped, so they are written to `<config>/cloudflare.json` — or, once an
 * account has a name, `<config>/cloudflare.<name>.json` — outside every checkout, `0600`, in the `0700`
 * config directory (#182, #206). Nothing minted or typed here goes into the project except the account's
 * *name* and *id*, and neither of those is a secret.
 *
 * **The account is discovered, not asked for.** `init` used to take an account id on trust: pasted,
 * unverified, and wrong often enough that a token for one account against another account's id is a
 * documented failure mode. The token can list the accounts it can see, so it is asked — one account is a
 * confirmation, several are a picker, and choosing the account *is* choosing the nickname. A narrowly
 * scoped token that cannot list falls back to asking for the id, exactly as before, and `init` completes.
 *
 * **A slugified Cloudflare name goes through the same schema as a typed one.** Account names are free
 * text (`Leed, Inc.`), and the result becomes a file name — so there is one validation, not two, or the
 * rule would only be true of one of the ways a name arrives. A name that slugifies to nothing is asked
 * for rather than guessed at.
 *
 * **Skipped when nobody is at a terminal**, for the same reason every other prompt here is: CI scaffolds
 * projects and there is nobody to ask, so it writes no `cloudflare` block and resolves `cloudflare.json`
 * exactly as it always has. Skipped, too, when the credentials already resolve *and* the token sees one
 * account — that is the single-account machine, and it has nothing to be asked about.
 */
export async function askCloudflareAccount(options: AskCloudflareAccountOptions): Promise<CloudflareAccountAnswer> {
  const nothing: CloudflareAccountAnswer = { block: null, notes: [], prompted: false };
  if (!options.interactive) return nothing;

  const paths = options.paths ?? { account: null };
  const listAccounts = options.listAccounts ?? ((apiToken: string) => listCloudflareAccounts({ apiToken }));
  const prompt = options.prompt ?? (await clackPrompt());
  const existing = resolveCloudflare(paths).vars;
  const configured = Boolean(existing.CLOUDFLARE_ACCOUNT_ID && existing.CLOUDFLARE_API_TOKEN);

  if (!configured) {
    process.stdout.write(
      `${dim("Cloudflare credentials are per account, not per project — one set for every project on that account.")}\n${dim(`They are kept under ${stateDir(paths)}, never in this repository.`)}\n${dim("Press enter to skip; pithy doctor names them until they are set.")}\n\n`,
    );
  }

  // The token first, because it is what the account listing needs. An already-resolving one is reused:
  // nothing asks for a credential the machine already holds.
  const apiToken =
    existing.CLOUDFLARE_API_TOKEN ?? asString(await prompt.password({ message: "Cloudflare API token:" }), prompt);
  // Cancelled, or skipped with an empty answer. Both are legitimate: a project scaffolded before the
  // account exists is an ordinary thing to do, and `pithy doctor` names the missing keys until they are set.
  if (!apiToken) return nothing;

  // Never fatal, and no longer one fact (#378). `null` is "could not ask" — an unreachable network, a
  // token without `account:read`, a revoked token; `[]` is "this token sees no account". Collapsing them
  // into `[]` is the origin of every confidently-empty listing downstream: the operator then types an id
  // nothing verified, and it becomes the `CLOUDFLARE_ACCOUNT_ID` every later command asks about.
  const accounts = await listAccounts(apiToken).catch(() => null);

  // A configured machine whose token sees one account is the single-account case #182 was written for.
  // It has nothing to choose, so it is not asked — this is the run that must stay exactly as it was.
  if (configured && accounts !== null && accounts.length <= 1) return nothing;

  if (accounts === null || accounts.length === 0) {
    return await askAccountIdOnly({ apiToken, existing, paths, prompt, reachable: accounts !== null });
  }

  const chosen = await chooseAccount(accounts, prompt);
  if (chosen === null) return nothing;

  const named = await askAccountName(chosen, prompt);
  if (named === null) return nothing;

  const pin = await prompt.confirm({
    message: `Pin account ${chosen.id} in pithy.config.ts? It is an identifier, not a secret, and it is what stops another machine's "${named.accountName}" from meaning a different account.`,
    initialValue: true,
  });
  const pinned = !prompt.isCancel(pin) && pin === true;

  const account = { accountName: named.accountName };
  await writeCloudflareConfig(
    { CLOUDFLARE_ACCOUNT_ID: chosen.id, CLOUDFLARE_API_TOKEN: apiToken },
    { ...paths, account },
  );

  return {
    // The path and the account's name, never a value. A token echoed into a terminal is a token in a
    // scrollback and a CI log.
    notes: [...named.notes, `Recorded ${chosen.name}'s credentials in ${cloudflareConfigPath({ ...paths, account })}.`],
    block: { accountName: named.accountName, ...(pinned ? { accountId: chosen.id } : {}) },
    prompted: true,
  };
}

/**
 * The fallback: no picker, so ask for an id exactly as `init` always asked — and say why there was none.
 *
 * **The two reasons are not one reason (#378).** A token that reached Cloudflare and was shown no account
 * is a scoping problem the operator can fix; a call that never landed says nothing about the account at
 * all. Both used to print the same bare prompt, and the id typed under either of them became the pin
 * every later listing is compared against. Naming which one happened is the difference between "widen the
 * token" and "check the network", and it is the last moment anyone is looking.
 */
async function askAccountIdOnly(context: {
  apiToken: string;
  existing: Record<string, string>;
  paths: CloudflareConfigOptions;
  prompt: InitPrompt;
  /** Whether the account listing was actually answered. `false` is "could not ask", never "sees none". */
  reachable: boolean;
}): Promise<CloudflareAccountAnswer> {
  const { apiToken, existing, paths, prompt, reachable } = context;
  process.stdout.write(
    `${dim(
      reachable
        ? "This token sees no Cloudflare account, so there is nothing to pick from. Widen it to account:read, or paste the id."
        : "Cloudflare could not be reached, so the account list is unknown. The id below is recorded as typed and verified by nothing.",
    )}\n`,
  );
  const accountId =
    existing.CLOUDFLARE_ACCOUNT_ID ??
    asString(await prompt.text({ message: "Cloudflare account id:", defaultValue: "" }), prompt);
  if (accountId === null) return { block: null, notes: [], prompted: true };

  const written = await writeCloudflareConfig(
    { ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}), CLOUDFLARE_API_TOKEN: apiToken },
    { ...paths, account: null },
  );
  return {
    // No block: nothing discovered a name, and inventing one at a prompt is the guess this replaced.
    block: null,
    notes: [
      `Recorded ${Object.keys(written).sort().join(" and ")} in ${cloudflareConfigPath({ ...paths, account: null })}.`,
    ],
    prompted: true,
  };
}

/** One account, confirmed or picked. Choosing the account is what supplies both the id and the name. */
async function chooseAccount(accounts: CfAccount[], prompt: InitPrompt): Promise<CfAccount | null> {
  const only = accounts[0];
  if (accounts.length === 1 && only) return only;
  const choice = await prompt.select({
    message: "Which Cloudflare account is this project for?",
    options: accounts.map((account) => ({ value: account.id, label: `${account.name} (${account.id})` })),
  });
  if (prompt.isCancel(choice)) return null;
  return accounts.find((account) => account.id === choice) ?? null;
}

/**
 * The nickname for the account's credentials file, offered as the account's own slugified name.
 *
 * The slug and the typed answer go through {@link CloudflareAccountName} at the same line — that is the
 * point. `kebab` is core's, the same normalizer every project name goes through, so `Leed, Inc.` offers
 * `leed-inc`; a name that slugifies to nothing offers nothing and asks.
 */
async function askAccountName(
  account: CfAccount,
  prompt: InitPrompt,
): Promise<{ accountName: string; notes: string[] } | null> {
  const suggestion = kebab(account.name);
  const notes: string[] = [];
  const defaultValue = CloudflareAccountName.safeParse(suggestion).success ? suggestion : "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = asString(
      await prompt.text({
        // The account is named in the question, so a single-account run confirms *which* account it
        // used in the same keypress that accepts the nickname — nothing is chosen silently.
        message: `Credentials file for ${account.name} (${account.id}) — <config>/cloudflare.<name>.json. Name:`,
        defaultValue,
        placeholder: defaultValue,
      }),
      prompt,
    );
    if (answer === null) return null;
    const parsed = CloudflareAccountName.safeParse(answer.trim());
    if (parsed.success) return { accountName: parsed.data, notes };
    notes.push(`"${answer.trim()}" is not a bare token — lowercase letters, digits, and single hyphens.`);
    process.stdout.write(`${notes[notes.length - 1]}\n`);
  }
  return null;
}

/** A prompt's answer as a string, or `null` when the operator cancelled. */
function asString(value: string | symbol, prompt: InitPrompt): string | null {
  if (prompt.isCancel(value)) return null;
  return typeof value === "string" ? value : null;
}

/** The `cloudflare` block, as an adopter would write it by hand. */
export function renderCloudflareBlock(block: CloudflareBlock): string {
  const lines = [
    "  // Which Cloudflare account this project belongs to. `accountName` selects",
    "  // <config>/cloudflare.<name>.json; `accountId` pins the account those credentials",
    "  // must belong to. An account id is an identifier, not a secret.",
    "  cloudflare: {",
    ...(block.accountName ? [`    accountName: ${JSON.stringify(block.accountName)},`] : []),
    ...(block.accountId ? [`    accountId: ${JSON.stringify(block.accountId)},`] : []),
    "  },",
  ];
  return `${lines.join("\n")}\n`;
}

/** Where the block is spliced into the scaffolded config: immediately inside the object it exports. */
const CONFIG_OPEN = "const config = {\n";

/**
 * Write the `cloudflare` block into the scaffolded root `pithy.config.ts`.
 *
 * **The name is validated again on the way in.** It has already been through
 * {@link CloudflareAccountName} at the prompt, and it goes through it here too, because this is the
 * function that puts it in a file every later command builds a path from.
 *
 * A config this cannot place the block in is reported rather than rewritten — `init` prints the block
 * for the adopter to paste, the same way an unplaceable `domains` declaration is handled. Guessing at
 * the shape of a file somebody may have already edited is how a scaffold eats an edit.
 */
export async function writeCloudflareBlock(projectDir: string, block: CloudflareBlock): Promise<{ declared: boolean }> {
  if (block.accountName !== undefined) cloudflareAccountFile(block.accountName);
  const path = join(projectDir, "pithy.config.ts");
  const source = await readOptionalFile(path);
  if (source === null || !source.includes(CONFIG_OPEN)) return { declared: false };
  const at = source.indexOf(CONFIG_OPEN) + CONFIG_OPEN.length;
  await writeFileAtomic(path, `${source.slice(0, at)}${renderCloudflareBlock(block)}\n${source.slice(at)}`);
  return { declared: true };
}

export default defineCommand({
  meta: { name: "init", description: "Scaffold a new project" },
  args: {
    name: { type: "string", description: "Application name. Defaults to the directory name." },
    worker: {
      type: "string",
      description: `Name of the first worker, created at apps/<name>. Defaults to "${DEFAULT_WORKER}".`,
    },
    dir: {
      type: "string",
      default: ".",
      description: "Target directory. Created if missing; must not already hold the files init writes.",
    },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const targetDir = resolve(process.cwd(), args.dir);
      // Gate on the target before prompting — a doomed run fails fast, not after
      // the user answers (scaffoldProject re-checks, so the guard still holds).
      // `--worker` is passed when given: it decides which `apps/<name>` the scaffold lands at, and so
      // what counts as a collision. A prompted worker name is only known later, and the re-check covers
      // it. `ensureScaffoldable` validates the name before it builds a path out of it.
      await ensureScaffoldable(targetDir, args.worker);

      // Said before the question, not after it. The name leads every Cloudflare resource this project
      // provisions (docs/NAMING.md), teardown recomputes those names rather than storing them, and the
      // scope decision behind it — one project or two — cannot be undone by editing a string later.
      if (!args.name && interactive(args.json)) {
        process.stdout.write(
          `${dim("One project per set of apps that share users or data. Another app? Add a worker, not a project.")}\n${dim("The name leads every Cloudflare resource this project provisions. Changing it later orphans them.")}\n\n`,
        );
      }
      const name = args.name
        ? { value: args.name, prompted: false }
        : await ask("Project name:", basename(targetDir), args.json);
      // Every worker lives in apps/<name>, so the first one is named too. `api` is the default because
      // this scaffold is a backend — a project that wants `web`, `edge`, or `admin` says so here.
      const worker = args.worker
        ? { value: args.worker, prompted: false }
        : await ask("First worker (apps/<name>):", DEFAULT_WORKER, args.json);

      // Asked with the two names, before anything is written, because it is the same kind of answer:
      // the environment is the second segment of every Cloudflare name this project will compose, and
      // renaming one after provisioning orphans what was created under the old one. The scaffold writes
      // each Worker's `env.<name>` stanzas from it.
      const environments = await askEnvironments({ interactive: interactive(args.json) });

      const appName = name.value;
      await scaffoldProject({ targetDir, appName, worker: worker.value, environments: environments.environments });

      // Asked before the zones are, because listing them needs the token — and the same token answers
      // which account this project is for, so the two questions collapse into one.
      const account = await askCloudflareAccount({ interactive: interactive(args.json) });
      const credentials = [...account.notes];
      // The block goes into the config the scaffold just wrote, so `loadProject` reads it on the very
      // next command. A config it could not be placed in is printed rather than dropped.
      const declared = account.block ? await writeCloudflareBlock(targetDir, account.block) : null;

      // Where the Worker answers, asked against the account's real zones. Skippable — a project without
      // a domain yet is legitimate, and adding one later is a config edit plus a deploy. Asked after the
      // scaffold exists, because the answer is written into files this just created.
      const asked = await askDomains({
        projectDir: targetDir,
        // The account this run just recorded — the zones offered below belong to it, not to whatever
        // `cloudflare.json` happens to hold on this machine.
        account: account.block,
        workerName: worker.value,
        interactive: interactive(args.json),
      });
      // A declaration the writer could not place must not vanish. `writeDomains` still generates the
      // wrangler values either way, so the Worker routes correctly — but the `domains` block is the
      // source of truth, and an adopter who answered the prompt needs to know it did not land.
      const wrote = asked.domains ? await writeDomains(join(targetDir, "apps", worker.value), asked.domains) : null;
      const prompted = name.prompted || worker.prompted || environments.prompted || asked.prompted || account.prompted;

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "init", targetDir, appName, worker: worker.value, environments: environments.environments, domains: asked.domains ?? null })}\n`,
        );
        return;
      }
      for (const note of credentials) process.stdout.write(`${note}\n`);
      if (declared && !declared.declared && account.block) {
        process.stdout.write(
          `Could not write the cloudflare block into pithy.config.ts. Add it by hand:\n${renderCloudflareBlock(account.block)}`,
        );
      }
      if (wrote && !wrote.declared && asked.domains) {
        process.stdout.write(
          `Could not write the domains block into pithy.config.ts. Add it by hand:\n${renderDomainsBlock(asked.domains)}\n`,
        );
      }
      // The scaffolded worker declares no kit dependency while nothing under `@pithy-sh/*` is published
      // ({@link kitRange}), so say where the kit comes from instead. Unsaid, the adopter meets the gap as
      // an unresolved import at the first typecheck — which is a worse introduction than a sentence here,
      // and the only alternative is the range that 404s their first install.
      if (kitRange(PACKAGE_VERSION) === null) {
        process.stdout.write(
          `${dim("@pithy-sh/* isn't published yet, so this worker declares no kit dependency.")}\n${dim("Link the kit from a checkout, then install.")}\n`,
        );
      }
      // Set Done. off from the prompt's gutter; a flagged run has nothing above it.
      process.stdout.write(`${prompted ? "\n" : ""}${formatDone()}\n`);

      // Offer the shortcut only to a human at a terminal — never in a --json or piped run.
      if (!args.json && process.stdin.isTTY && process.stdout.isTTY) {
        await offerAlias();
      }
    }),
});
