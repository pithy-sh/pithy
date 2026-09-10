// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  assembleSecretValue,
  fieldKey,
  promptedFields,
  type SecretPromptField,
  secretPromptPlan,
  unaskableSecretFields,
} from "@pithy-sh/secrets/src/cli/promptPlan";
import { SecretInvalidValueError } from "@pithy-sh/secrets/src/error/errors";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";

/**
 * **Where a secret's value comes from — piped, or asked for one field at a time.**
 *
 * Two paths, and the split is the one CLAUDE.md draws for every command: an agent or a CI job pipes a
 * whole document and gets today's behavior byte for byte, and a human on a terminal is asked
 * questions. Per-field prompting is the interactive path *only* (#516), because the non-interactive
 * one is a contract other programs are already written against.
 *
 * **Which path is two questions, and one boolean cannot hold both.** *Is a document being piped to me?*
 * is answered by **stdin**, and by nothing else — an agent pipes a document with `--json` and without it,
 * into a terminal and into a file. *May I render interactive UI?* is answered by **stdout and `--json`** —
 * a masked prompt has to be drawn somewhere a human can see, and a machine-readable run has a caller
 * parsing one line rather than answering questions. A single `interactive` flag standing for both is the
 * regression this file was landed with: `pithy secrets create X --json` on a terminal, and any run with
 * output redirected to a file, both came out `interactive: false` and were read as *a document is being
 * piped* — so the command silently read the operator's terminal, unmasked and unprompted, for a
 * credential. Hence {@link ReadSecretValueOptions.canPrompt} names one question and
 * {@link ReadSecretValueOptions.stdin}'s own `isTTY` answers the other, at the stream the document would
 * actually arrive on. Neither is derivable from the other, which is what stops them being re-merged.
 *
 * **No value reaches a flag, a positional, or an environment variable**, on either path and for every
 * field. That rule predates this file — a secret in argv is a secret in shell history and in every
 * process listing on the box — and asking for six fields instead of one does not weaken it.
 *
 * The prompts arrive through a seam so the rules above are testable without a terminal, in the same
 * shape `commands/init.ts` already uses for its `@clack/prompts` calls.
 */

/** One option in the branch checkbox — a payment rail, a Turnstile widget. */
export interface SecretBranchOption {
  /** The branch key, which is what comes back when it is chosen. */
  value: string;
  /** What the operator reads: the key itself, since renaming it would be inventing a label. */
  label: string;
  /** The branch's `.describe()`, shown beside the label. */
  hint: string;
}

/**
 * The interactive seam. Every leaf is a {@link SecretPrompter.password}, with no per-field
 * distinction: these values arrive by paste, so masking costs an operator nothing they were going to
 * use, and a field wrongly treated as public is a credential in a screen share (#516). `null` is the
 * operator canceling — never an empty answer, which is a real answer meaning *I have none*.
 */
export interface SecretPrompter {
  /** One masked field. `null` when canceled. */
  password(message: string): Promise<string | null>;
  /** Choose which branches to write. `null` when canceled; at least one must be chosen. */
  choose(message: string, options: readonly SecretBranchOption[]): Promise<string[] | null>;
  /** A line of context — a branch heading, or what an update is about to replace. */
  note(line: string): void;
}

/**
 * The stream a piped document would arrive on — the process's stdin, or a fake in a test.
 *
 * **`isTTY` is the whole of what says whether a document is coming**, and it belongs on the stream
 * rather than in a flag beside it: the question is about this stream and no other, so there is nowhere
 * for a caller to answer it inconsistently. Node sets it to `true` on a terminal and leaves it
 * `undefined` on a pipe, a file, or a closed descriptor — so *absent* means *readable*, which is also
 * what makes a plain async iterable in a test the piped case with nothing to declare.
 */
export type SecretValueStdin = AsyncIterable<Buffer | string> & { readonly isTTY?: boolean | undefined };

/** What {@link readSecretValue} needs to decide how to ask. */
export interface ReadSecretValueOptions {
  /** The secret's registry name — the whole of what today's single prompt can say about it. */
  name: string;
  /** Its registry entry, when it has one. Absent means fall back: an undeclared name is refused later. */
  entry?: SecretRegistryEntry | undefined;
  /** Which branches of it this project configured, from the composed capabilities. */
  branches?: readonly string[] | undefined;
  /** Whether an update is being written — an update replaces the whole secret, which the operator is told. */
  mode: "create" | "update";
  /**
   * **May interactive UI be rendered?** `!--json && process.stdout.isTTY`, and nothing about stdin: a
   * prompt is drawn on stdout, and `--json` promises a caller one parseable line. It is never *is there
   * a document* — that is {@link stdin}'s `isTTY`, and conflating the two is what made a redirected
   * stdout read a credential off the operator's terminal in silence.
   */
  canPrompt: boolean;
  /** Where a piped document would arrive, and — through its `isTTY` — whether one is coming at all. */
  stdin: SecretValueStdin;
  /** The prompts. Defaults to `@clack/prompts`. */
  prompter?: SecretPrompter;
}

/** The real prompts. Imported lazily, as every other `@clack/prompts` use in this CLI is. */
async function clackPrompter(): Promise<SecretPrompter> {
  const { isCancel, log, multiselect, password } = await import("@clack/prompts");
  return {
    password: async (message) => {
      const answer = await password({ message });
      return isCancel(answer) ? null : answer;
    },
    choose: async (message, options) => {
      const answer = await multiselect({
        message,
        options: [...options],
        // Everything offered has been configured, so everything offered is the expected answer — and on
        // an update it is also the safe one, since an unchosen branch is dropped from the secret.
        initialValues: options.map((option) => option.value),
        required: true,
      });
      return isCancel(answer) ? null : (answer as string[]);
    },
    note: (line) => log.info(line),
  };
}

/** Is a document on its way in? Only the stream can say, and `undefined` — a pipe, a file — means yes. */
function documentIsPiped(stdin: SecretValueStdin): boolean {
  return stdin.isTTY !== true;
}

/**
 * **A command that cannot ask and has nothing to read says so.**
 *
 * The third state, and the one that used to be silent. stdin is a terminal, so there is no document; UI
 * cannot be drawn, so there is no question to ask. Reading the terminal anyway is an unmasked,
 * unannounced prompt for a credential — the operator sees a hung process and types into it, or `--json`
 * takes whatever arrived before EOF. Neither is a value anyone chose, so neither is written.
 *
 * The action names the one way in that works from here, which is the same way CI and agents already
 * supply a value. `--env` is deliberately not in it: this refusal does not know the flags the command was
 * given, and a remedy that drops one an operator typed is worse than one that shows the shape.
 */
function refuseWithNoWayToAsk(options: ReadSecretValueOptions): never {
  throw new ValidationError({
    message: `No value was piped for '${options.name}', and this run cannot prompt for one — stdout is not a terminal, or --json was passed.`,
    action: `Pipe the value in: printf '%s' "$VALUE" | pithy secrets ${options.mode} ${options.name}`,
    detail: `readSecretValue('${options.name}'): stdin is a TTY and canPrompt is false (--json, or stdout is not a terminal)`,
  });
}

/** The whole of stdin, with one trailing newline removed — the shape a `heredoc` and a pipe both produce. */
async function readPipedValue(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
}

/** How one field is asked: its path, then the words the schema documents it with. */
function fieldMessage(field: SecretPromptField): string {
  return `${fieldKey(field)} — ${field.description}`;
}

/**
 * A PEM's delimiter lines — the two lines a truncated paste of one actually leaves behind.
 *
 * **Both, because which one survives depends on the terminal.** Measured against the real
 * `@clack/prompts` `password()` under a real pty (`secretPrompt.pty.test.ts`): a CR-delimited paste
 * submits at the first line and the answer is `-----BEGIN…`, an LF-delimited one clears the buffer at
 * every newline and the answer is `-----END…`. Watching for the header alone caught one of the two.
 */
const PEM_DELIMITERS = ["-----BEGIN", "-----END"];

/**
 * **The last-resort trap, and what it can and cannot catch — measured, not assumed.**
 *
 * The defense is the declaration: every string leaf of a `json` secret says whether it fits on a line
 * (`@pithy-sh/secrets/src/cli/promptPlan`), a leaf that says *multi* or says nothing is never asked for
 * one line at a time, and `packages/cli/src/ci/secretFieldLines.test.ts` fails any leaf in the
 * repository that has not said. This catches the remaining case: a leaf marked single-line **wrongly**,
 * where the operator pastes a PEM into it anyway.
 *
 * **What used to be here and is now deleted: a check for a newline in the answer.** It could never fire.
 * A masked prompt does not return the newline it submits at — the pty measurements are in
 * `secretPrompt.pty.test.ts` and none of them yields an answer containing `\r` or `\n` — so the arm read
 * as a backstop for the unmarked field and was one for nothing at all, which is worse than no arm,
 * because the polarity of the marker was justified by it for two rounds.
 *
 * A delimiter line is a real, reachable, discriminating signal: it is what a truncated PEM leaves in the
 * answer, and no credential *is* one. It refuses only — a false refusal costs an operator one pipe, a
 * false accept costs them a credential they will believe they wrote — and it is not a substitute for the
 * declaration, because the body line of a paste that lost both delimiters looks like any other secret.
 */
function refuseTruncatedPaste(field: SecretPromptField, answer: string, options: ReadSecretValueOptions): void {
  // **Trimmed first, because an indented PEM is still a PEM.** Measured under the real pty with both a
  // P-256 and a 4096-bit RSA key: a document pasted with leading whitespace — a PEM copied out of a YAML
  // block, an indented heredoc, anything a formatter touched — arrives as `'  -----BEGIN PRIVATE KEY-----'`
  // and `startsWith` said no. The signal is the delimiter line, not its column, and the trap is the one
  // arm standing between a mismarked field and a credential the operator will believe they wrote.
  //
  // Only the match is trimmed. The answer itself is untouched and goes to `validateSecretValue` exactly as
  // it was typed — a refusal is all this does, and a trap that quietly edited a value would be a second
  // writer beside the schema.
  const delimited = answer.trimStart();
  if (!PEM_DELIMITERS.some((delimiter) => delimited.startsWith(delimiter))) return;
  throw new SecretInvalidValueError({
    // The field's name, never a character of its value.
    message: `The answer for ${fieldKey(field)} is one line of a PEM, and a masked prompt reads one line — the rest of the paste was dropped.`,
    action: `Pipe the whole document instead: printf '%s' "$JSON" | pithy secrets ${options.mode} ${options.name}`,
    detail: `${fieldKey(field)} of '${options.name}' was answered with a PEM delimiter line at a single-line prompt`,
  });
}

/**
 * The value to write, or `null` when the operator canceled.
 *
 * Piped: the document, unchanged. Interactive: a single masked prompt, unless the entry is a `json`
 * secret whose schema plans into questions — then one masked prompt per field, and a checkbox first
 * when the project configured more than one block.
 *
 * **The order of the two questions is the fix.** *Is a document piped* is asked first and answered by
 * stdin alone, so the agent path is reached identically under `--json`, under a redirected stdout, and
 * under neither. Only then does *may I draw a prompt* decide between asking and refusing.
 *
 * **Nothing here validates a field.** What the answers assemble into goes to `validateSecretValue`
 * through the same call as any other value, so there is one parse gate and it is the schema's.
 */
export async function readSecretValue(options: ReadSecretValueOptions): Promise<string | null> {
  if (documentIsPiped(options.stdin)) return readPipedValue(options.stdin);
  if (!options.canPrompt) refuseWithNoWayToAsk(options);
  const prompter = options.prompter ?? (await clackPrompter());
  const plan = options.entry ? secretPromptPlan(options.entry, options.branches) : null;
  if (!plan) {
    // A fallback with a reason. Every other refusal is about a shape an operator can see in the schema;
    // what a field says about spanning lines is not, and the same operator has just watched a different
    // secret ask six questions. Named, so the inconsistency reads as a rule rather than a fault — and
    // both reasons are said, because an adopter's own registry can hold a field that never said.
    const unaskable = options.entry ? unaskableSecretFields(options.entry, options.branches) : [];
    if (unaskable.length > 0) {
      const reasons = unaskable.map((field) => `${field.key} ${field.reason}`).join("; ");
      prompter.note(`${reasons} — so this secret is asked for as one JSON document.`);
    }
    return prompter.password(`Value for '${options.name}'`);
  }

  // **An update rewrites the whole secret, and it is said every time.** The CLI cannot read the current
  // value to say what is in it — the manager Worker seals it under a master key and the read seam answers
  // a bit, never a value — so the only honest thing it can do is state the consequence, and the
  // consequence does not depend on how many blocks got a checkbox. It was said only in the multi-block
  // case until this note moved: a project that has switched a rail off has one block left, gets no
  // checkbox, and its stored credentials for the retired rail are dropped by the write that follows.
  // That is the case that most needed telling and was the one case not told.
  if (options.mode === "update") {
    prompter.note(
      plan.branches.length > 0
        ? "An update replaces the whole secret. Any block you are not asked for — including one for something this project has since switched off — is dropped. Pipe the whole document to keep it."
        : "An update replaces the whole secret. Anything you leave empty is dropped.",
    );
  }

  let chosen: string[] = plan.branches.map((branch) => branch.key);
  if (plan.branches.length > 1) {
    const answer = await prompter.choose(
      "Which would you like to create or update?",
      plan.branches.map((branch) => ({ value: branch.key, label: branch.key, hint: branch.description })),
    );
    if (answer === null) return null;
    chosen = answer;
  } else if (plan.branches.length === 1) {
    // One configured block is not a question. It is named, and then asked for.
    for (const branch of plan.branches) prompter.note(`${branch.key} — ${branch.description}`);
  }

  const answers: Record<string, string> = {};
  for (const field of promptedFields(plan, chosen)) {
    const answer = await prompter.password(fieldMessage(field));
    if (answer === null) return null;
    refuseTruncatedPaste(field, answer, options);
    answers[fieldKey(field)] = answer;
  }
  return assembleSecretValue(plan, chosen, answers);
}
