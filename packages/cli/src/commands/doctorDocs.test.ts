// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { doctorHarness, planStubPer, registryFetch, workerSet, zsh } from "../test-utils/doctorHarness";
import { buildDoctorReport, type DoctorReportOptions, renderDoctorText } from "./doctor";

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

const TRANSCRIPTS = fencedBlocks(section(HEADING));

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
    throw new Error(`docs/CLI.md §5.6 no longer has ${index + 1} fenced blocks — found ${TRANSCRIPTS.length}.`);
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
    runtime: BUN,
  };
}

describe("docs/CLI.md §5.6", () => {
  test("pastes exactly the three transcripts pinned below", () => {
    // A fourth would be an unpinned example free to rot — the state this suite exists to end.
    expect(TRANSCRIPTS).toHaveLength(3);
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
});
