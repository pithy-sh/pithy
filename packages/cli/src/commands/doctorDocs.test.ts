// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 * `docs/commands/doctor.md` pastes three `pithy doctor` transcripts, and CLAUDE.md makes the CLI reference
 * binding rather than advisory — an adopter reads those blocks to learn what each state looks like, and a
 * reviewer reads them to decide whether an output change is a regression. Nothing checked them, and they
 * rotted: they showed a `Node: 22.10.0` line the renderer stopped printing and omitted the `Cloudflare:`
 * line it had started printing, both for as long as it took someone to notice by eye.
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
 * The page was `docs/CLI.md` §5.6 until #223 split the reference one page per command. Nothing about the
 * pins changed with it: they were always scoped to one section's fenced blocks, and a page is a section
 * with a file around it.
 *
 * ## Why pinning the transcripts is not enough on its own
 *
 * A transcript pin holds the examples that exist. It says nothing about a block, or a `--json` field, that
 * no example happens to show — so `doctor`'s `manifests:` block and `add`/`upgrade`'s `manifestFaults`
 * field both landed undocumented with every pin green, within a week of each other (#184, #186). The pins
 * were never wrong; they were answering a narrower question than the one anyone was asking of them.
 *
 * So the gates below ask the wider one, each derived from the code rather than from a list kept here:
 *
 * - **Every block label the renderer can print is named on `doctor.md`.** Read out of `doctor.ts` itself,
 *   so a block added tomorrow is covered without this file being touched.
 * - **`doctor.md`'s `--json` sample carries exactly the keys `renderDoctorJson` emits.** Every key of that
 *   payload is unconditional — absent findings are `null`, never missing — so one render enumerates the
 *   whole contract, and a new field fails the comparison.
 * - **A command page that specifies `--json` specifies it completely.** One page per command, one command
 *   module per page: the page's name picks the source, and the source decides the keys.
 * - **Every command has a page.** The ratchet #186 could not express, closed by #223.
 *
 * **Enrolment is what triggers the third one, and that is deliberate.** #186 enrolled a section by having it
 * mention a command; #223 enrols a command by giving it a page, which is the same property with a filename
 * instead of a sentence. A page that half-describes a payload is how an adopter learns three fields of five
 * and discovers the rest from a stack trace, so partial is the state worth failing — while a command with no
 * page at all is not failed by this gate, and was not, right up until the last page landed. The backlog
 * shrank as pages did.
 *
 * ## What the scan cannot read, named rather than implied
 *
 * A payload assembled by spreading a typed object — `formatJsonLine({ command, ...result })` — carries no
 * key at the call site. Thirty of this CLI's sixty-five `--json` sites are that shape, and enumerating them
 * needs the type checker rather than a scan. The gate reads what is written literally and holds a page to
 * that; it never claims to have read the rest. Which commands are in that state is not a sentence here that
 * can rot — it is `SPREAD_BUILT`, `UNPARSED_SITES` and `NO_READABLE_PAYLOAD` below, each asserted against
 * the scan, so a command that changes shape fails until the list agrees with it again.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const DOCS = join(REPO_ROOT, "docs");
const CLI_MD = readFileSync(join(DOCS, "CLI.md"), "utf8");
const PAGE = readFileSync(join(DOCS, "commands", "doctor.md"), "utf8");

/**
 * One section of a document, up to the next heading of the same depth or shallower.
 *
 * Scoped, because a page's `## What it does`, its `## --json` and its `## Examples` each paste blocks that
 * are pinned differently, and a whole-file scan would pin whichever happened to come first. The depth rule
 * is what lets a `##` section carry `###` subsections without being cut short at the first one.
 */
function section(markdown: string, heading: string, where: string): string {
  const start = markdown.indexOf(heading);
  if (start === -1) throw new Error(`${where} no longer has a "${heading}" section. Repin or restore it.`);
  const depth = (/^#+/.exec(heading)?.[0] ?? "##").length;
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${depth}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The fenced blocks of a markdown section, in document order, each without its fences or trailing newline. */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((match) => (match[1] ?? "").replace(/\n$/, ""));
}

const WHERE = "docs/commands/doctor.md";
const WHAT_IT_DOES = section(PAGE, "## What it does", WHERE);
const JSON_SECTION = section(PAGE, "## `--json`", WHERE);
const EXAMPLES = section(PAGE, "## Examples", WHERE);

/**
 * The page's fenced blocks, split by the section that holds them, because each class is pinned differently.
 *
 * `What it does` opens with the whole report — pinned byte for byte — and follows it with three
 * **fragments**: a few lines lifted out of one block to illustrate a state, pinned with `toContain` against
 * a report built for that state. `Examples` holds the other two whole transcripts. The `--json` section
 * holds one sample, pinned on its keys instead of its bytes, since its paths are absolute and machine-
 * specific.
 *
 * Every count is asserted below, the page's included. A block that lands in no class, a fourth transcript,
 * or a second `--json` sample is an example free to rot — the state this suite exists to end.
 */
const WHAT_BLOCKS = fencedBlocks(WHAT_IT_DOES);
const JSON_SAMPLES = fencedBlocks(JSON_SECTION);
const EXAMPLE_BLOCKS = fencedBlocks(EXAMPLES);
const FRAGMENTS = WHAT_BLOCKS.slice(1);

/**
 * One transcript's output, with the `$ …` prompt line the renderer does not emit stripped off.
 *
 * Every miss throws rather than returning something empty that would compare equal to nothing. A pin that
 * quietly stops matching is worse than no pin at all: the block it guards can then be reworded into a
 * report the CLI never prints, and the suite stays green while the document lies.
 */
function transcript(blocks: string[], where: string, index: number, prompt: string): string {
  const block = blocks[index];
  if (block === undefined) {
    throw new Error(`${WHERE} ${where} no longer has ${index + 1} fenced blocks — found ${blocks.length}.`);
  }
  const lines = block.split("\n");
  if (lines[0] !== prompt) {
    throw new Error(`${WHERE} ${where} transcript ${index + 1} opens with "${lines[0]}", expected "${prompt}".`);
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

describe("docs/commands/doctor.md", () => {
  test("pastes exactly the blocks pinned below, and nothing else", () => {
    // An unclassified block, a fourth transcript, or a second sample would be an unpinned example. The
    // page total counts the synopsis too, so a worked example added anywhere lands in one of these.
    expect(WHAT_BLOCKS).toHaveLength(4);
    expect(EXAMPLE_BLOCKS).toHaveLength(2);
    expect(JSON_SAMPLES).toHaveLength(1);
    expect(fencedBlocks(PAGE)).toHaveLength(WHAT_BLOCKS.length + EXAMPLE_BLOCKS.length + JSON_SAMPLES.length + 1);
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
    expect(transcript(WHAT_BLOCKS, "What it does", 0, "$ pithy doctor")).toBe(renderDoctorText(report, harness.dir));
  });

  /** The terse report: nothing to say, so the config, health, Cloudflare, and name blocks are all absent. */
  test("the up-to-date report is what the renderer prints when everything passes", async () => {
    const report = await buildDoctorReport(docOptions(harness.healthyOptions()));
    expect(transcript(EXAMPLE_BLOCKS, "Examples", 0, "$ pithy doctor")).toBe(renderDoctorText(report, harness.dir));
  });

  /**
   * Outside a project: the `Project:` line states the one fact and every other project line is gone,
   * `Project name:` included. `loadProject: undefined` puts the real loader against the empty temp
   * directory, so the transcript is pinned to the loader's own verdict rather than to a stubbed refusal.
   */
  test("the outside-a-project report is what the renderer prints where there is no config", async () => {
    const report = await buildDoctorReport(docOptions(harness.healthyOptions({ loadProject: undefined })));
    expect(transcript(EXAMPLE_BLOCKS, "Examples", 1, "$ cd /tmp && pithy doctor")).toBe(
      renderDoctorText(report, harness.dir),
    );
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
    if (fragment === undefined) throw new Error(`${WHERE} no longer pastes the Project health fragment.`);
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
    if (fragment === undefined) throw new Error(`${WHERE} no longer pastes the unknown-alias fragment.`);
    expect(renderDoctorText(report, harness.dir)).toContain(fragment);
  });

  /**
   * The offline fragment (#218), pinned against a report that refused the network.
   *
   * Three of this report's lines change wording in that mode and none of them is reachable by a fixture
   * that merely fails a fetch — "skipped" and "unreachable" are different sentences about different
   * events, and the whole point of the mode is that the document is where somebody learns which one they
   * are looking at. The real probe runs here rather than the harness stub: what is being pinned is that
   * `not checked` is what comes back, not that a stub can be made to say it.
   */
  test("the offline fragment is what the renderer prints when the caller refused the network", async () => {
    const report = await buildDoctorReport(
      docOptions(
        harness.healthyOptions({
          offline: true,
          checkCloudflare: undefined,
          fetch: (async () => {
            throw new Error("nothing may reach the network in this mode");
          }) as unknown as DoctorReportOptions["fetch"],
        }),
      ),
    );
    const fragment = FRAGMENTS[2];
    if (fragment === undefined) throw new Error(`${WHERE} no longer pastes the offline fragment.`);
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
 * Three things this cannot read, counted rather than glossed. A payload built by **spreading** a typed
 * object carries no key at the call site. A site whose argument the object pattern cannot parse — a nested
 * object, a template placeholder — contributes nothing either. And a site handed a bare identifier or a
 * renderer's return value is opaque by construction. Extracting any of them needs the type checker rather
 * than a scan, and that is the honest edge of this gate: `keys` is a floor, never a contract, and a caller
 * that treated an empty one as a clean pass would be reporting on a file it could not read.
 */
function payloadKeys(source: string): { keys: string[]; spreadSites: number; unparsedSites: number } {
  const keys = new Set<string>();
  const sites = [...source.matchAll(/formatJsonLine\(\{([^{}]*)\}/g)];
  for (const site of sites) {
    for (const part of (site[1] ?? "").split(",")) {
      const name = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part.trim());
      if (name?.[1]) keys.add(name[1]);
    }
  }
  return {
    keys: [...keys].sort(),
    spreadSites: sites.filter((site) => (site[1] ?? "").includes("...")).length,
    unparsedSites: [...source.matchAll(/formatJsonLine\(/g)].length - sites.length,
  };
}

/** Every command the CLI ships, read from the modules rather than from a list kept here. */
const COMMANDS = readdirSync(HERE)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => file.slice(0, -3))
  .sort();

const pageFor = (command: string): string => join(DOCS, "commands", `${command}.md`);
const sourceFor = (command: string): string => readFileSync(join(HERE, `${command}.ts`), "utf8");

/**
 * Commands whose `--json` payload this scan reads nothing of.
 *
 * `alias` and `doctor` hand `formatJsonLine` a value rather than an object literal — a prepared payload, and
 * a renderer's return. `remove` writes no payload at all: it is the one command that **rejects** `--json`,
 * because a destructive interactive command has no headless path (`docs/CLI.md` §1.2). None of the three is
 * gated below, and `doctor.md` is not left uncovered by that — the sample-versus-payload gate above is
 * stricter than the key scan could ever be.
 */
const NO_READABLE_PAYLOAD = ["alias", "doctor", "remove"];

/**
 * Commands with at least one payload assembled by spreading a typed object. Thirty sites across these,
 * which is where the number in this file's header comes from. Their pages are held to the keys written
 * literally beside the spread — a floor — and nothing here claims the rest was checked.
 */
const SPREAD_BUILT = [
  "add",
  "dashboard",
  "email",
  "env",
  "feature",
  "media",
  "migrate",
  "seed",
  "storage",
  "support",
  "token",
  "turnstile",
  "ui",
  "vector",
  "worker",
];

/** Commands with a site the object pattern cannot parse: a nested object, a template placeholder, a value. */
const UNPARSED_SITES = ["alias", "doctor", "secrets", "testers"];

describe("the docs say what the code emits", () => {
  /**
   * The gate #184's `manifests:` block walked straight past: three transcripts pinned, all three green,
   * and a whole block of the report named nowhere in the document that specifies the command.
   */
  test("doctor.md names every block label the renderer can print", () => {
    const labels = rendererBlockLabels(readFileSync(join(HERE, "doctor.ts"), "utf8"));
    expect(labels.length).toBeGreaterThan(10);
    expect(labels.filter((label) => !PAGE.includes(label))).toEqual([]);
  });

  /**
   * Every key of the `--json` payload is unconditional — a check with no project to run against reports
   * `null` rather than dropping its key — so one render enumerates the whole contract and the sample can
   * be compared against it as a set. Values are not compared: the payload's paths are absolute and
   * machine-specific, which is the one thing about it the document states in prose instead.
   */
  test("doctor.md's --json sample carries exactly the keys the payload does", async () => {
    const report = await buildDoctorReport(docOptions(harness.healthyOptions()));
    const block = JSON_SAMPLES[0];
    if (block === undefined) throw new Error(`${WHERE} no longer pastes a \`pithy doctor --json\` sample.`);
    const sample: unknown = JSON.parse(block.split("\n").slice(1).join("\n"));
    expect(Object.keys(sample as Record<string, unknown>).sort()).toEqual(Object.keys(renderDoctorJson(report)).sort());
  });

  /**
   * The ratchet #186 named and could not close: it enrolled a *section* by having it mention a command, so
   * a command nobody had written about was free. One page per command makes the enrolment a filename, and a
   * filename can be required. Every command module has a page, and this is what says so.
   *
   * A new command therefore lands with its page or fails here, which is the point: the reference is
   * published, and "we will document it later" is the state that produced #184 and #186 in one week.
   */
  test("every command has a page", () => {
    expect(COMMANDS.filter((command) => !existsSync(pageFor(command)))).toEqual([]);
    expect(COMMANDS.length).toBeGreaterThan(20);
  });

  /**
   * What the scan can and cannot read, asserted rather than described, so this file's honesty cannot rot
   * into a stale sentence. A command that stops spreading its payload — or starts — fails here until the
   * lists agree with it, and whoever updates one is standing in front of the paragraph that explains why.
   */
  test("the scan's blind spots are exactly the ones this file names", () => {
    const scanned = COMMANDS.map((command) => [command, payloadKeys(sourceFor(command))] as const);
    expect(scanned.filter(([, read]) => read.keys.length === 0).map(([command]) => command)).toEqual(
      NO_READABLE_PAYLOAD,
    );
    expect(scanned.filter(([, read]) => read.spreadSites > 0).map(([command]) => command)).toEqual(SPREAD_BUILT);
    expect(scanned.filter(([, read]) => read.unparsedSites > 0).map(([command]) => command)).toEqual(UNPARSED_SITES);
    expect(scanned.reduce((total, [, read]) => total + read.spreadSites, 0)).toBe(30);
  });

  /**
   * The gate #184's `manifestFaults` walked past, now asked of every page at once.
   *
   * The page's name picks the command module; the module decides the keys. So a field added to a payload
   * fails until its page names it, and a page that specifies a payload specifies all of it. Nothing in this
   * file lists a key.
   */
  const GATED = COMMANDS.filter(
    (command) => existsSync(pageFor(command)) && payloadKeys(sourceFor(command)).keys.length > 0,
  );

  test("the pages under gate are the pages that exist", () => {
    // A guard on the list above: an empty `test.each` runs nothing and reports nothing, which is the one
    // way this whole describe block could go quiet without anybody deleting a line of it.
    expect(GATED).toEqual(COMMANDS.filter((command) => !NO_READABLE_PAYLOAD.includes(command)));
  });

  test.each(GATED)("docs/commands/%s.md names every --json key written at its call sites", (command) => {
    const { keys } = payloadKeys(sourceFor(command));
    const body = readFileSync(pageFor(command), "utf8");
    expect({ command, undocumented: keys.filter((key) => !body.includes(`\`${key}\``)) }).toEqual({
      command,
      undocumented: [],
    });
  });

  /**
   * §5.7 stays in `docs/CLI.md`: it specifies the *distinction* between a CLI update and a capability
   * update, which is one command's business no more than the flag conventions are. It keeps #186's own
   * enrolment rule — the section names its own commands, every `pithy <name> … --json` it puts in backticks
   * — so a payload it half-describes fails here exactly as it did before the split.
   */
  test("docs/CLI.md §5.7 names every --json field of every command it specifies", () => {
    const body = section(CLI_MD, "### 5.7 Project capability updates", "docs/CLI.md");
    const commands = new Set([...body.matchAll(/`pithy ([a-z]+)[^`]*--json`/g)].map((match) => match[1] ?? ""));
    expect(commands.size).toBeGreaterThan(0);
    for (const command of commands) {
      const { keys } = payloadKeys(sourceFor(command));
      expect(keys, `${command} writes no --json payload this scan can read`).not.toEqual([]);
      expect({ command, undocumented: keys.filter((key) => !body.includes(`\`${key}\``)) }).toEqual({
        command,
        undocumented: [],
      });
    }
  });
});
