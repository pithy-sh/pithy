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
 * The fourth producer above is **not** covered and cannot be: an action naming the wrong package is
 * wrong about something no manifest field predicts, and checking it means the throw site carrying the
 * identity of what actually failed rather than the first name in hand. That is an error-construction
 * discipline, and it needs its own issue rather than being closed by implication here.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** An `action:` value, as a string or template literal. Interpolation is blanked, never guessed at. */
const ACTION = /\baction:\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/**
 * `pithy <word>` where the sentence is telling you to run it.
 *
 * After `Run `, after a backtick, or at the start of the action — never mid-sentence. Measured, and it
 * is the difference between 123 matches and 96: `If no other pithy process is running, delete …` is
 * prose about a running process, and a rule that took it for a command would report a correct message
 * as wrong. A gate that cries wolf is one somebody switches off.
 */
const IMPERATIVE = /(?:^|Run |run |`)pithy ([a-z][a-z0-9-]*)/g;

/** `pithy <command…> --flag --flag`, for checking the flags against the command they are named on. */
const WITH_FLAGS = /\bpithy ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)((?:\s+--[a-z][a-zA-Z0-9-]*)+)/g;

/** `--set key=value`, as an action or a doc offers one. */
const SET_OFFER = /--set\s+([a-zA-Z_$][\w$]*)=([^\s.,`"']+)/g;

/** One string this repository tells somebody to act on, and where it says it. */
interface Guidance {
  where: string;
  text: string;
}

/** Every `action:` in shipped source, with `${…}` reduced to a placeholder. */
function actionStrings(): Guidance[] {
  const found: Guidance[] = [];
  for (const group of ["packages/cli/src", "packages/core/src"]) {
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

  test("every flag an action names exists on the command it names it on", async () => {
    const catalog = await buildDocsCatalog();
    const flagsOf = new Map(catalog.commands.map((one) => [one.path, new Set(one.flags)]));
    const global = new Set(catalog.globalFlags);

    const faults: string[] = [];
    let pairs = 0;
    for (const { where, text } of ACTIONS) {
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
            faults.push(`${where}: \`pithy ${path}\` has no ${flag} — "${text}"`);
          }
        }
      }
    }

    expect(pairs, "no command-and-flag pair was checked").toBeGreaterThan(10);
    expect(faults).toEqual([]);
  });
});

describe("no guidance offers a value the next call refuses", () => {
  // The floor for this one is the manifest side: with nothing declared unwritable there is nothing to
  // offer wrongly, and the containment below would hold over an empty rule.
  test("some choice is declared unwritable, or this checks nothing", () => {
    expect(UNWRITABLE.size).toBeGreaterThan(0);
    expect(UNWRITABLE.get("billingSubject")).toContain("organization");
  });

  /**
   * Source **and** the command pages, because the documentation was the third producer: `docs/commands/
   * add.md` pasted the `--json` action verbatim, so correcting the CLI alone would have left the page
   * telling a reader to run a command the CLI rejects.
   */
  test("nothing offers a --set the manifest says cannot be written", () => {
    const faults: string[] = [];
    let offers = 0;
    for (const { where, text } of [...ACTIONS, ...commandDocs()]) {
      for (const match of text.matchAll(SET_OFFER)) {
        offers += 1;
        const [, key, value] = match as unknown as [string, string, string];
        if (UNWRITABLE.get(key)?.has(value)) {
          faults.push(`${where}: offers --set ${key}=${value}, which pithy add refuses`);
        }
      }
    }

    expect(offers, "no --set offer was scanned").toBeGreaterThan(0);
    expect(faults).toEqual([]);
  });
});
