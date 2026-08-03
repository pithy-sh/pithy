// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { d1SeedGroup, defineSeed, kvSeedGroup } from "@pithy-sh/core/src/seed/seed";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ResetPreviewEntry } from "../migrations/run";
import { buildDryRunPlan } from "../seed/plan";
import { buildSeedPlan } from "../seed/registry";
import type { SeedRunReport } from "../seed/run";
import { formatJsonLine } from "../terminal/output";
import { renderSeedText } from "./seed";

/**
 * `docs/CLI.md` §8.2 and §8.5 paste seven `pithy seed` transcripts, and CLAUDE.md makes that document
 * binding rather than advisory — an adopter reads those blocks to learn what a run looks like before they
 * dare one against staging. Nothing checked them, and they rotted in four separate ways at once: every
 * text block dropped the per-worker name column `describeWorker` prefixes each line with, the skip line
 * was capitalised where the code lowercases it, the `--dry-run` blocks omitted the `Done.` the command
 * still prints, the `--redo` block omitted the `DESTRUCTIVE.` banner that opens a real reset, and the
 * text blocks spelled a set key `leaderboard_0001_demo_board` while the adjacent `--json` block spelled
 * the same key `0001_leaderboard_demo_board`. `composeSeeds` settles that one: the key is
 * `NNNN_<capability>_<name>`, so the JSON was right and four text blocks were wrong.
 *
 * So the transcripts are tested like code, exactly as `doctorDocs.test.ts` tests §5.6's. `renderSeedText`
 * is a pure function of a `SeedRunReport`, which is the whole reason this is possible: each test builds
 * the report for **the scenario its transcript is illustrating**, renders it with the real renderer, and
 * asserts the document says exactly that. A fixture is never tuned to reproduce whatever the doc happens
 * to claim; when the two disagree, the doc is what changes.
 *
 * Every set key, row count, entry count, and `skippedByEnv` entry in those reports comes from the real
 * composer (`buildSeedPlan` → `buildDryRunPlan`) over real `defineCapability`/`defineSeed` fixtures — not
 * from a hand-typed literal — because the key format is precisely what drifted, and a literal would have
 * drifted with it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI_MD = readFileSync(join(REPO_ROOT, "docs", "CLI.md"), "utf8");

const OUTPUT = "### 8.2 Output";
const REDO = "### 8.5 Resetting data (`--redo`)";

/**
 * One section alone, up to the next heading. Scoped, because §8.3 pastes a refusal and §8.4 sits between
 * the two sections pinned here — a whole-file scan would pin whichever block happened to come first.
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

const OUTPUT_BLOCKS = fencedBlocks(section(OUTPUT));
const REDO_BLOCKS = fencedBlocks(section(REDO));

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
    throw new Error(`docs/CLI.md ${where} no longer has ${index + 1} fenced blocks — found ${blocks.length}.`);
  }
  const lines = block.split("\n");
  if (lines[0] !== prompt) {
    throw new Error(`docs/CLI.md ${where} transcript ${index + 1} opens with "${lines[0]}", expected "${prompt}".`);
  }
  return lines.slice(1).join("\n");
}

/** The leaderboard's board table — a type-only carrier for the fixture rows. */
const BoardEntry = z.object({
  id: z.number().int().describe("The entry's primary key."),
  score: z.number().int().describe("The entry's score."),
});

/** The auth users table — a type-only carrier for the fixture rows. */
const User = z.object({
  id: z.string().describe("The user's id."),
  email: z.string().describe("The user's email address."),
});

/** The auth sessions store — a type-only carrier for the fixture entry. */
const sessionsStore = {
  prefix: "session",
  key: z.object({ id: z.string().describe("The session id segment.") }),
  value: z.object({ userId: z.string().describe("The session's user.") }),
};

/** The twelve board rows the transcripts count. */
const BOARD_ROWS = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, score: 1200 - index * 25 }));

/** `leaderboard`, seeding its demo board into dev and staging. Order 200 — after `auth`, as in docs/SEED.md. */
function leaderboard(): Capability {
  return defineCapability({
    name: "leaderboard",
    requiredBindings: [],
    seeds: [
      defineSeed({
        name: "demo_board",
        order: 200,
        environments: ["dev", "staging"],
        d1: [d1SeedGroup("app", "boardEntries", BoardEntry, BOARD_ROWS)],
      }),
    ],
  });
}

/** `leaderboard` plus a prod-only smoke set — the set §8.2's skip transcript reports as refused. */
function leaderboardWithProdSmoke(): Capability {
  const base = leaderboard();
  return defineCapability({
    name: "leaderboard",
    requiredBindings: [],
    seeds: [
      ...(base.seeds ?? []),
      defineSeed({
        name: "prod_smoke",
        order: 210,
        environments: ["prod"],
        d1: [d1SeedGroup("app", "boardEntries", BoardEntry, BOARD_ROWS.slice(0, 1))],
      }),
    ],
  });
}

/** `auth`, seeding three users and one session — the two-backend line. Order 100: users seed first. */
function auth(): Capability {
  return defineCapability({
    name: "auth",
    requiredBindings: [],
    seeds: [
      defineSeed({
        name: "test_users",
        order: 100,
        environments: ["dev"],
        d1: [
          d1SeedGroup("app", "users", User, [
            { id: "u1", email: "ada@example.com" },
            { id: "u2", email: "grace@example.com" },
            { id: "u3", email: "alan@example.com" },
          ]),
        ],
        kv: [kvSeedGroup("sessions", "session", sessionsStore, [{ key: { id: "s1" }, value: { userId: "u1" } }])],
      }),
    ],
  });
}

/** `media`, whose avatar set declares no fixtures for this shape — the "nothing to seed" line. */
function media(): Capability {
  return defineCapability({
    name: "media",
    requiredBindings: [],
    seeds: [defineSeed({ name: "avatar", order: 300, environments: ["dev"] })],
  });
}

/** The one database every transcript's `--redo` resets: `app`, on `DB`, carrying one migration. */
const APP_RESET: ResetPreviewEntry = { database: "app", binding: "DB", migrations: 1 };

/**
 * The report one Worker's run produces, composed through the real registry.
 *
 * `buildDryRunPlan` supplies the sets for a real run too, and that is exact rather than convenient:
 * `seedD1Group` and `seedKvGroup` both report the number of rows/entries the fixture carries — the
 * writes are `INSERT OR IGNORE` and put-if-absent, so the count never depends on what was already
 * there. A real run over these fixtures reports these numbers.
 */
function report(options: {
  env: string;
  capabilities: Capability[];
  dryRun: boolean;
  worker?: string;
  reset?: ResetPreviewEntry[];
}): SeedRunReport {
  const composed = buildSeedPlan(options.capabilities, { env: options.env, includeExamples: false });
  const plan = buildDryRunPlan(options.env, composed.sets);
  return {
    command: "seed",
    env: options.env,
    dryRun: options.dryRun,
    workers: [
      {
        worker: options.worker ?? "api",
        sets: plan.sets,
        skippedByEnv: composed.skippedByEnv,
        shared: [],
      },
    ],
    ...(options.reset ? { reset: options.reset } : {}),
  };
}

describe("docs/CLI.md §8.2", () => {
  test("pastes exactly the five transcripts pinned below", () => {
    // A sixth would be an unpinned example free to rot — the state this suite exists to end.
    expect(OUTPUT_BLOCKS).toHaveLength(5);
  });

  /** The ordinary run: two capabilities' sets, one line each, `auth` first because its order is lower. */
  test("the normal run is what the renderer prints for a project with two seeded capabilities", () => {
    const rendered = renderSeedText(report({ env: "dev", capabilities: [auth(), leaderboard()], dryRun: false }));
    expect(transcript(OUTPUT_BLOCKS, "§8.2", 0, "$ pithy seed --env dev")).toBe(rendered);
  });

  /** A set that writes nothing still prints — the whole point of the line. */
  test("the quiet run is what the renderer prints for a set with no fixtures for this shape", () => {
    const rendered = renderSeedText(report({ env: "dev", capabilities: [media()], dryRun: false }));
    expect(transcript(OUTPUT_BLOCKS, "§8.2", 1, "$ pithy seed --env dev")).toBe(rendered);
  });

  /** A set the environment disallows is reported above the sets that ran, never silently dropped. */
  test("the skip line is what the renderer prints for a set this environment disallows", () => {
    const rendered = renderSeedText(report({ env: "dev", capabilities: [leaderboardWithProdSmoke()], dryRun: false }));
    expect(transcript(OUTPUT_BLOCKS, "§8.2", 2, "$ pithy seed --env dev")).toBe(rendered);
  });

  /** The dry run: the same per-set shape, the reminder, then `Done.` like every other run. */
  test("the dry run is what the renderer prints when nothing is written", () => {
    const rendered = renderSeedText(report({ env: "staging", capabilities: [leaderboard()], dryRun: true }));
    expect(transcript(OUTPUT_BLOCKS, "§8.2", 3, "$ pithy seed --env staging --dry-run")).toBe(rendered);
  });

  /** The `--json` line: the whole `SeedRunReport`, serialized by the one encoder the command uses. */
  test("the json line is what the command writes for a dry run", () => {
    const rendered = formatJsonLine({ ...report({ env: "dev", capabilities: [leaderboard()], dryRun: true }) });
    expect(transcript(OUTPUT_BLOCKS, "§8.2", 4, "$ pithy seed --env dev --dry-run --json")).toBe(rendered);
  });
});

describe("docs/CLI.md §8.5", () => {
  test("pastes exactly the two transcripts pinned below", () => {
    expect(REDO_BLOCKS).toHaveLength(2);
  });

  /** A real reset: the banner, the per-database line, then the ordinary seed report. */
  test("the reset run is what the renderer prints for --redo", () => {
    const rendered = renderSeedText(
      report({ env: "dev", capabilities: [leaderboard()], dryRun: false, reset: [APP_RESET] }),
    );
    expect(transcript(REDO_BLOCKS, "§8.5", 0, "$ pithy seed --env dev --redo")).toBe(rendered);
  });

  /** A previewed reset: `Would reset …`, and no banner, because nothing was dropped. */
  test("the reset preview is what the renderer prints for --redo --dry-run", () => {
    const rendered = renderSeedText(
      report({ env: "staging", capabilities: [leaderboard()], dryRun: true, reset: [APP_RESET] }),
    );
    expect(transcript(REDO_BLOCKS, "§8.5", 1, "$ pithy seed --env staging --redo --dry-run")).toBe(rendered);
  });
});
