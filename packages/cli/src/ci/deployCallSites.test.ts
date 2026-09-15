// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **Every `wrangler deploy` this CLI issues is held to the Worker it will publish.**
 *
 * One class, three producers, each reaching the same wrong outcome by a different route:
 *
 * 1. `pithy deploy` for a Worker with a front end — the build emitted the top-level stanza and
 *    `.wrangler/deploy/config.json` redirected the upload to it (#579).
 * 2. The `deploy:staging` / `deploy:prod` scripts `pithy worker add` scaffolds — same redirect, reached
 *    through `bun run build && bun run deploy:staging` (#579's remediation).
 * 3. `capabilities/hostDeploy.ts`, which shelled `wrangler deploy --config <generated>` with no stanza
 *    named and no gate at all, so an exported `CLOUDFLARE_ENV=prod` published `<name>-prod` (#584).
 *
 * The third was filed rather than folded into the second **because a third producer is the signal, not
 * the instance**: four defect classes in this repository have each found three or more producers, every
 * time because the rule lived at a call site instead of at the thing being called. So the rule here is
 * stated about the population rather than about the two modules that hold it today.
 *
 * ## The two halves, and why neither is the rule alone
 *
 * 1. **{@link DEPLOY_ISSUERS} is the whole set of modules that hand a `deploy` argv to wrangler**, each
 *    named with the gate it reaches. A fourth is caught by its first argv, before it has uploaded
 *    anything.
 * 2. **Each of them reaches that gate**, and each gate reaches `selectedEnvironment`.
 *    Half 1 alone would pass a module that lists itself and gates nothing; half 2 alone would pass a
 *    module that gates one of its two argvs. And the *gate* half matters twice over: the #579 gate
 *    shipped reading the argv alone, which made it a hole shaped like its own subject — a gate that
 *    stopped modeling the shell would satisfy every other assertion here.
 *
 * ## And every one of them creates nothing (#589)
 *
 * wrangler's default for a deploy is to create any resource a binding names and it cannot find — which a
 * `pithy deploy --env staging` did, twice, on a real account. The rule is stated over the argv, because for
 * R2, queues and the namespace kinds the name is the id and no config read can see it: **every argv the
 * seam spawns turns provisioning off.** That is `runWrangler`'s own first statement, asked of every argv
 * under whatever name the seam was called by, and `project/wrangler.test.ts` proves it on a live spawn —
 * through a plain call, an alias and a `.call`. Three halves here tie the tree to it: the seam's body
 * reaches `assertCreatesNoResources` before it spawns, each issuer's `deploy` literals carry
 * `NO_PROVISION_ARG` where a reviewer reads the argv, and each issuer reaches the gate early too.
 *
 * It was held at the call sites until a review showed why it could not be. A half here counted
 * `runWrangler(` calls as text and demanded each be gated on the same identifier, and
 * `const ship = runWrangler; await ship(argv)` and `runWrangler.call(undefined, argv, …)`, planted beside
 * one gated call on an argv with the switch sliced off, left every half green. No reading of text counts
 * a call spelled some other way; a call under any name is still a call to the function that refuses.
 *
 * A third half asks the question from the seam's side: **every caller of `runWrangler` is accounted
 * for**, either as a deploy issuer above or in {@link OTHER_WRANGLER_COMMANDS} by name and reason. That
 * is what covers a call site whose argv this file cannot read — see the reach note below.
 *
 * ## What this does not see, said plainly
 *
 * A gate believed to cover a class it does not is worse than a narrow one somebody plans around, and
 * that correction was needed once on this branch already (`10c76094`).
 *
 * - **It reads a `deploy` argv as an array literal beginning `"deploy"`.** An argv assembled some other
 *   way — built in a helper, spread out of a constant, concatenated — is invisible to
 *   {@link ISSUES_DEPLOY}. Three such shapes were planted and all three left that extractor green. What
 *   catches them is half 3: the module still has to call `runWrangler` to spawn anything, and a caller
 *   in neither table fails. Closing it inside this extractor wants a real binding analysis rather than a
 *   wider regex, which would be the enumerate-the-spellings shape this repository has been bitten by.
 * - **The seam half reads that `runWrangler`'s body calls the gate before `spawn(`.** It is the statement
 *   of the rule in this file, not the proof of it: the proof is a spawn, in `project/wrangler.test.ts`.
 *   It does not model yargs either: what the gate accepts as "off" is `assertCreatesNoResources`'s
 *   docblock, and `effectiveConfig.test.ts` plants the spellings.
 * - **It reads only `packages/cli/src`.** A module that spawned wrangler without the seam is
 *   `ci/cloudflareChildEnv.test.ts`'s to refuse, and it does: a module importing `node:child_process`
 *   that neither reaches the credentialed-child seam nor appears in that file's exception table fails
 *   there.
 * - **The scaffolded npm scripts are deliberately out of scope.** `project/workerScaffold.ts` and
 *   `templates/starter/apps/api/package.json` write `wrangler deploy` as *text*, for the adopter to run
 *   in the adopter's own shell against the adopter's own tracked `wrangler.jsonc` — where those stanzas
 *   really are declared, and where `CLOUDFLARE_ENV` is a control wrangler documents. They are not
 *   deploys this CLI issues, and `project/scaffoldParity.test.ts` is what holds their `--config` — and,
 *   since #584's confirmation, their stanza: the bare `deploy` script named none, and
 *   `CLOUDFLARE_ENV=prod` turned it into a prod publish against a real wrangler. `--env=` is
 *   wrangler's own spelling for "the top level, and I mean it". Since #589 the same test holds each script
 *   to `NO_PROVISION_ARG`.
 *
 * It reads comment-blanked source, because every docblock on this subject quotes the argv it is about.
 */

const CLI_SRC = join(import.meta.dirname, "..");

/**
 * A `wrangler deploy` argv, as this CLI writes one: an array literal whose first element is `deploy`.
 *
 * Both of today's spellings are this — `["deploy", "--env", stanza]` and
 * `["deploy", "--config", configPath, TOP_LEVEL_STANZA_ARG]` — and the form is the one a reviewer can
 * see the stanza in, which is the whole reason the argv is built as a literal rather than pushed to.
 */
const ISSUES_DEPLOY = /\[\s*"deploy"/;

/**
 * A module that reaches the one wrangler spawn seam, by **name rather than by call shape**.
 *
 * It matched `runWrangler(` until an aliased import walked straight past it —
 * `import { runWrangler as ship } from "./wrangler"` then `await ship(argv, …)` issues a real, ungated
 * deploy and left every half of this sweep green. Matching the identifier catches the import that has to
 * exist for any spelling of the call, because the seam cannot be reached without naming it once.
 *
 * The trade is that a module importing the seam and never calling it is flagged. That is the same trade
 * `cloudflareChildEnv` already accepts, and it fails in the safe direction: a false positive is a line in
 * a table, a false negative is an ungated deploy.
 */
const RUNS_WRANGLER = /\brunWrangler\b/;

/** The seam. It defines `runWrangler`; it does not call it, and it issues no argv of its own. */
const SEAM = "project/wrangler.ts";

/**
 * Every module that hands a `deploy` argv to wrangler, and the gate it is held by.
 *
 * Two commands, two shapes, two gates — because they are held to different things. `pithy deploy` ships
 * the adopter's own Worker and has a *declaration* to be compared against, so its gate reads two files.
 * A capability host's config is generated and has no declaration, so its gate is stated about the file
 * itself. What they share is the primitive underneath: wrangler's `--env ?? CLOUDFLARE_ENV`, once.
 */
const DEPLOY_ISSUERS = new Map<string, string>([
  ["project/deploy.ts", "assertDeploysRequestedEnvironment"],
  ["capabilities/hostDeploy.ts", "assertPublishesDeclaredWorker"],
]);

/**
 * Callers of `runWrangler` that run something other than a deploy — **by name and by reason**.
 *
 * Empty today: the seam has exactly two callers and both deploy. It stays a table rather than becoming
 * a sentence because the next `runWrangler(argv, …)` whose argv this file cannot read needs somewhere to
 * be named, and landing in neither table is what asks its author the question. An exception list whose
 * reasons have quietly stopped being true is its own failure mode (#211), so the last assertion below
 * fails a stale entry too.
 */
const OTHER_WRANGLER_COMMANDS: Readonly<Record<string, string>> = {};

/** The module every gate's answer about which stanza a spawn selects has to come out of. */
const PRECEDENCE_PRIMITIVE = "selectedEnvironment";

/**
 * **The gate every deploy issuer reaches as well, whatever it publishes: a deploy creates nothing (#589).**
 *
 * wrangler provisions any binding it cannot resolve unless the argv turns that off, and it does so for
 * kinds whose name is their id — so no gate over a config can see it. This one is over the argv.
 */
const CREATES_NOTHING_GATE = "assertCreatesNoResources";

/** The seam's own function — the one every spawn reaches, under whatever name its caller gave it. */
const SEAM_FUNCTION = "runWrangler";

/** The child process call inside the seam. The gate has to come before it, or it gates nothing. */
const CHILD_SPAWN = /\bspawn\s*\(/;

/** The name an argv literal turns provisioning off by. A literal string is not it: see the test below. */
const NO_PROVISION = "NO_PROVISION_ARG";

/**
 * Every `deploy` argv literal in one module, from its opening `["deploy"` to the bracket that closes it.
 *
 * Bracket-counted rather than matched to the next `]`, so an element that is itself an index or an array
 * does not end the literal early and hide the elements after it.
 */
function deployLiterals(code: string): string[] {
  const literals: string[] = [];
  for (const match of code.matchAll(new RegExp(ISSUES_DEPLOY.source, "g"))) {
    let depth = 0;
    for (let index = match.index; index < code.length; index += 1) {
      if (code[index] === "[") depth += 1;
      if (code[index] === "]") depth -= 1;
      if (depth === 0) {
        literals.push(code.slice(match.index, index + 1));
        break;
      }
    }
  }
  return literals;
}

/** One module's path as the tables above spell it — relative to `packages/cli/src`, forward slashes. */
function named(path: string): string {
  return relative(CLI_SRC, path).split("\\").join("/");
}

/** Every shipped CLI module, with its comments blanked out. Walked once — this tree does not move. */
const MODULES: { key: string; code: string }[] = sourceFiles(CLI_SRC).map((file) => ({
  key: named(file.path),
  code: blankComments(file.text),
}));

/** Whether a module reaches a name — a call to it, under whatever name the importer gave it. */
function reaches(code: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(code);
}

/**
 * One exported function's own text: from its declaration to the next top-level `export`, or the end.
 *
 * Per **function**, not per module, because both gates live in `project/effectiveConfig.ts` — a rule
 * asked of the file would be satisfied for a new gate by the old one's imports, which is shape 2 of
 * #326's taxonomy at one remove. The source is comment-blanked before it gets here, so a docblock that
 * says `export` between two functions is a blank line and cannot end a body early.
 */
function bodyOf(code: string, name: string): string | null {
  const start = code.search(new RegExp(`^export (?:async )?function ${name}\\b`, "m"));
  if (start === -1) return null;
  const rest = code.slice(start + 1);
  const end = rest.search(/^export /m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("every wrangler deploy this CLI issues is held to the Worker it will publish", () => {
  test("the walk finds the CLI's sources, so a miss is a failure and not a silent pass", () => {
    // The anchor every sweep here carries. A walk rooted at the wrong directory finds no offenders and
    // reports success, which is the one outcome worse than a false accusation.
    const found = MODULES;
    expect(found.length).toBeGreaterThanOrEqual(185);
    for (const issuer of DEPLOY_ISSUERS.keys()) {
      expect(
        found.some((module) => module.key === issuer),
        `${issuer} is not in the tree`,
      ).toBe(true);
    }
    expect(found.some((module) => module.key === SEAM)).toBe(true);
  });

  test("only these modules issue a wrangler deploy", () => {
    const issuers = MODULES.filter((module) => ISSUES_DEPLOY.test(module.code))
      .map((module) => module.key)
      .sort();
    expect(
      issuers,
      "A `wrangler deploy` publishes under `--env ?? CLOUDFLARE_ENV`, so an argv that names no stanza lets the operator's shell rename the Worker — silently, and only on their machine. Hold the argv with a gate from project/effectiveConfig.ts and name this module here with the gate it reaches.",
    ).toEqual([...DEPLOY_ISSUERS.keys()].sort());
  });

  test("and each of them reaches the gate it is named with", () => {
    // The second half. A module on the list above that stopped gating would satisfy the set and ship the
    // defect; a module that gates one argv and not its second satisfies this and fails the set below.
    for (const [issuer, gate] of DEPLOY_ISSUERS) {
      const module = MODULES.find((candidate) => candidate.key === issuer);
      expect(module, `${issuer} is named as a deploy issuer and is not in the tree`).toBeDefined();
      expect(reaches(module?.code ?? "", gate), `${issuer} issues a deploy without reaching ${gate}`).toBe(true);
    }
  });

  test("and each of them turns wrangler's provisioning off, on the argv it spawns", () => {
    // #589. wrangler's `experimental-provision` defaults to on, so an argv that says nothing creates every
    // D1, KV, R2, queue and namespace it cannot find — and a kind wrangler learns next with it. Two halves,
    // for the reason the stanza has two: the literal is where a reviewer sees the switch, and the gate is
    // what refuses an argv that lost it however it was built.
    for (const issuer of DEPLOY_ISSUERS.keys()) {
      const code = MODULES.find((candidate) => candidate.key === issuer)?.code ?? "";
      expect(
        reaches(code, CREATES_NOTHING_GATE),
        `${issuer} issues a deploy without reaching ${CREATES_NOTHING_GATE}`,
      ).toBe(true);
      const literals = deployLiterals(code);
      expect(literals.length, `${issuer} has no deploy argv this sweep can read`).toBeGreaterThan(0);
      for (const literal of literals) {
        expect(
          new RegExp(`\\b${NO_PROVISION}\\b`).test(literal),
          `${issuer} builds ${literal.replace(/\s+/g, " ")} without ${NO_PROVISION}. wrangler creates any resource it cannot find unless the argv says otherwise.`,
        ).toBe(true);
      }
    }
  });

  test("and the seam refuses an argv that leaves provisioning on, before it spawns anything", () => {
    // The half of #589's rule that no spelling of a call walks around. The gate above can be reached on
    // one argv while another is spawned, and an alias or a `.call` spawns without a `runWrangler(` for any
    // reading of a caller to count — so the refusal lives in the one function every spawn runs.
    const body = bodyOf(MODULES.find((module) => module.key === SEAM)?.code ?? "", SEAM_FUNCTION);
    expect(body, `${SEAM} exports no ${SEAM_FUNCTION}`).not.toBeNull();
    const gate = (body ?? "").search(new RegExp(`\\b${CREATES_NOTHING_GATE}\\s*\\(\\s*args\\s*\\)`));
    const child = (body ?? "").search(CHILD_SPAWN);
    expect(child, `${SEAM_FUNCTION} spawns no child this can find`).toBeGreaterThan(-1);
    expect(gate, `${SEAM_FUNCTION} spawns without ${CREATES_NOTHING_GATE}(args)`).toBeGreaterThan(-1);
    expect(gate, `${SEAM_FUNCTION} asks ${CREATES_NOTHING_GATE} after it spawns`).toBeLessThan(child);
  });

  test("and every gate resolves the stanza through the one statement of wrangler's precedence", () => {
    // #579's remediation, kept. The first gate derived the stanza from the argv alone — `environmentFromArgs`
    // — which approved a bare `pithy deploy` that an exported `CLOUDFLARE_ENV` published as prod: a gate
    // modeling fewer inputs than the thing it gates is a hole shaped like its own subject. Every other
    // assertion in this file would pass such a gate.
    for (const gate of new Set(DEPLOY_ISSUERS.values())) {
      const body = MODULES.map((module) => bodyOf(module.code, gate)).find((found) => found !== null);
      expect(body, `${gate} is named as a gate and nothing exports it`).toBeDefined();
      expect(
        reaches(body ?? "", PRECEDENCE_PRIMITIVE),
        `${gate} decides which stanza a spawn selects without ${PRECEDENCE_PRIMITIVE}`,
      ).toBe(true);
    }
  });

  test("every caller of the wrangler seam is accounted for, argv or no argv", () => {
    // The half that reaches an argv this file cannot read. A module can build its argv anywhere, but it
    // cannot spawn wrangler without the seam — `ci/cloudflareChildEnv.test.ts` fails it if it tries — so
    // the caller set is the one population that cannot be spelled around.
    const unaccounted = MODULES.filter((module) => module.key !== SEAM && RUNS_WRANGLER.test(module.code))
      .map((module) => module.key)
      .filter((key) => !DEPLOY_ISSUERS.has(key) && !(key in OTHER_WRANGLER_COMMANDS))
      .sort();
    expect(
      unaccounted,
      "This module spawns wrangler with an argv no rule here can read. If it deploys, gate it and name it in DEPLOY_ISSUERS; if it runs something else, name it in OTHER_WRANGLER_COMMANDS with what it runs.",
    ).toEqual([]);
  });

  test("every non-deploy exception still calls the seam, so a stale entry cannot sit here unnoticed", () => {
    const callers = new Set(
      MODULES.filter((module) => module.key !== SEAM && RUNS_WRANGLER.test(module.code)).map((module) => module.key),
    );
    expect(Object.keys(OTHER_WRANGLER_COMMANDS).filter((key) => !callers.has(key))).toEqual([]);
    for (const [key, reason] of Object.entries(OTHER_WRANGLER_COMMANDS)) expect(reason, key).toMatch(/^runs .*\.$/);
  });

  test("the extractors see the spellings in this tree, and are honest about the ones they do not", () => {
    // The gate over the gate. `ISSUES_DEPLOY` answering "no" everywhere would make the set above green
    // and empty, which is how a defect class finds its fourth producer.
    expect(ISSUES_DEPLOY.test('const args = ["deploy", "--env", stanza];')).toBe(true);
    expect(ISSUES_DEPLOY.test('return ["deploy", "--config", configPath, TOP_LEVEL_STANZA_ARG];')).toBe(true);
    expect(ISSUES_DEPLOY.test('await runWrangler([ "deploy" ], options);')).toBe(true);
    expect(ISSUES_DEPLOY.test('await runWrangler(["d1", "execute"], options);')).toBe(false);
    expect(RUNS_WRANGLER.test("await runWrangler(argv, { account, cwd });")).toBe(true);
    // An import counts, and that is the point: the alias `import { runWrangler as ship }` is how a
    // producer reached the seam invisibly. Naming the seam is the one thing it cannot avoid.
    expect(RUNS_WRANGLER.test("import { runWrangler } from './wrangler';")).toBe(true);
    expect(RUNS_WRANGLER.test("import { runWrangler as ship } from './wrangler';")).toBe(true);
    expect(RUNS_WRANGLER.test("await somethingElse(argv, { account, cwd });")).toBe(false);
    // The three shapes it does not see, planted rather than asserted about in prose. Each is a real
    // deploy and each leaves this extractor green; each is caught by the caller half above instead.
    expect(ISSUES_DEPLOY.test("const argv = [DEPLOY, ...configArgs];")).toBe(false);
    expect(ISSUES_DEPLOY.test('const argv = [...base, "--config", path];')).toBe(false);
    expect(ISSUES_DEPLOY.test("await runWrangler(deployArgs(configPath), options);")).toBe(false);
  });

  test("a deploy literal is read to its own closing bracket, and a literal missing the switch is seen", () => {
    // The gate over the literal half. A reader that stopped at the first `]` would read
    // `["deploy", args[0], NO_PROVISION_ARG]` as ending before the switch and accuse a correct argv; one
    // that ran to the end of the module would find the switch in a neighbor and excuse a wrong one.
    expect(deployLiterals('const a = ["deploy", args[0], NO_PROVISION_ARG];')).toEqual([
      '["deploy", args[0], NO_PROVISION_ARG]',
    ]);
    const two = deployLiterals('const a = ["deploy", "--env", s];\nconst b = ["deploy", NO_PROVISION_ARG];');
    expect(two).toHaveLength(2);
    expect(two.map((literal) => /\bNO_PROVISION_ARG\b/.test(literal))).toEqual([false, true]);
  });

  test("a function body is read as that function's, and stops where the next export starts", () => {
    // The gate over the fourth half. `bodyOf` running to the end of the file would let one gate's use of
    // the primitive answer for every gate beside it, which is the whole reason it reads a body at all.
    const source = [
      "export function first(args) {",
      "  return selectedEnvironment(args, {});",
      "}",
      "",
      "export function second(args) {",
      "  return environmentFromArgs(args);",
      "}",
    ].join("\n");
    expect(reaches(bodyOf(source, "first") ?? "", PRECEDENCE_PRIMITIVE)).toBe(true);
    expect(reaches(bodyOf(source, "second") ?? "", PRECEDENCE_PRIMITIVE)).toBe(false);
    expect(bodyOf("export async function third() {}", "third")).toContain("third");
    expect(bodyOf(source, "absent")).toBeNull();
  });
});
