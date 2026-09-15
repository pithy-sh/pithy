// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { buildDocsCatalog } from "../docs/catalog";
import { isShippedSource, readSource, sourcePaths } from "./sourceFiles";

/**
 * **An action line can be followed.**
 *
 * `PithyError`'s `action` is the operator's half of a failure: it names the `pithy` command, the file or
 * the flag that fixes what just went wrong. It is also the only part of the CLI's contract with no gate
 * on it, and there are 453 of them.
 *
 * ## Why this is a category rather than a bug
 *
 * A human reading `Pass --set billingSubject=user or --set billingSubject=organization` tries the
 * second, is refused, shrugs, and picks the first. **An agent follows it, is refused, and has no next
 * move — the message *was* the recovery path.** `docs/CLI.md` requires every command to be
 * agent-drivable, which makes an `action` an API for a caller with no human attached.
 *
 * Four producers landed in one afternoon (#489), which is where a bug stops being one:
 *
 * - the `--json` action naming `--set billingSubject=organization`, which the next call refused (#488)
 * - the interactive prompt offering that value in a select, and refusing the selection (#488)
 * - `docs/commands/add.md` carrying the action verbatim, so the documentation taught it (#488)
 * - the config-load failure naming `@pithy-sh/core` when the missing package was the capability (#480)
 *
 * ## What is checked, and what deliberately is not
 *
 * Three static analyses. **Nothing here executes a suggested command** — most of the 96 are correct,
 * several are destructive by design (`--confirm-reset`, `--confirm-production`), and the failure being
 * chased is unfollowable *guidance* rather than a broken command.
 *
 * **Its population is every package, not the CLI's (#596).** Command names and `--set` offers are read from
 * every `action:` and every host-env `command:` in every package's shipped source. Flags are read from every
 * string literal there and from every command page's prose, because a remedy reaches its reader through a
 * constant as often as through its key. Planted and red: a host's remedy constant naming `--env` on
 * `pithy secrets provision`, a template literal interpolating only the environment, and a page's prose. Not
 * seen: a command name that is itself interpolated, or a citation assembled from pieces.
 *
 * The fourth producer above is **not** covered and cannot be: an action naming the wrong package is
 * wrong about something no manifest field predicts, and checking it means the throw site carrying the
 * identity of what actually failed rather than the first name in hand. That is an error-construction
 * discipline, and it needs its own issue rather than being closed by implication here.
 *
 * **A remedy the CLI refuses is still a remedy that cannot be followed.** `@pithy-sh/email`'s settings check
 * told operators to run `pithy email provision --env <x>` and `pithy secrets provision --env <x>`, neither of
 * which declares `--env`. That was advice the CLI ignored until #594 made it advice the CLI refuses — which
 * makes the typo visible to whoever runs it, and no more followable. This gate is what keeps it out of the
 * source. What it still cannot see is the pair named above: a command whose name is interpolated
 * (`deployKit.ts`'s `pithy ${capability} provision`), which blanks to a path no command has and is skipped
 * rather than guessed at, and a citation assembled from pieces.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/**
 * An `action:` value, or a host-env provider's `command:`, as a string or template literal. Interpolation is
 * blanked, never guessed at.
 *
 * `command:` because a host renders it as guidance in the same breath: `Run <command>.`, at boot and in
 * `pithy doctor` (`@pithy-sh/core`'s `hostEnvProviderSentence`). The key also names the `--json` payload's
 * own command (`command: "secrets deprovision"`), which carries no `pithy ` and so cites nothing below.
 */
const ACTION = /\b(?:action|command):\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/**
 * `pithy <word>` where the sentence is telling you to run it.
 *
 * After `Run `, after a backtick, or at the start of the action — never mid-sentence. Measured, and it
 * is the difference between 123 matches and 96: `If no other pithy process is running, delete …` is
 * prose about a running process, and a rule that took it for a command would report a correct message
 * as wrong. A gate that cries wolf is one somebody switches off.
 */
const IMPERATIVE = /(?:^|Run |run |`)pithy ([a-z][a-z0-9-]*)/g;

/** Any string or template literal. For the flag check, which is precise enough to read every one of them. */
const LITERAL = /(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/** `pithy <command…> --flag --flag`, for checking the flags against the command they are named on. */
const WITH_FLAGS = /\bpithy ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)((?:\s+--[a-z][a-zA-Z0-9-]*)+)/g;

/** `--set key=value`, as an action or a doc offers one. */
const SET_OFFER = /--set\s+([a-zA-Z_$][\w$]*)=([^\s.,`"']+)/g;

/** One string this repository tells somebody to act on, and where it says it. */
interface Guidance {
  where: string;
  text: string;
}

/**
 * Every `action:` and `command:` in every package's shipped source, with `${…}` reduced to a placeholder.
 *
 * Every package, not the CLI and core: a capability writes guidance of its own — `pithy doctor`'s settings
 * findings, and the remedy its host prints at boot — and the email host's told an operator to run
 * `pithy secrets provision --env <env>`, a flag that command does not have, while this gate read two
 * packages and stayed green (#596).
 */
function actionStrings(): Guidance[] {
  const found: Guidance[] = [];
  const groups = readdirSync(join(REPO_ROOT, "packages")).map((pkg) => `packages/${pkg}/src`);
  for (const group of groups) {
    for (const path of sourcePaths(join(REPO_ROOT, group), { keep: isShippedSource })) {
      const source = readSource(path);
      if (source === null) continue;
      for (const match of blankComments(source).matchAll(ACTION)) {
        const literal = (match[1] as string).slice(1, -1).replace(/\$\{[^}]*\}/g, "<x>");
        found.push({ where: relative(REPO_ROOT, path).split(sep).join("/"), text: literal });
      }
    }
  }
  return found;
}

/**
 * Every command page, minus the lines a reader *types*.
 *
 * The `--json` samples these pages paste are guidance — `docs/commands/add.md` carried the wrong action
 * verbatim, which is #488's third producer and the reason docs are scanned at all.
 *
 * **But a page must be able to demonstrate a command that is refused**, and `add.md` now does exactly
 * that: `$ pithy add payments --set billingSubject=organization` above the refusal it produces. That is
 * documentation of the refusal, not an offer of the value, and a rule that could not tell the two apart
 * reported the page teaching the fix as though it were teaching the bug — measured, on the first run of
 * this gate.
 *
 * A `$ `-prefixed line is what the reader is shown typing, so it is excluded; everything else on the
 * page — prose, and the `"action"` inside a pasted payload — is what the page *tells* them, and stays
 * in scope. The distinction is between showing a failure and recommending an action.
 */
function commandDocs(): Guidance[] {
  const dir = join(REPO_ROOT, "docs", "commands");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      where: `docs/commands/${name}`,
      text: readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*\$ /.test(line))
        .join("\n"),
    }));
}

/** Each config option's choices that `pithy add` refuses, by option key, from every capability manifest. */
function unwritableChoices(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const pkg of readdirSync(join(REPO_ROOT, "packages"))) {
    const source = readSource(join(REPO_ROOT, "packages", pkg, "pithy.manifest.json"));
    if (source === null) continue;
    const manifest = JSON.parse(source) as {
      configOptions?: { key: string; choicesNeedingCode?: Record<string, string> }[];
    };
    for (const option of manifest.configOptions ?? []) {
      for (const choice of Object.keys(option.choicesNeedingCode ?? {})) {
        found.set(option.key, (found.get(option.key) ?? new Set()).add(choice));
      }
    }
  }
  return found;
}

/**
 * Every string literal in every package's shipped source, `${…}` reduced to a placeholder — the population the
 * flag check reads.
 *
 * Wider than {@link actionStrings} on purpose. A remedy is not always written at its key: the email host's
 * `const PROVISION = "pithy email provision --env <env>"` reached `Run <command>.` through a constant, and
 * `email provision` has no `--env`. A `pithy <command> --flag` citation is exact enough that prose does not
 * trip it — measured, it found nothing but real faults across the tree — so the check reads every literal
 * rather than guessing which keys carry guidance. The command-name check stays on `action:` and `command:`:
 * over every literal it reads `pithy needs Node …` as a command called `needs`.
 */
function literalStrings(): Guidance[] {
  const found: Guidance[] = [];
  for (const pkg of readdirSync(join(REPO_ROOT, "packages"))) {
    for (const path of sourcePaths(join(REPO_ROOT, "packages", pkg, "src"), { keep: isShippedSource })) {
      const source = readSource(path);
      if (source === null) continue;
      for (const match of blankComments(source).matchAll(LITERAL)) {
        const literal = (match[1] as string).slice(1, -1).replace(/\$\{[^}]*\}/g, "<x>");
        found.push({ where: relative(REPO_ROOT, path).split(sep).join("/"), text: literal });
      }
    }
  }
  return found;
}

const ACTIONS = actionStrings();
const UNWRITABLE = unwritableChoices();

describe("the scan matches guidance and not prose", () => {
  /** The imperative words this file recognizes, applied to one string. */
  const cited = (text: string): string[] => [...text.matchAll(IMPERATIVE)].map((match) => match[1] as string);

  test("finds a command in each shape an action writes one", () => {
    expect(cited("Run pithy doctor to see what is missing.")).toEqual(["doctor"]);
    expect(cited("pithy init writes it.")).toEqual(["init"]);
    expect(cited("Try `pithy dev` again.")).toEqual(["dev"]);
  });

  // The one that decides whether this gate is usable. Without it the rule reports a correct message.
  test("does not take a mid-sentence mention for a command", () => {
    expect(cited("If no other pithy process is running, delete it by hand.")).toEqual([]);
    expect(cited("A pithy project keeps its config here.")).toEqual([]);
  });

  test("reads a --set offer, and ignores the trailing punctuation of a sentence", () => {
    const offers = [...`Pass --set billingSubject=user.`.matchAll(SET_OFFER)].map((m) => `${m[1]}=${m[2]}`);
    expect(offers).toEqual(["billingSubject=user"]);
  });

  // Both flags, and `prod` is not one: a value following a flag is not itself a flag, and the pair
  // check reads the command as `token mint` rather than as `token` with an argument.
  test("pairs flags with the command they are written on", () => {
    const match = WITH_FLAGS.exec("Run pithy token mint --json --env prod.");
    WITH_FLAGS.lastIndex = 0;
    expect(match?.[1]).toBe("token mint");
    expect(match?.[2]?.trim()).toBe("--json --env");
  });
});

describe("every action line names something that exists", () => {
  // The vacuity floor. An extraction that quietly found nothing satisfies all three checks below, which
  // is the failure mode a gate over derived data has instead of a wrong answer.
  test("there are action lines to check, and they cite commands", () => {
    expect(ACTIONS.length).toBeGreaterThan(300);
    const citations = ACTIONS.flatMap((one) => [...one.text.matchAll(IMPERATIVE)]);
    expect(citations.length).toBeGreaterThan(50);
  });

  test("every command an action tells you to run is a command", async () => {
    const commands = new Set((await buildDocsCatalog()).commands.map((one) => one.path.split(" ")[0] as string));
    expect(commands.size).toBeGreaterThan(10);

    const faults: string[] = [];
    for (const { where, text } of ACTIONS) {
      for (const match of text.matchAll(IMPERATIVE)) {
        const name = match[1] as string;
        if (!commands.has(name)) faults.push(`${where}: names \`pithy ${name}\`, which is not a command — "${text}"`);
      }
    }
    expect(faults).toEqual([]);
  });

  /**
   * Over every literal in shipped source and every command page's prose. **Not seen:** a citation whose
   * command name is interpolated (`` `pithy ${capability} provision --env` `` reduces to `pithy <x>`, which
   * names no command), and one assembled from pieces (`["pithy secrets provision", "--env"].join(" ")`).
   */
  test("every flag an action names exists on the command it names it on", async () => {
    const catalog = await buildDocsCatalog();
    const flagsOf = new Map(catalog.commands.map((one) => [one.path, new Set(one.flags)]));
    const global = new Set(catalog.globalFlags);

    const faults: string[] = [];
    let pairs = 0;
    for (const { where, text } of [...literalStrings(), ...commandDocs()]) {
      for (const match of text.matchAll(WITH_FLAGS)) {
        // The longest catalog path this citation starts with: `pithy add secrets --json` is the `add`
        // command with an argument, and `pithy token mint --json` is a two-word command.
        const words = (match[1] as string).split(" ");
        let path: string | undefined;
        for (let take = words.length; take > 0; take -= 1) {
          const candidate = words.slice(0, take).join(" ");
          if (flagsOf.has(candidate)) {
            path = candidate;
            break;
          }
        }
        if (path === undefined) continue;
        for (const flag of (match[2] as string).trim().split(/\s+/)) {
          pairs += 1;
          if (!flagsOf.get(path)?.has(flag) && !global.has(flag)) {
            // The citation, not the text: a command page is one text, and quoting all of it names nothing.
            faults.push(`${where}: \`pithy ${path}\` has no ${flag} — "${match[0].trim()}"`);
          }
        }
      }
    }

    expect(pairs, "no command-and-flag pair was checked").toBeGreaterThan(10);
    expect(faults).toEqual([]);
  });
});

/** Every `--set key=value` this repository offers, against one map of what `pithy add` refuses. */
function offersRefusedValues(unwritable: Map<string, Set<string>>): { faults: string[]; offers: number } {
  const faults: string[] = [];
  let offers = 0;
  for (const { where, text } of [...ACTIONS, ...commandDocs()]) {
    for (const match of text.matchAll(SET_OFFER)) {
      offers += 1;
      const [, key, value] = match as unknown as [string, string, string];
      if (unwritable.get(key)?.has(value)) {
        faults.push(`${where}: offers --set ${key}=${value}, which pithy add refuses`);
      }
    }
  }
  return { faults, offers };
}

describe("no guidance offers a value the next call refuses", () => {
  /**
   * Source **and** the command pages, because the documentation was the third producer: `docs/commands/
   * add.md` pasted the `--json` action verbatim, so correcting the CLI alone would have left the page
   * telling a reader to run a command the CLI rejects.
   */
  test("nothing offers a --set the manifest says cannot be written", () => {
    const { faults, offers } = offersRefusedValues(UNWRITABLE);

    expect(offers, "no --set offer was scanned").toBeGreaterThan(0);
    expect(faults).toEqual([]);
  });

  /**
   * **The floor, and it is no longer a shipped manifest.**
   *
   * `choicesNeedingCode` had exactly one entry — `payments`' `billingSubject: "organization"` — and #500
   * took it out: that choice is scaffolded now rather than refused, so the CLI writes it and the Worker
   * refuses to boot until the seam is written. With the map empty the containment above holds over
   * nothing, which is the one way a rule stops being a rule without anybody noticing.
   *
   * So the mechanism is exercised against a map that declares a value this repository really does offer.
   * The rule stays live with no capability using it, and the day one does, the check above is already
   * known to fire.
   */
  test("and the check would fire if one did", () => {
    const { faults } = offersRefusedValues(new Map([["billingSubject", new Set(["user"])]]));

    expect(faults.length, "no guidance offers --set billingSubject=user, so this proves nothing").toBeGreaterThan(0);
    expect(faults.every((fault) => fault.includes("--set billingSubject=user"))).toBe(true);
  });
});
