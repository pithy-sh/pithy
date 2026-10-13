// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { commandFaults, isCommandPath, isGroupPath } from "@pithy-sh/core/src/cli/command";
import { COMMANDS, GROUPS } from "@pithy-sh/core/src/cli/commandCatalog.generated";
import { WORKER_SCOPED } from "@pithy-sh/core/src/cli/commandFacts";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { type LiteralSpan, literalSpans } from "@pithy-sh/core/src/text/literals";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { scaffoldProject } from "../project/scaffold";
import { recorder } from "../test-utils/cloudflareRecorder";
import { linkKitPackages } from "../test-utils/linkKit";
import { runCaptured } from "../test-utils/payloadContract";
import { isShippedModule, readSource, sourcePaths } from "./sourceFiles";

/**
 * **No line spells a `pithy` command by hand (#711).**
 *
 * #697 held every `fix` to one rule: it runs as written. The sentences beside it were held to nothing, and three
 * review rounds of #711 each found new ones that a two-Worker project refuses — an `action` that dropped the
 * caller's `--worker`, a skip reason naming `vector provision` with no `--env` so it provisioned `dev`, a doctor
 * line with no `--with-prerequisites`, a placeholder pasted verbatim, `pithy feature destroy` offered for one
 * mis-shaped index. Each round fixed the lines it found and the gate read only the shapes it had been taught,
 * so the next round found more. The fault was never one line: it was that a line could spell a command at all.
 *
 * So every command a line names is built by `@pithy-sh/core/src/cli/command.ts`, which knows the command tree
 * and refuses a command that does not exist, a flag it does not declare, a flag it needs left off, a placeholder,
 * a `--worker` that is not an `apps/` directory, and anything that destroys more than a remedy may. A `pithy add`
 * is built by `capabilities/addCommand.ts`, on top of it, from the capability's manifest.
 *
 * ## What this gate holds
 *
 * - **Every `pithy …` in shipped source, wherever it sits in a sentence**: in every string and template literal
 *   of every package, a `pithy` followed by any word is a citation, unless that word is one prose about Pithy uses
 *   ({@link PROSE_WORDS}, none of them a command) and nothing marks it as a command line — a flag, or code. So a
 *   command the CLI does not have is read too, whatever word comes before it. Each is a fault — it was spelled by hand — and each is
 *   also read against the builder's own rules ({@link commandFaults}), so the report says what is wrong with it.
 *   Help text (`.describe(…)`, `description:`) describes a command rather than telling anyone to run one, and is
 *   not read.
 * - **`.tsx` as well as `.ts`**, read as JSX: an element's text and its attribute strings are literals too.
 * - **A command assembled from pieces** ({@link assembledIn}): a `"pithy"` joined onto a path from an array,
 *   concatenated with `+`, interpolated as a literal, or handed to `execArgs`; and `pithy ${path}`, whose command is
 *   wholly interpolated. No single literal holds the command, so each is read off its surroundings.
 * - **A command finished by hand around the builder** ({@link finishedByHand}): a flag written straight after
 *   `commandName`'s output — in the same template, after the code span closing round it, or joined on by `+` or an
 *   array — which the builder never saw; a `<placeholder>` or a blank spelled as a literal into a builder's parts,
 *   directly or as a `??`, `||` or ternary fallback, which the builder now quotes as a caller's value (it checks
 *   shape, never a value); a name a `"pithy"` was bound to, in any shipped file, with words put after it by a
 *   template or a `+`; and the CLI named by its package or at a version (`npx @pithy-sh/cli upgrade`,
 *   `pithy@latest upgrade`) with a command after it.
 * - **Every rerun is the caller's own context** ({@link callerFaults}): `rerunCommand`, `rerunRemedy` and `addAgain`
 *   take a `Caller` and nothing else — the compiler holds that — and a `Caller` is made by `callerOf` from a run's
 *   own `args`, or in one of {@link CALLER_CONSTRUCTORS}. A cast to one fails here.
 * - **No remedy names `pithy init`** but the lines in {@link INIT_LINES}, each for a directory that is no project.
 * - **`pithy add` is built only by its own builder**, which knows the manifest.
 * - **A command built for a deployed Worker** ({@link RUNTIME_LINES}) is built only in the files listed there,
 *   by reason: a deployed Worker cannot know the `apps/` directory that provisioned it, so it alone may name a
 *   Worker-scoped command without `--worker`. Every other rule holds.
 * - **Every doctor `fix` is a `Command`** — `failures.ts` types it so — and a `Command` is made only by the builder,
 *   so a hand-spelled string does not type-check there. The capability's own settings `fix` is the one exception: it
 *   arrives through `SettingsFinding`'s schema as a string.
 * - **Which commands act on one Worker** is not a belief: each in `WORKER_SCOPED` is run below, without
 *   `--worker`, in a real scaffolded project with two Workers, and must be refused `input/required` naming it.
 *
 * **What it still cannot read — its accepted limits**, stated so nobody takes this gate for more than it is:
 *
 * - words written after a `commandName` held in a variable first (`const name = commandName("x"); \`${name} --env\``),
 *   or joined onto one by anything but `+`, an array's `,` or the template it sits in (`.concat`, a helper);
 * - a positional argument written after `commandName`, which is indistinguishable from the prose that follows it;
 * - a `<placeholder>` that reaches a builder through a name (`const dir = "<worker>"; pithyCommand("ui sync", { flags:
 *   { "--worker": dir } })`), a property or a function's return: only a literal written among the parts is read;
 * - a `"pithy"` reached through anything but a binding — a property, a function argument, a computed string — and the
 *   CLI named by a package spelled any other way than `@pithy-sh/cli` or `pithy@<version>`;
 * - a `callerOf` handed a run's `args` that the command first rewrote (`args.worker = "x"`), or a value named `args`
 *   that is not the parser's: the gate reads the name, not where the value came from;
 * - every sentence-shaped field (`action`, a note, a next step's `command`, which carries package-manager lines too),
 *   which stays a `string`: only `fix` is branded.
 */

/** The repository's `packages/`. Every package's `src/` is read. */
const PACKAGES = resolve(import.meta.dirname, "../../..");

/** The one module that spells a command line. */
const BUILDER = "core/src/cli/command.ts";

/** The one module that builds a `pithy add`. */
const ADD_BUILDER = "cli/src/capabilities/addCommand.ts";

/**
 * What each scoped command needs on its line to get as far as asking which Worker: the arguments every
 * earlier refusal wants answered. None of them is `--worker`, which is the point.
 */
const REACH: Readonly<Record<string, readonly string[]>> = {
  add: ["vector"],
  "dashboard connect": ["--env", "staging"],
  "email provision": [],
  "media provision": ["--r2-access-key-id", "id", "--r2-secret-access-key", "secret"],
  "payments provision": [],
  "storage provision": ["--r2-access-key-id", "id", "--r2-secret-access-key", "secret"],
  "support provision": [],
  "testers provision": [],
  "turnstile deprovision": [],
  "turnstile provision": [],
  "ui add": ["react"],
  "ui sync": [],
  "vector provision": ["--env", "staging"],
  "vector reprocess": ["--env", "staging"],
  "vector reset": ["--env", "staging", "--confirm-reset", "yes, i really want to reset staging"],
  "worker sync": [],
};

/**
 * **The lines a deployed Worker says, which the CLI never prints** — the only files that may build a command with
 * `runtime: true`, by file and why. A deployed Worker cannot know the `apps/` directory that provisioned it (a
 * capability host is not the app Worker; an app Worker scaffolded before the `WORKER` var carries none), so no
 * `--worker` it could name is one it knows. Where the CLI reports the same fault, it names the Worker: `email`'s
 * settings check rewrites `hostEnv.ts`'s command for the Worker it ran for.
 */
const RUNTIME_LINES: Readonly<Record<string, string>> = {
  "core/src/capability/composition.ts": "a Workflow job's refusal at run time, in the host that runs it",
  "core/src/createBackend.ts": "the Worker's refusal of its own assembly, at boot",
  "core/src/controlPlane/error/errors.ts":
    "a control-plane refusal's default, answered to a management client over HTTP",
  "core/src/controlPlane/http/guard.ts": "the control-plane seam's answer to a management client over HTTP",
  "email/src/capability.ts": "the app Worker's refusal at the first suppression lookup",
  "email/src/workflows/hostEnv.ts": "the email host's boot log; doctor's settings check names the Worker",
  "payments/src/workflows/workerConfig.ts": "the reconcile host's refusal of its own projected config",
  "support/src/http/handlers.ts": "the support route's answer to the inbox UI",
  "support/src/store/threads.ts": "a warning in the app Worker's log",
  "turnstile/src/http/middleware.ts": "the humanity check's answer to a caller",
  "vector/src/error/errors.ts": "a search refusal's default, answered by the app Worker",
  "vector/src/index/drift.ts": "the app Worker's drift refusal at search time",
  "vector/src/index/provisioned.ts":
    "the vector package's one provision line: the boot check, the search routes and the vector host, each by its own Worker",
};

/**
 * **The functions that make a caller's context from something other than a command's parsed `args`**, by file and
 * name, and why (#711). Every other `callerOf` in shipped source is handed a run's own `args`, so a rerun cannot be
 * built from flags a site picked: each review round of #711 found one that dropped what the caller gave.
 */
const CALLER_CONSTRUCTORS: Readonly<Record<string, string>> = {
  "cli/src/capabilities/addCommand.ts addCallerOf":
    "`pithy add`'s options are its parsed flags one to one, and `flow.ts` adds the options its Worker's config answers",
  "cli/src/commands/upgrade.ts upgradeCallerOf": "`runUpgrade` driven with no command line behind it: tests",
  "cli/src/feature/provision.ts featureProvisionCallerOf":
    "`provisionFeature` driven with no command line behind it: tests, which drive a feature run directly",
  "cli/src/migrations/run.ts migrateCallerOf":
    "`migrateProject` driven with no command line behind it — tests — and a capability drop, which names no rerun",
};

/**
 * **The files that may name `pithy init`, and why**: each is a line for a directory that is no Pithy project yet
 * (#711). Inside a project `init` is refused — it collides on the files it would write — so a remedy reached there
 * that named it sent the reader to move the project's own files aside.
 */
const INIT_LINES: Readonly<Record<string, string>> = {
  "cli/src/project/config.ts": "the refusal for a directory with no root pithy.config.ts",
  "cli/src/project/workerScope.ts": "the refusal for a directory with no root pithy.config.ts",
  "cli/src/commands/doctor.ts": "doctor's line for a directory with no pithy.config.ts",
};

/**
 * Help text: a `.describe(…)` argument, trailing comma or not, or a `description:` value. It describes a
 * command; it does not direct one.
 */
const HELP =
  /\.describe\(\s*(?:`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,?\s*\)|\bdescription:\s*(?:`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/**
 * `pithy <words> <flags>`, anywhere, whatever whitespace separates them — a doubled space or a line break runs as
 * well as one space does. Words are the command and its positional arguments, a placeholder such as
 * `<framework>` among them; each flag may carry one value. Whether it is a citation is {@link isCitation}'s call.
 */
const MENTION =
  /(`?)\bpithy\s+((?:<[a-z-]+>|[a-z][a-z0-9-]*)(?:\s+(?:<[a-z-]+>|[a-z][a-z0-9-]*))*)((?:\s+--[a-z][a-zA-Z0-9-]*(?:\s+(?!--)[^\s,;`'")]+)?)*)/g;

/** The first word of every command and group the CLI has: `add`, `secrets`, `worker`. */
const COMMAND_WORDS = new Set([...Object.keys(COMMANDS), ...GROUPS].map((path) => path.split(" ")[0] as string));

/** One command a line names, and where. */
interface Citation {
  where: string;
  /** The citation as written, interpolation blanked to `<x>`. */
  text: string;
  /** The command and its positional arguments. */
  words: string[];
  /** Each flag, with its value where it was given one. */
  flags: [string, string | true][];
}

/**
 * **The words that follow `pithy` in prose about Pithy itself**, never as a command, each with the sentence it is
 * from. Every other word after `pithy` is read as a command, so an unknown one mid-sentence — `Sign in again with
 * pithy login`, which the CLI does not have — fails the gate rather than passing as prose. A new sentence about
 * Pithy fails closed: reword it, or add its word here. None of them may be a command or a group, which is checked
 * below, so a command the CLI gains can never be read as prose.
 */
const PROSE_WORDS: Readonly<Record<string, string>> = {
  command: "the pithy command for <x> plans from the …",
  install: "This pithy install is missing its starter template.",
  merges: "pithy merges that file in and never rewrites it",
  needs: "pithy needs Node 22 or newer",
  npm: "deno install -n pithy npm:@pithy-sh/cli — the binary's name, then its source",
  on: "Generated by pithy on every deploy",
  process: "If no other pithy process is running, delete it.",
  project: "A pithy project keeps its config here.",
  would: "pithy would provision a second set beside them",
};

/**
 * **Whether a mention is a citation**: every mention is, unless its first word is one of the {@link PROSE_WORDS}
 * and it is neither written as code nor carries a flag — a flag is a command line's own mark. So `pithy add`,
 * `` `pithy frobnicate` ``, `with pithy login` and `pithy frobnicate --worker api` are citations, the last three
 * of commands that do not exist, wherever they sit in a sentence. So is `pithy ${path}`, whose command nothing can
 * read: a line naming a release of the CLI says so with the builder's `cliAtVersion`, never by interpolation.
 */
function isCitation(words: readonly string[], flags: string, code: boolean): boolean {
  const [first = ""] = words;
  if (code || flags.trim().length > 0) return true;
  return !Object.hasOwn(PROSE_WORDS, first);
}

/** Every citation in one literal's text. */
function citationsIn(text: string, where: string): Citation[] {
  const found: Citation[] = [];
  for (const match of text.matchAll(MENTION)) {
    const words = (match[2] as string).split(/\s+/);
    if (!isCitation(words, match[3] ?? "", match[1] === "`")) continue;
    const flags = [...(match[3] ?? "").matchAll(/(--[a-z][a-zA-Z0-9-]*)(?:\s+(?!--)([^\s,;`'")]+))?/g)].map(
      (pair): [string, string | true] => [pair[1] as string, pair[2] ?? true],
    );
    found.push({ where, text: `pithy ${words.join(" ")}${match[3] ?? ""}`.trim(), words, flags });
  }
  return found;
}

/**
 * The catalog paths a citation's words can name: the longest prefix that matches one, `<x>` matching any word.
 * Empty when nothing matches, or when every word read is interpolated, which names nothing.
 */
function commandsNamed(words: readonly string[], paths: readonly string[]): string[] {
  for (let take = words.length; take > 0; take -= 1) {
    const prefix = words.slice(0, take);
    if (prefix.every((word) => word === "<x>")) return [];
    const found = paths.filter((path) => {
      const parts = path.split(" ");
      return parts.length === prefix.length && parts.every((part, i) => prefix[i] === "<x>" || prefix[i] === part);
    });
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * **What is wrong with one citation, by the builder's own rules**: for each command its words can name, the
 * faults {@link commandFaults} finds. A citation is a fault before any of these — it was spelled by hand — and
 * these say what running it as written would meet. A citation whose words name no command says so.
 */
function ruleFaults(citation: Citation): string[] {
  const paths = Object.keys(COMMANDS);
  const named = commandsNamed(citation.words, paths);
  if (named.length === 0) {
    const path = citation.words.join(" ");
    if (citation.words[0] === "<x>")
      return ["`pithy <x>` names its command by interpolation, so nothing can check it."];
    return isGroupPath(path) ? [] : [`\`pithy ${path}\` is not a command.`];
  }
  return named.flatMap((path) => {
    const args = citation.words.slice(path.split(" ").length);
    // Every value in a literal line was spelled by the program, so a placeholder among them is a fault.
    return commandFaults(
      path,
      { args, flags: Object.fromEntries(citation.flags) },
      { interpolated: true, spelled: true },
    );
  });
}

/** What one file says: the source the spans index — comments and help text blanked, offsets kept — and its literals. */
interface ReadLiterals {
  source: string;
  spans: LiteralSpan[];
}

/**
 * Every literal a file says, help text left out: blanked in place rather than cut, so each span's offsets index
 * the source its surroundings are read from. A `.tsx` is read as JSX, its element text and attribute strings too.
 */
function readLiterals(raw: string, jsx: boolean): ReadLiterals {
  const source = blankComments(raw).replace(HELP, (help) => help.replace(/[^\n]/g, " "));
  // Walked rather than matched: a template nested in an interpolation closes nothing (`literalSpans`).
  return { source, spans: literalSpans(source, { jsx }) };
}

/** A piece of a `pithy` command line: `"pithy"`, or a literal that ends in it, before a command is put after it. */
const PIECE = /(?:^|[\s(`])pithy\s*$/;

/** After an array closes: any chained calls, then `.join(`. */
const JOINED = /^\s*(?:\.\s*[A-Za-z_$][\w$]*\s*\((?:[^()]|\([^()]*\))*\)\s*)*\.\s*join\s*\(/;

/**
 * The file as code: every literal's own words blanked, delimiters and offsets kept, so a bracket or a `+` inside
 * one is not read as code — but a template's interpolations are left, because they are code, and an array joined
 * inside one is exactly what {@link assembledIn} looks for.
 */
function codeOf(read: ReadLiterals): string {
  // Code units, as the spans count them.
  const chars = read.source.split("");
  for (const span of read.spans) {
    // A JSX text run has no delimiters, and its `{…}` children are code: it is left as it is.
    if (!/["'`]/.test(read.source[span.start] ?? "")) continue;
    let from = span.start + 1;
    for (const [start, end] of [...(span.holes ?? []), [span.end - 1, span.end] as const]) {
      for (let index = from; index < start; index += 1) if (chars[index] !== "\n") chars[index] = " ";
      from = end;
    }
  }
  return chars.join("");
}

/** Where the array an element sits in closes, or `-1` when the element is not in one — an argument, say. */
function arrayClose(code: string, from: number): number {
  let depth = 0;
  for (let index = from; index < code.length; index += 1) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "}") {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (char === "]") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * **Every command assembled from pieces** (#711): a literal that is `pithy`, or ends in it, put into a line by
 * `+`, as an element of an array that is joined, as an interpolation of its own, or handed to `execArgs` — the
 * argv a spawn takes, which `upgrade.ts` once joined into a sentence. No literal holds `pithy` and a command word
 * together, so {@link citationsIn} reads nothing; the surroundings say what it is.
 */
function assembledIn(read: ReadLiterals): { text: string; how: string }[] {
  const code = codeOf(read);
  const found: { text: string; how: string }[] = [];
  for (const span of read.spans) {
    if (!PIECE.test(span.text)) continue;
    const before = code.slice(0, span.start);
    const after = code.slice(span.end);
    if (/\bexecArgs\s*\([^()]*,\s*$/.test(before)) {
      found.push({ text: span.text, how: "handed to execArgs" });
    } else if (/(?<!\+)\+\s*$/.test(before) || /^\s*\+(?!\+)/.test(after)) {
      found.push({ text: span.text, how: "concatenated" });
    } else if (/[[,]\s*$/.test(before)) {
      const close = arrayClose(code, span.end);
      if (close !== -1 && JOINED.test(code.slice(close + 1)))
        found.push({ text: span.text, how: "joined from an array" });
    } else if (/\$\{\s*$/.test(read.source.slice(0, span.start)) && /^\s*\}/.test(read.source.slice(span.end))) {
      found.push({ text: span.text, how: "interpolated" });
    }
  }
  return found;
}

/** A builder that takes a line's parts: every literal among them was spelled by the program. */
const PARTS_BUILDER = /\b(?:pithyCommand|pithyCommandOf|remedy|personDecision|rerunRemedy|rerunCommand)\s*\(/g;

/** A command named in prose, as an interpolation's whole code. */
const NAMED_IN_PROSE = /^\s*(commandName(?:Of|OfPath)?\s*\((?:[^()]|\([^()]*\))*\))\s*$/;

/** A flag, written straight after an interpolation — or after the code span that closes around it. */
const FLAG_AFTER = /^(?:\\?`)?\s+(--?[a-zA-Z][\w-]*)/;

/** A literal that opens with a flag: the rest of a command line, put after something else. */
const OPENS_WITH_FLAG = /^\s*--?[a-zA-Z]/;

/**
 * What comes before a literal joined onto a command named in prose: the call itself, or a template that ends in it,
 * then a `+` or the `,` of an array (#711).
 */
const AFTER_NAMED = /commandName(?:Of|OfPath)?\s*\((?:[^()]|\([^()]*\))*\)\s*(?:\}?\s*`\s*)?(?:\+(?!\+)|,)\s*$/;

/** The CLI named by its package or at a version, with a word after it: `npx @pithy-sh/cli upgrade`, `pithy@latest`. */
const PACKAGE_MENTION = /(@pithy-sh\/cli|\bpithy@[\w.^~-]+)\s+([a-z][a-z0-9-]*)/g;

/** What comes before a literal bound to a name, the name captured: `const BIN = `, `let run: string = `. */
const BOUND = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*$/;

/** Every name a file binds a `pithy` piece to. */
function boundPithy(read: ReadLiterals): Set<string> {
  const code = codeOf(read);
  const names = new Set<string>();
  for (const span of read.spans) {
    const bound = PIECE.test(span.text) ? BOUND.exec(code.slice(0, span.start)) : null;
    if (bound?.[1] !== undefined) names.add(bound[1]);
  }
  return names;
}

/** Where the bracket that opens at `open` closes, in code whose literals are blanked; `-1` when it never does. */
function closeOf(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * **Every command finished by hand around the builder** (#711): a flag written straight after `commandName`'s output,
 * which the builder never saw; a `<placeholder>` or a blank spelled as a literal into a builder's parts, which the
 * builder quotes as the caller's value it takes every value to be; and a name a `"pithy"` was bound to — in any file,
 * `bound` is every shipped file's {@link boundPithy} — with words put after it, by a template or a `+`.
 */
function finishedByHand(read: ReadLiterals, bound: ReadonlySet<string>): { text: string; how: string }[] {
  const code = codeOf(read);
  const found: { text: string; how: string }[] = [];
  for (const span of read.spans) {
    for (const [start, end] of span.holes ?? []) {
      const named = NAMED_IN_PROSE.exec(read.source.slice(start, end));
      // The interpolation's `}` is at `end`; what the template says next starts after it.
      const flag = named === null ? null : FLAG_AFTER.exec(read.source.slice(end + 1, span.end - 1));
      if (named !== null && flag !== null) {
        found.push({ text: `${named[1]} ${flag[1]}`, how: "given a flag after it by hand" });
      }
    }
    for (const [start, end] of span.holes ?? []) {
      const name = read.source.slice(start, end).trim();
      const word = bound.has(name) ? /^\s+([a-z<][\w<>-]*)/.exec(read.source.slice(end + 1, span.end - 1)) : null;
      if (word !== null)
        found.push({ text: `${name} ${word[1]}`, how: "a pithy bound to a name, with a command after it" });
    }
  }
  for (const span of read.spans) {
    if (OPENS_WITH_FLAG.test(span.text) && AFTER_NAMED.test(code.slice(0, span.start))) {
      found.push({ text: span.text, how: "given a flag after it by hand" });
    }
    for (const mention of span.text.matchAll(PACKAGE_MENTION)) {
      if (COMMAND_WORDS.has(mention[2] as string)) {
        found.push({
          text: `${mention[1]} ${mention[2]}`,
          how: "the CLI named by package, with a command after it",
        });
      }
    }
  }
  for (const name of bound) {
    for (const use of code.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\+(?!\\+)`, "g"))) {
      found.push({ text: use[0].replace(/\s+/g, " "), how: "a pithy bound to a name, with a command after it" });
    }
  }
  for (const call of code.matchAll(PARTS_BUILDER)) {
    const open = (call.index ?? 0) + call[0].length - 1;
    // A local helper that happens to share a name and takes a list of sentences (`doctor.ts`'s `remedy([…])`).
    if (/^\(\s*\[/.test(code.slice(open))) continue;
    const close = closeOf(code, open);
    for (const span of read.spans) {
      if (span.start <= open || (close !== -1 && span.end > close)) continue;
      // A value the program spelled: an element, or a property's value. A key, or a `.join(" ")`, is not one.
      // A fallback through `??`, `||` or a ternary is one too, and so is one in a parenthesised cast.
      const before = code.slice(0, span.start);
      if (!/(?:[[,:?]|\?\?|\|\|)\s*\(?\s*$/.test(before) || /^\s*:/.test(code.slice(span.end))) continue;
      const blank = span.text.trim().length === 0;
      const placeholder = /<[^>]*>/.test(span.text.replaceAll("<x>", ""));
      if (blank || placeholder) found.push({ text: span.text, how: "spelled into a builder's parts" });
    }
  }
  return found;
}

/**
 * **Every caller's context made from something other than a run's own `args`** (#711): a `callerOf` — the builder's,
 * imported — handed anything else, outside {@link CALLER_CONSTRUCTORS}; and a cast to a `Caller`, which skips
 * `callerOf` altogether.
 */
function callerFaults(file: { where: string; read: ReadLiterals; source: string }): string[] {
  const { where, read, source } = file;
  const code = codeOf(read);
  const faults: string[] = [];
  // The builder's `callerOf`, imported: a package's own function of the same name is another thing.
  const imported = /import\s*\{[^}]*\bcallerOf\b[^}]*\}\s*from\s*"[^"]*\/cli\/command"/.test(source);
  for (const call of imported ? code.matchAll(/\bcallerOf\s*\(/g) : []) {
    const at = call.index ?? 0;
    if (/^\s*(?:"[^"]*"|`[^`]*`|[A-Za-z_$][\w$.]*)\s*,\s*args\s*[,)]/.test(code.slice(at + call[0].length))) continue;
    const enclosing = [...code.slice(0, at).matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)].at(-1)?.[1];
    if (`${where} ${enclosing}` in CALLER_CONSTRUCTORS) continue;
    faults.push(`${where}: callerOf in ${enclosing ?? "top level"} is handed something other than a run's args`);
  }
  if (/\bas\s+(?:unknown\s+as\s+)?Caller\b/.test(code)) faults.push(`${where}: casts to a Caller`);
  return faults;
}

describe("the scan reads a caller's context built by hand", () => {
  const IMPORT = 'import { callerOf } from "@pithy-sh/core/src/cli/command";\n';
  const faults = (body: string, where = "cli/src/x.ts") => {
    const source = `${IMPORT}${body}`;
    return callerFaults({ where, read: readLiterals(source, false), source });
  };

  test("a callerOf handed flags a site picked, rather than the run's args", () => {
    expect(faults('function line(env) { return rerunCommand(callerOf("upgrade", { env, migrate: true })); }')).toEqual([
      "cli/src/x.ts: callerOf in line is handed something other than a run's args",
    ]);
    expect(faults('const c = callerOf("migrate", { ...args, worker: "api" });')).toEqual([
      "cli/src/x.ts: callerOf in top level is handed something other than a run's args",
    ]);
  });

  test("a cast to a Caller", () => {
    expect(faults('const c = { path: "upgrade" } as unknown as Caller<"upgrade">;')).toEqual([
      "cli/src/x.ts: casts to a Caller",
    ]);
  });

  test("but not a run's own args, a listed constructor, or another package's callerOf", () => {
    expect(faults('run: ({ args }) => rerunRemedy(callerOf("email provision", args), {}),')).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(faults("const c = callerOf(`secrets ${mode}`, args, { set });")).toEqual([]);
    expect(
      faults(
        'export function upgradeCallerOf(o) { return callerOf("upgrade", { env: o.env }); }',
        "cli/src/commands/upgrade.ts",
      ),
    ).toEqual([]);
    const own = 'function callerOf(x) { return x; }\nconst c = callerOf("a", { b: 1 });';
    expect(callerFaults({ where: "auth/src/x.ts", read: readLiterals(own, false), source: own })).toEqual([]);
  });
});

/** One shipped source file: where it is, its source with comments blanked, every literal's text, and how it read. */
interface ShippedFile {
  where: string;
  source: string;
  texts: string[];
  read: ReadLiterals;
}

/** Every package's shipped source, `.tsx` included, help text left out of the literals read. */
function shippedFiles(): ShippedFile[] {
  const sources = readdirSync(PACKAGES).flatMap((pkg) =>
    sourcePaths(join(PACKAGES, pkg, "src"), { keep: isShippedModule, skip: ["test-utils"] }),
  );
  const files: ShippedFile[] = [];
  for (const path of sources) {
    const raw = readSource(path);
    if (raw === null) continue;
    const read = readLiterals(raw, path.endsWith(".tsx"));
    files.push({
      where: relative(PACKAGES, path).split(sep).join("/"),
      source: blankComments(raw),
      texts: read.spans.map((span) => span.text),
      read,
    });
  }
  return files;
}

describe("the scan reads a command wherever a line names one", () => {
  const words = (text: string) => citationsIn(text, "x").map((one) => one.words.join(" "));

  test("in each shape a line writes one", () => {
    expect(words("Run pithy doctor to see what is missing.")).toEqual(["doctor to see what is missing"]);
    expect(words("pithy email provision")).toEqual(["email provision"]);
    expect(words("Add it (run `pithy add email`).")).toEqual(["add email"]);
    expect(words("Connect this environment first: pithy dashboard connect --env <x>.")).toEqual(["dashboard connect"]);
    expect(words("Run pithy init, then pithy add secrets again.")).toEqual(["init", "add secrets again"]);
    expect(words("Compose a provider, such as pithy add payments.")).toEqual(["add payments"]);
    expect(words("Rebuild it with `pithy vector reset`.")).toEqual(["vector reset"]);
  });

  // Mid-sentence, after any word: the shapes the earlier gate's anchors (`Run `, `then `, `: `) never read.
  test("mid-sentence, after any word at all", () => {
    expect(words("A feature's key is created once by pithy provision --feature and deleted with it.")).toEqual([
      "provision",
    ]);
    expect(words("<x> is created by pithy <x> provision. Nothing local stands in for it.")).toEqual(["<x> provision"]);
    expect(words("Not moved by pithy upgrade.")).toEqual(["upgrade"]);
    expect(words("printf '%s' \"$VALUE\" | pithy secrets <x> <x>")).toEqual(["secrets <x> <x>"]);
  });

  test("and a command that does not exist, where it is written as one", () => {
    expect(words("Run `pithy frobnicate` first.")).toEqual(["frobnicate"]);
    expect(words("Run pithy frobnicate first.")).toEqual(["frobnicate first"]);
  });

  // An unknown command mid-sentence: the shape `dashboard/api.ts` shipped as `Sign in again with pithy login`.
  test("and one that does not exist, mid-sentence", () => {
    expect(words("Sign in again with pithy login — that credential was refused.")).toEqual(["login"]);
    expect(words("Fix it with pithy frobnicate --worker api.")).toEqual(["frobnicate"]);
    expect(words("Then pithy frobnicate.")).toEqual(["frobnicate"]);
    expect(words("Try pithy frobnicate.")).toEqual(["frobnicate"]);
    expect(words("Rebuilt by pithy frobnicate.")).toEqual(["frobnicate"]);
    expect(words("Rebuilt using pithy frobnicate.")).toEqual(["frobnicate"]);
  });

  // A flag is a command line's own mark: whatever the first word, a mention that carries one is a citation.
  test("and any mention that carries a flag", () => {
    expect(words("We saw pithy frobnicate --worker api fail.")).toEqual(["frobnicate"]);
  });

  test("whatever whitespace separates its words", () => {
    expect(words("pithy  email provision")).toEqual(["email provision"]);
    expect(words("pithy\nemail provision")).toEqual(["email provision"]);
    expect(words("Run pithy\tfrobnicate.")).toEqual(["frobnicate"]);
  });

  test("and no word read as prose is a command the CLI has", () => {
    expect(Object.keys(PROSE_WORDS).filter((word) => COMMAND_WORDS.has(word))).toEqual([]);
  });

  test("but not prose about pithy", () => {
    expect(citationsIn("<x> (installed via <x>)", "x")).toEqual([]);
    expect(citationsIn("If no other pithy process is running, delete it.", "x")).toEqual([]);
    expect(citationsIn("A pithy project keeps its config here.", "x")).toEqual([]);
    expect(citationsIn("pithy needs Node 22.", "x")).toEqual([]);
  });

  test("reads each flag with its value", () => {
    const [one] = citationsIn("Run pithy add <x> --worker api --with-prerequisites.", "x");
    expect(one?.words).toEqual(["add", "<x>"]);
    expect(one?.flags).toEqual([
      ["--worker", "api"],
      ["--with-prerequisites", true],
    ]);
  });

  // `pithy ${path}` names a command nothing can read: the version a line once interpolated there is said by the
  // builder's `cliAtVersion`, so whatever follows `pithy` as an interpolation is a command (#711).
  test("and a command whose path is wholly interpolated, whatever it interpolates", () => {
    expect(words("Run pithy <x> now.")).toEqual(["<x> now"]);
    expect(words("pithy <x> (installed via <x>)")).toEqual(["<x>"]);
    expect(words("pithy <x> <x>. You have <x>.")).toEqual(["<x> <x>"]);
  });

  test("an interpolated command word is every command it could be, and a wholly interpolated one is none", () => {
    const paths = ["add", "email provision", "secrets provision", "secrets ls"];
    expect(commandsNamed(["<x>", "provision"], paths)).toEqual(["email provision", "secrets provision"]);
    expect(commandsNamed(["add", "secrets", "again"], paths)).toEqual(["add"]);
    expect(commandsNamed(["<x>"], paths)).toEqual([]);
  });
});

describe("a citation is read against the builder's own rules", () => {
  const faults = (text: string) => citationsIn(text, "x").flatMap(ruleFaults);

  test("a command that does not exist", () => {
    expect(faults("Run `pithy frobnicate`.")).toEqual(["`pithy frobnicate` is not a command."]);
    expect(faults("Sign in again with pithy login.")).toEqual(["`pithy login` is not a command."]);
    expect(faults("Fix it with pithy frobnicate --worker api.")).toEqual(["`pithy frobnicate` is not a command."]);
  });

  test("a Worker-scoped command that names no Worker, whatever the capability", () => {
    expect(faults("Compose a provider, such as pithy add payments.").join(" ")).toMatch(/names none/);
    expect(faults("Run pithy <x> provision.").join(" ")).toMatch(/names none/);
  });

  test("an --env left to its default", () => {
    expect(faults("Run pithy vector provision --worker api.").join(" ")).toMatch(/acts on dev/);
    expect(faults("Run pithy migrate.").join(" ")).toMatch(/acts on dev/);
  });

  test("a placeholder, and a provision without its --yes", () => {
    expect(faults("Run pithy ui sync --worker <name>.").join(" ")).toMatch(/nobody can run/);
    expect(faults("Run pithy provision --env staging.").join(" ")).toMatch(/without --yes/);
  });

  test("an outsized destructive remedy", () => {
    expect(faults("Run `pithy feature destroy` then `pithy provision --feature`.").join(" ")).toMatch(
      /person's decision/,
    );
  });

  test("a command path that is wholly interpolated, which nothing can check", () => {
    expect(faults("Run pithy <x> now.")).toEqual([
      "`pithy <x>` names its command by interpolation, so nothing can check it.",
    ]);
  });

  test("and nothing for a line that runs as written", () => {
    expect(faults("Run pithy provision --env staging --yes.")).toEqual([]);
    expect(faults("Run pithy ui sync --worker api.")).toEqual([]);
  });
});

// A `.tsx` says its words as JSX, which a quote-and-backtick walk never reads.
describe("the scan reads a .tsx as React renders it", () => {
  const read = (source: string) =>
    readLiterals(source, true).spans.flatMap((span) => citationsIn(span.text, "x").map((one) => one.words.join(" ")));

  test("an element's text and its attribute strings", () => {
    expect(read("const a = <Text>Run pithy frobnicate</Text>;")).toEqual(["frobnicate"]);
    expect(read('const a = <Hint label="pithy ui sync" />;')).toEqual(["ui sync"]);
    expect(read("const a = <Text>Run{' '}\n  pithy {path} now</Text>;")).toEqual(["<x> now"]);
  });

  test("and not a .ts file's comparison", () => {
    expect(readLiterals('const a = b <c && "pithy doctor";', false).spans.map((span) => span.text)).toEqual([
      "pithy doctor",
    ]);
  });
});

/**
 * **A command assembled rather than written** — a `"pithy"` joined onto a path, a `"Run pithy "` with the command
 * concatenated after it, a `${"pithy"}` — reads as no citation to a scan of each literal alone, because no literal
 * holds `pithy` and a command word together. Each is read off the literal's surroundings.
 */
describe("the scan reads a command assembled from pieces", () => {
  const assembled = (source: string) => assembledIn(readLiterals(source, false));

  test("joined from an array", () => {
    // `declaredFlags.ts`'s own line, before #711 gave it the builder: the array inside an interpolation.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(assembled('const c = `\\`${["pithy", ...found.path].join(" ")}\\``;')).toEqual([
      { text: "pithy", how: "joined from an array" },
    ]);
    expect(assembled('const c = ["Run pithy", path].filter(Boolean).join(" ");')).toEqual([
      { text: "Run pithy", how: "joined from an array" },
    ]);
  });

  test("concatenated, before or after", () => {
    expect(assembled('const c = "Run pithy " + path;')).toEqual([{ text: "Run pithy ", how: "concatenated" }]);
    expect(assembled("const c = `pithy ` + path;")).toEqual([{ text: "pithy ", how: "concatenated" }]);
    expect(assembled('const c = prefix + "pithy";')).toEqual([{ text: "pithy", how: "concatenated" }]);
  });

  test("interpolated as a literal", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(assembled('const c = `${"pithy"} ${path}`;')).toEqual([{ text: "pithy", how: "interpolated" }]);
  });

  // `upgrade.ts` spelled its reconcile line this way: the argv a spawn would take, joined into a sentence. The
  // builder's `viaPackageManager` names the project's own CLI.
  test("handed to execArgs, which spawns the binary a line would name", () => {
    expect(assembled('const { command, args } = execArgs(pm, "pithy", ["upgrade"]);')).toEqual([
      { text: "pithy", how: "handed to execArgs" },
    ]);
  });

  test("but not the name pithy where it names no command", () => {
    expect(assembled('const dir = join(appData, "pithy");')).toEqual([]);
    expect(assembled('const meta = { name: "pithy", version };')).toEqual([]);
    expect(assembled('const known = ["pithy", "p."].includes(bin);')).toEqual([]);
    expect(assembled('if (line.startsWith("pithy ")) return;')).toEqual([]);
    expect(assembled('f("pithy", path.join(" "));')).toEqual([]);
  });
});

/**
 * **A command finished by hand around the builder (#711).** The builder checks what it is handed, so a line that
 * writes flags after `commandName`'s output, hands a builder a `<placeholder>` it spelled, or keeps `"pithy"` in a
 * name to put a command after, spells a command the builder never saw. None holds `pithy` and a command word in one
 * literal, so {@link citationsIn} reads nothing; each is read off the code around it.
 */
describe("the scan reads a command finished by hand around the builder", () => {
  const finished = (source: string) => {
    const read = readLiterals(source, false);
    return finishedByHand(read, boundPithy(read));
  };

  test("a flag written after a command named in prose", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
      finished('const a = `Run ${commandName("vector provision")} --worker api.`;'),
    ).toEqual([{ text: 'commandName("vector provision") --worker', how: "given a flag after it by hand" }]);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
      finished("const a = `${commandNameOf(path)}  --env staging`;"),
    ).toEqual([{ text: "commandNameOf(path) --env", how: "given a flag after it by hand" }]);
  });

  test("a placeholder or a blank spelled into a builder's parts", () => {
    expect(finished('const a = pithyCommand("secrets rm", { args: ["<name>"] });')).toEqual([
      { text: "<name>", how: "spelled into a builder's parts" },
    ]);
    expect(finished('const a = remedy("ui sync", { flags: { "--worker": "<dir>" } });')).toEqual([
      { text: "<dir>", how: "spelled into a builder's parts" },
    ]);
    expect(finished('const a = personDecision("secrets rm", { args: [""] });')).toEqual([
      { text: "", how: "spelled into a builder's parts" },
    ]);
  });

  test("a pithy kept in a name, with a command put after it", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(finished('const BIN = "pithy";\nconst line = `${BIN} add ${capability}`;')).toEqual([
      { text: "BIN add", how: "a pithy bound to a name, with a command after it" },
    ]);
    expect(finished('let run: string = "pithy";\nconst line = run + " vector provision";')).toEqual([
      { text: "run +", how: "a pithy bound to a name, with a command after it" },
    ]);
    // The name is read wherever it is used: bound in one file, put before a command in another.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(finishedByHand(readLiterals("const a = `Run ${CLI_NAME} doctor.`;", false), new Set(["CLI_NAME"]))).toEqual([
      { text: "CLI_NAME doctor", how: "a pithy bound to a name, with a command after it" },
    ]);
  });

  // #711's last review: each of these got past the gate, each in a category it claimed to cover.
  test("a flag joined after a command named in prose, by + or by an array, or after its code span", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
      finished('const a = `${commandName("vector provision")}` + " --env staging";'),
    ).toEqual([{ text: " --env staging", how: "given a flag after it by hand" }]);
    expect(finished('const a = [commandName("vector provision"), "--worker", "api"].join(" ");')).toEqual([
      { text: "--worker", how: "given a flag after it by hand" },
    ]);
    expect(finished('const a = commandName("vector provision") + " --env staging";')).toEqual([
      { text: " --env staging", how: "given a flag after it by hand" },
    ]);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
      finished('const a = `Run \\`${commandName("vector provision")}\\` --env staging.`;'),
    ).toEqual([{ text: 'commandName("vector provision") --env', how: "given a flag after it by hand" }]);
  });

  test("a placeholder handed to a builder as a fallback", () => {
    expect(finished('const a = pithyCommand("ui sync", { flags: { "--worker": dir ?? "<worker>" } });')).toEqual([
      { text: "<worker>", how: "spelled into a builder's parts" },
    ]);
    expect(
      finished('const a = remedy("ui sync", { flags: { "--worker": dir || ("<worker>" as WorkerDir) } });'),
    ).toEqual([{ text: "<worker>", how: "spelled into a builder's parts" }]);
    expect(finished('const a = remedy("ui sync", { flags: { "--worker": ok ? dir : "<worker>" } });')).toEqual([
      { text: "<worker>", how: "spelled into a builder's parts" },
    ]);
  });

  test("the CLI named by its package or a version, with a command after it", () => {
    expect(finished('const a = "Run npx @pithy-sh/cli upgrade.";')).toEqual([
      { text: "@pithy-sh/cli upgrade", how: "the CLI named by package, with a command after it" },
    ]);
    expect(finished('const a = "Run bunx pithy@latest upgrade.";')).toEqual([
      { text: "pithy@latest upgrade", how: "the CLI named by package, with a command after it" },
    ]);
    expect(finished('const a = "Install @pithy-sh/cli first.";')).toEqual([]);
  });

  test("but not a command named in prose, a caller's value, or the name pithy", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(finished('const a = `migrate with ${commandName("migrate")} and its --env`;')).toEqual([]);
    expect(finished('const a = pithyCommand("secrets update", { args: [name], flags: { "--env": env } });')).toEqual(
      [],
    );
    expect(
      finished('const a = pithyCommand("schema", { args: [prefix.join(" ")], flags: { "--json": true } });'),
    ).toEqual([]);
    expect(finished('const meta = { name: "pithy", version };')).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the interpolation is the fixture, and has to arrive here uninterpolated.
    expect(finished('const NAME = "pithy";\nconst a = `declares \\`${NAME}\\` as a key`;')).toEqual([]);
    expect(finished('const NAME = "pithy";\nconst a = join(dir, NAME);')).toEqual([]);
  });
});

describe("every command a line names is built, never spelled", () => {
  const files = shippedFiles();
  const sourceOf = (where: string) => files.find((one) => one.where === where)?.source ?? "";

  /**
   * **The gate.** A citation anywhere in shipped source, outside the builder, is a fault, and the report says what
   * running it as written would meet.
   */
  test("no shipped source spells a pithy command by hand", () => {
    const faults: string[] = [];
    const bound = new Set(files.filter(({ where }) => where !== BUILDER).flatMap(({ read }) => [...boundPithy(read)]));
    for (const { where, texts, read } of files) {
      if (where === BUILDER) continue;
      for (const citation of texts.flatMap((text) => citationsIn(text, where))) {
        const why = ruleFaults(citation);
        faults.push(`${where}: "${citation.text}" is spelled by hand${why.length === 0 ? "" : ` — ${why.join(" ")}`}`);
      }
      for (const piece of assembledIn(read)) {
        faults.push(`${where}: "${piece.text}" is ${piece.how} into a command by hand`);
      }
      for (const piece of finishedByHand(read, bound)) {
        faults.push(`${where}: "${piece.text}" is ${piece.how}, which finishes a command by hand`);
      }
    }
    expect(faults).toEqual([]);
  });

  // The vacuity floor: a scan that quietly reads nothing passes the test above. Every builder call is a line that
  // names a command, so there must be many.
  test("the lines that name commands are there to be read, and build them", () => {
    const BUILT = /\b(?:pithyCommand|pithyCommandOf|remedy|personDecision|commandName|addPlan)\(/g;
    const calls = files.reduce((sum, { source }) => sum + (source.match(BUILT)?.length ?? 0), 0);
    expect(files.reduce((sum, { texts }) => sum + texts.length, 0)).toBeGreaterThan(5000);
    expect(calls).toBeGreaterThan(150);
  });

  // `.tsx` ships too — Ink's `pithy dev` screen, i18n's React translator — and a walk keyed on `.ts` read none.
  test("a shipped .tsx is read, and read as JSX", () => {
    const app = files.find(({ where }) => where === "cli/src/dev/tui/app.tsx");
    expect(app).toBeDefined();
    expect(files.some(({ where }) => where === "i18n/src/react/translator.tsx")).toBe(true);
    expect(app?.texts.length).toBeGreaterThan(10);
  });

  // A deployed Worker reads no manifest and knows no Worker, so a runtime line names the capability with
  // `--with-prerequisites`, which is right whatever the manifest declares.
  test("only the add builder, or a runtime line, builds a pithy add", () => {
    const sites = files
      .filter(({ where }) => where !== ADD_BUILDER && where !== BUILDER && !(where in RUNTIME_LINES))
      .filter(({ source }) => /\b(?:pithyCommand|pithyCommandOf|remedy|personDecision)\(\s*"add"/.test(source))
      .map(({ where }) => where);
    expect(sites).toEqual([]);
  });

  test("only a runtime line builds a command without --worker", () => {
    const sites = files
      .filter(({ where }) => !(where in RUNTIME_LINES) && where !== BUILDER)
      .filter(({ source }) => /\bruntime:\s*true\b/.test(source))
      .map(({ where }) => where);
    expect(sites).toEqual([]);
  });

  // An exemption that has nothing left to exempt is a hole the next line walks through unread. A runtime line
  // that knows too little to build a command — no environment for one whose `--env` defaults — names it in prose
  // with `commandName` and says which flag the reader supplies, and still counts.
  test("every runtime line still names a command for a deployed Worker", () => {
    for (const where of Object.keys(RUNTIME_LINES)) {
      expect(sourceOf(where), `${where} names no command`).toMatch(
        /\b(?:pithyCommandOf|remedy|personDecision|commandName)\(/,
      );
    }
  });

  /**
   * **A rerun is built from the caller's own context (#711).** `rerunCommand`, `rerunRemedy` and `addAgain` take a
   * `Caller` and nothing else, and a `Caller` is made by `callerOf` — so this holds the two ways around that: a cast
   * to one, and a `callerOf` handed anything but a run's own `args` outside {@link CALLER_CONSTRUCTORS}.
   */
  test("a caller's context is made only from a run's own parsed arguments", () => {
    const faults = files.filter(({ where }) => where !== BUILDER).flatMap((file) => callerFaults(file));
    expect(faults).toEqual([]);
  });

  test("every caller constructor exempted is still there", () => {
    for (const key of Object.keys(CALLER_CONSTRUCTORS)) {
      const [where = "", name = ""] = key.split(" ");
      expect(sourceOf(where), key).toMatch(new RegExp(`\\bfunction ${name}\\b[\\s\\S]*?\\bcallerOf\\(`));
    }
  });

  test("no remedy names pithy init inside a project", () => {
    const sites = files
      .filter(({ where }) => where !== BUILDER && !(where in INIT_LINES))
      .filter(({ source }) => /\b(?:pithyCommand|pithyCommandOf|remedy|commandName)\(\s*"init"/.test(source))
      .map(({ where }) => where);
    expect(sites).toEqual([]);
    for (const where of Object.keys(INIT_LINES)) expect(sourceOf(where), where).toMatch(/pithyCommand\("init"\)/);
  });

  test("every command that acts on one Worker is proven below, and only those", () => {
    expect(Object.keys(REACH).sort()).toEqual([...WORKER_SCOPED].sort());
    expect(WORKER_SCOPED.filter((path) => !isCommandPath(path))).toEqual([]);
  });
});

const cloudflare = vi.hoisted(() => ({ current: undefined as unknown as { clients: () => Promise<unknown> } }));
vi.mock("../cloudflare/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudflare/clients")>()),
  cloudflareClients: () => cloudflare.current.clients(),
}));

/**
 * **The proof behind `WORKER_SCOPED`.** A project scaffolded by the real scaffolder, with a second Worker beside
 * the first, both composing `secrets`, `email` and `testers` — the capabilities whose commands read the project's
 * composition before they ask which Worker. Each scoped command is then run, `--json`, with the account and the
 * network refusing, and must be refused `input/required` naming `--worker`.
 */
describe("each command classified as acting on one Worker refuses without --worker", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-runnable-"));
    await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
    await linkKitPackages(dir, [
      "core",
      "secrets",
      "email",
      "testers",
      "turnstile",
      "vector",
      "payments",
      "support",
      "media",
      "storage",
    ]);
    const web = join(dir, "apps", "web");
    await cp(join(dir, "apps", "api"), web, { recursive: true });
    const wrangler = join(web, "wrangler.jsonc");
    await writeFile(wrangler, (await readFile(wrangler, "utf8")).replaceAll("acme-api", "acme-web"));
    for (const worker of ["api", "web"]) {
      const config = join(dir, "apps", worker, "pithy.config.ts");
      const marker = "// pithy:capabilities (managed region — do not remove this marker)";
      const imports = [
        'import { secrets } from "@pithy-sh/secrets/src/capability";',
        'import { email } from "@pithy-sh/email/src/capability";',
        'import { testers } from "@pithy-sh/testers/src/capability";',
      ].join("\n");
      const composed = `secrets({ registry: {} }),\n    email({ fromAddress: "noreply@example.com", baseUrl: "https://api.example.com" }),\n    testers({ baseUrl: "https://example.com" }),\n    ${marker}`;
      await writeFile(config, `${imports}\n${(await readFile(config, "utf8")).replace(marker, composed)}`);
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test.each(WORKER_SCOPED.map((path) => [path]))("pithy %s", async (path) => {
    cloudflare.current = recorder();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("This run reached the network.");
    });
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok");
    vi.stubEnv("SECRETS_STORE_ID", "store");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    try {
      await runCaptured(path, [...(REACH[path] ?? []), "--json"]).catch(() => undefined);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
    const line = JSON.parse(errors.join("").trim()) as { error: { code: string; flag?: string; choices?: string[] } };
    expect(line.error).toMatchObject({ code: "input/required", flag: "--worker", choices: ["api", "web"] });
  });
});
