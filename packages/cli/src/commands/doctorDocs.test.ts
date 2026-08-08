// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  cleanPlanFor,
  doctorHarness,
  planStub,
  planStubPer,
  registryFetch,
  workerSet,
  zsh,
} from "../test-utils/doctorHarness";
import { buildDoctorReport, type DoctorReportOptions, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * `docs/CLI.md` §5.6 pastes three `pithy doctor` transcripts, and CLAUDE.md makes that document binding
 * rather than advisory — an adopter reads those blocks to learn what each state looks like, and a reviewer
 * reads them to decide whether an output change is a regression. Nothing checked them, and they rotted:
 * they showed a `Node: 22.10.0` line the renderer stopped printing and omitted the `Cloudflare:` line it
 * had started printing, both for as long as it took someone to notice by eye.
 *
 * So the transcripts are tested like code, the way `project/namingDocs.test.ts` tests NAMING.md's numbers.
 * `renderDoctorText` is a pure function of a `DoctorReport`, which is the whole reason this is possible:
 * each test builds the report for **the scenario its transcript is illustrating** — an update available and
 * a Worker in drift, a clean toolchain, no project here — renders it with the real renderer, and asserts
 * the document says exactly that. A fixture is never tuned to reproduce whatever the doc happens to claim;
 * when the two disagree, the doc is what changes.
 *
 * It lives beside `doctor.test.ts` and shares its fixtures (`test-utils/doctorHarness`) for the same
 * reason: the suite that says what the renderer prints and the pin that says the doc prints the same thing
 * must start from one report builder, or the pin drifts from the behaviour it is quoting.
 *
 * ## Why pinning the transcripts is not enough on its own
 *
 * A transcript pin holds the examples that exist. It says nothing about a block, or a `--json` field, that
 * no example happens to show — so `doctor`'s `manifests:` block and `add`/`upgrade`'s `manifestFaults`
 * field both landed undocumented with every pin green, within a week of each other (#184, #186). The pins
 * were never wrong; they were answering a narrower question than the one anyone was asking of them.
 *
 * So three gates below ask the wider one, each derived from the code rather than from a list kept here:
 *
 * - **Every block label the renderer can print is named in §5.6.** Read out of `doctor.ts` itself, so a
 *   block added tomorrow is covered without this file being touched.
 * - **§5.6's `--json` sample carries exactly the keys `renderDoctorJson` emits.** Every key of that
 *   payload is unconditional — absent findings are `null`, never missing — so one render enumerates the
 *   whole contract, and a new field fails the comparison.
 * - **A `--json` payload a specifying section claims to specify is specified completely.** Each section
 *   names its own commands; the source decides their keys. §5.7 and §5.8 are the two sections enrolled —
 *   §5.8 by #187, which documented `pithy adopt` and wrote its payload key by key at the call site so
 *   this scan could reach it.
 *
 * **Enrolment is what triggers the last one, and that is deliberate.** §5.7 covers the two commands it
 * documents because it documents them — mention another in backticks with `--json` and the gate demands
 * every key of that command's payload in the same breath. So adding one sentence about a new command's
 * `--json` can fail the suite until several more name its fields, which reads as a strange punishment for
 * writing documentation until you see the alternative: a section that half-describes a payload is how an
 * adopter learns three fields of five and discovers the rest from a stack trace. Partial is the state
 * worth failing. Documenting nothing about a command stays free; the gate only ever holds the document to
 * what it already claims. (Most of the CLI is in that untouched state — roughly twenty commands' `--json`
 * fields are specified nowhere, and enrolling them is its own piece of work, not a side effect of this one.)
 *
 * What none of them reach is a payload assembled by spreading a typed object — `formatJsonLine({ command,
 * ...result })` — where no key is visible at the call site. Half of this CLI's `--json` sites are that
 * shape, and enumerating them needs the type checker, not a scan. The gate skips them by construction and
 * says so rather than reporting a clean pass over what it could not read.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI_MD = readFileSync(join(REPO_ROOT, "docs", "CLI.md"), "utf8");

const HEADING = "### 5.6 The `pithy doctor` command";

/**
 * §5.6 alone, up to the next heading. Scoped, because §5.2 pastes notification output and §5.7 follows
 * immediately — a whole-file scan would pin whichever block happened to come first.
 */
function section(heading: string): string {
  const start = CLI_MD.indexOf(heading);
  if (start === -1) throw new Error(`docs/CLI.md no longer has a "${heading}" section. Repin or restore it.`);
  const rest = CLI_MD.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The fenced blocks of a markdown section, in document order, each without its fences or trailing newline. */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((match) => (match[1] ?? "").replace(/\n$/, ""));
}

const SECTION = section(HEADING);
const BLOCKS = fencedBlocks(SECTION);

/**
 * §5.6's fenced blocks, split by what each one is, because each class is pinned differently.
 *
 * A block opening with a `$ …` prompt is a **transcript** — the whole report, pinned byte for byte. One of
 * those passes `--json`, and is pinned on its keys instead, since its paths are absolute and machine-
 * specific. Anything else is a **fragment**: a few lines lifted out of one block to illustrate it, pinned
 * with `toContain` against a report built for the state it is showing.
 *
 * Every count is asserted below. A block that lands in no class, a fourth transcript, or a second `--json`
 * sample is an example free to rot — the state this suite exists to end.
 */
const JSON_PROMPT = "$ pithy doctor --json";
const TRANSCRIPTS = BLOCKS.filter((block) => block.startsWith("$ ") && !block.startsWith(JSON_PROMPT));
const JSON_SAMPLES = BLOCKS.filter((block) => block.startsWith(JSON_PROMPT));
const FRAGMENTS = BLOCKS.filter((block) => !block.startsWith("$ "));

/**
 * One transcript's output, with the `$ …` prompt line the renderer does not emit stripped off.
 *
 * Every miss throws rather than returning something empty that would compare equal to nothing. A pin that
 * quietly stops matching is worse than no pin at all: the block it guards can then be reworded into a
 * report the CLI never prints, and the suite stays green while the document lies.
 */
function transcript(index: number, prompt: string): string {
  const block = TRANSCRIPTS[index];
  if (block === undefined) {
    throw new Error(`docs/CLI.md §5.6 no longer has ${index + 1} transcripts — found ${TRANSCRIPTS.length}.`);
  }
  const lines = block.split("\n");
  if (lines[0] !== prompt) {
    throw new Error(`docs/CLI.md §5.6 transcript ${index + 1} opens with "${lines[0]}", expected "${prompt}".`);
  }
  // The renderer's own leading blank line is the second line of the block, so slicing the prompt off
  // reproduces the string `renderDoctorText` returns, byte for byte.
  return lines.slice(1).join("\n");
}

const harness = doctorHarness();

/** The runtime every transcript is taken under — Bun, which is what gives the `(Node … compat)` suffix. */
const BUN = { name: "Bun", version: "1.2.4", nodeCompat: "22.10.0" };

/**
 * What every transcript shares, layered over whichever harness fixture a test starts from.
 *
 * `Config dir:`, `State file:`, `Dev login:`, and the shell's rc path are tilde-abbreviated against the home
 * the report is rendered for, so all four live under the fixture's home — the temp directory — and print as
 * the `~/.config/pithy` and `~/.zshrc` the document pastes. The runtime is Bun in all three transcripts,
 * which is what earns each one the `(Node … compat)` suffix.
 *
 * The dev-login check is stubbed to the state most machines are in — no `dev.json` — because it is the one
 * that has to name the path, and naming the path is the reason the line exists. The other two transcripts
 * carry the stub too and print nothing from it: the terse report suppresses the block, and outside a project
 * the report has no project name to key a preference file by.
 */
function docOptions(options: DoctorReportOptions): DoctorReportOptions {
  return {
    ...options,
    homedir: harness.dir,
    stateFile: join(harness.dir, ".config", "pithy", "state.json"),
    detectShell: async () => ({ ...zsh, rcPath: join(harness.dir, ".zshrc") }),
    checkDevPreferences: async () => ({
      state: "absent",
      path: join(harness.dir, ".config", "pithy", "acme", "dev.json"),
      user: null,
    }),
    // Its neighbour, and stubbed for the same reason: the doc transcript pins one path, and the real
    // check resolves it from a `pithy.config.ts` this harness has none of. Present, because the line
    // prints on every run whether or not there is a file — that is the whole point of it (#156).
    checkDevSecretsFile: async () => ({
      path: join(harness.dir, ".config", "pithy", "acme", "secrets.jsonc"),
      present: true,
      orphans: [],
    }),
    runtime: BUN,
  };
}

describe("docs/CLI.md §5.6", () => {
  test("pastes exactly the blocks pinned below, and nothing else", () => {
    // An unclassified block, a fourth transcript, or a second sample would be an unpinned example.
    expect(TRANSCRIPTS).toHaveLength(3);
    expect(JSON_SAMPLES).toHaveLength(1);
    expect(FRAGMENTS).toHaveLength(2);
    expect(BLOCKS).toHaveLength(TRANSCRIPTS.length + JSON_SAMPLES.length + FRAGMENTS.length);
  });

  /**
   * The verbose report: a CLI one minor behind, one capability behind, and a project whose `api` Worker is
   * missing a binding in two environments and owes two migrations, beside a `collab` Worker that is fine.
   * Every optional block is on screen at once, which is what makes it the example worth pasting.
   */
  test("the full report is what the renderer prints for a project in drift", async () => {
    const report = await buildDoctorReport(
      docOptions(
        harness.baseOptions({
          fetch: registryFetch({ cli: "1.3.0", core: "1.2.0", auth: "1.2.0", leaderboard: "1.2.0" }),
          resolveWorkers: async () => workerSet("api", "collab"),
          // `collab` is unlisted, so the stub gives it a clean plan — the healthy Worker that collapses to a line.
          buildPlan: planStubPer({
            api: {
              worker: "api",
              deployedAs: "acme-api",
              env: "dev",
              ejectedSkipped: [],
              perCapability: [
                {
                  name: "media",
                  missingConfigKeys: [],
                  missingBindings: [
                    { env: "staging", name: "MEDIA_BUCKET", type: "r2" },
                    { env: "prod", name: "MEDIA_BUCKET", type: "r2" },
                  ],
                },
              ],
              pendingMigrations: 2,
              entitlementGap: [],
              missingVersionMetadata: false,
            },
          }),
          checkProjectName: async () => ({ state: "ok", project: "acme", misnamed: [] }),
        }),
      ),
    );
    expect(transcript(0, "$ pithy doctor")).toBe(renderDoctorText(report, harness.dir));
  });

  /** The terse report: nothing to say, so the config, health, Cloudflare, and name blocks are all absent. */
  test("the up-to-date report is what the renderer prints when everything passes", async () => {
    const report = await buildDoctorReport(docOptions(harness.healthyOptions()));
    expect(transcript(1, "$ pithy doctor")).toBe(renderDoctorText(report, harness.dir));
  });

  /**
   * Outside a project: the `Project:` line states the one fact and every other project line is gone,
   * `Project name:` included. `loadProject: undefined` puts the real loader against the empty temp
   * directory, so the transcript is pinned to the loader's own verdict rather than to a stubbed refusal.
   */
  test("the outside-a-project report is what the renderer prints where there is no config", async () => {
    const report = await buildDoctorReport(docOptions(harness.healthyOptions({ loadProject: undefined })));
    expect(transcript(2, "$ cd /tmp && pithy doctor")).toBe(renderDoctorText(report, harness.dir));
  });

  /**
   * The `manifests:` fragment, pinned against a project health block carrying one unusable manifest.
   *
   * Built onto the report rather than onto the disk: `buildProjectHealth` scans `node_modules/@pithy-sh`
   * for itself and there is no seam through `buildDoctorReport` to hand it a fault, so the state is set on
   * the structure the renderer is a pure function of — which is what every other test here does too, one
   * step earlier.
   */
  test("the manifests fragment is what the renderer prints for an unreadable manifest", async () => {
    const report = await buildDoctorReport(
      docOptions(
        harness.baseOptions({ resolveWorkers: async () => workerSet("api"), buildPlan: planStub(cleanPlanFor("api")) }),
      ),
    );
    if (!report.project) throw new Error("the fixture must load a project — the health block has nowhere else to sit.");
    report.project.health = {
      ok: false,
      workers: report.project.health.workers,
      manifests: {
        ok: false,
        faults: [{ package: "@pithy-sh/leaderboard", reason: "configOptions[0].key: not a bare identifier" }],
      },
    };
    const fragment = FRAGMENTS[0];
    if (fragment === undefined) throw new Error("docs/CLI.md §5.6 no longer pastes the Project health fragment.");
    expect(renderDoctorText(report, harness.dir)).toContain(fragment);
  });

  /**
   * The `Alias: unknown` fragment (#210), pinned against a report whose rc file would not open.
   *
   * The third alias state is a sentence about a file, and the document is where an adopter meets it
   * before their machine does. Pinned like every other example here, so it cannot be reworded into a
   * line the renderer never prints — which is exactly what a state nobody can reproduce on purpose
   * would otherwise drift into.
   */
  test("the unknown-alias fragment is what the renderer prints for an rc file that will not open", async () => {
    const report = await buildDoctorReport(
      docOptions(
        harness.healthyOptions({
          readRc: async (path: string) => {
            throw new ConflictError({
              message: `Can't read ${path}.`,
              action: "Fix the file's permissions, or add the Pithy alias to your shell config yourself.",
            });
          },
        }),
      ),
    );
    const fragment = FRAGMENTS[1];
    if (fragment === undefined) throw new Error("docs/CLI.md §5.6 no longer pastes the unknown-alias fragment.");
    expect(renderDoctorText(report, harness.dir)).toContain(fragment);
  });
});

/**
 * Every block label `renderDoctorText` can print, read out of `doctor.ts` itself.
 *
 * A label is a literal opening a line of the report: an optional indent, words, a colon, then a space or
 * the end of the string — `Project health:`, `  manifests:`, `Cloudflare: `. Comments are stripped first,
 * so prose about a line never passes for the line. Template literals contribute the chunk before their
 * first `${`, which is exactly where a fixed label sits and where a computed one does not.
 *
 * Read statically rather than rendered, deliberately: a block only prints in the state that earns it, so
 * enumerating by rendering would cover whatever states the fixtures happen to build. The source knows the
 * whole set whether or not anything here exercises it.
 */
function rendererBlockLabels(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const literals = [/"((?:[^"\\\n]|\\.)*)"/g, /'((?:[^'\\\n]|\\.)*)'/g, /`((?:[^`\\$]|\\.)*)/g];
  const label = /^ {0,4}([A-Za-z][A-Za-z]*(?: [A-Za-z]+)*):(?:\s|$)/;
  const found = new Set<string>();
  for (const pattern of literals) {
    for (const match of code.matchAll(pattern)) {
      const hit = label.exec(match[1] ?? "");
      if (hit?.[1]) found.add(`${hit[1]}:`);
    }
  }
  return [...found].sort();
}

/**
 * The keys of every `--json` payload one command module writes that are visible where it is written.
 *
 * A payload built by spreading a typed object carries no key at the call site, so those sites contribute
 * nothing and are counted separately — a caller that treats an empty result as a clean pass would be
 * reporting on a file it could not read. Extracting them needs the type checker rather than a scan, and
 * that is the honest edge of this gate.
 */
function payloadKeys(source: string): { keys: string[] } {
  const keys = new Set<string>();
  for (const match of source.matchAll(/formatJsonLine\(\{([^{}]*)\}/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part.trim());
      if (name?.[1]) keys.add(name[1]);
    }
  }
  return { keys: [...keys].sort() };
}

describe("docs/CLI.md documents what the code emits", () => {
  /**
   * The gate #184's `manifests:` block walked straight past: three transcripts pinned, all three green,
   * and a whole block of the report named nowhere in the document that specifies the command.
   */
  test("§5.6 names every block label the renderer can print", () => {
    const labels = rendererBlockLabels(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "doctor.ts"), "utf8"),
    );
    expect(labels.length).toBeGreaterThan(10);
    expect(labels.filter((label) => !SECTION.includes(label))).toEqual([]);
  });

  /**
   * Every key of the `--json` payload is unconditional — a check with no project to run against reports
   * `null` rather than dropping its key — so one render enumerates the whole contract and the sample can
   * be compared against it as a set. Values are not compared: the payload's paths are absolute and
   * machine-specific, which is the one thing about it the document states in prose instead.
   */
  test("§5.6's --json sample carries exactly the keys the payload does", async () => {
    const report = await buildDoctorReport(docOptions(harness.healthyOptions()));
    const block = JSON_SAMPLES[0];
    if (block === undefined) throw new Error("docs/CLI.md §5.6 no longer pastes a `pithy doctor --json` sample.");
    const sample: unknown = JSON.parse(block.split("\n").slice(1).join("\n"));
    expect(Object.keys(sample as Record<string, unknown>).sort()).toEqual(Object.keys(renderDoctorJson(report)).sort());
  });

  /**
   * The gate #184's `manifestFaults` walked past, stated once for however many commands §5.7 speaks for.
   *
   * The section names its own commands — every `pithy <name> … --json` it puts in backticks — and the
   * source decides their keys. So documenting another command's payload there enrols it, and adding a
   * field to one already there fails until the prose names it. Nothing in this file lists a command.
   */
  test.each([["### 5.7 Project capability updates"], ["### 5.8 The `pithy adopt` command"]])(
    "%s names every --json field of every command it specifies",
    (heading) => {
      const body = section(heading);
      const commands = new Set([...body.matchAll(/`pithy ([a-z]+)[^`]*--json`/g)].map((match) => match[1] ?? ""));
      expect(commands.size).toBeGreaterThan(0);
      for (const command of commands) {
        const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), `${command}.ts`), "utf8");
        // A payload nothing can read is not a payload that passed. `add` also writes one built by spreading
        // a typed object, which contributes no key here and is not gated — the edge stated in the header.
        const { keys } = payloadKeys(source);
        expect(keys, `${command} writes no --json payload this scan can read`).not.toEqual([]);
        expect({ command, undocumented: keys.filter((key) => !body.includes(`\`${key}\``)) }).toEqual({
          command,
          undocumented: [],
        });
      }
    },
  );
});
