// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withContract } from "../contract/commandContract";
import { complete, renderCandidates, runComplete, splitLine } from "./complete";
import type { Candidate, ValueSources } from "./values";

/**
 * **`pithy __complete` answers a Tab from the tree the binary dispatches on (#765)**, walked as far as the
 * typed words reach and no further. Most cases hand it a small tree of their own, so the point is the walk
 * rather than the CLI's contents; `completeReal.test.ts` asks the real one.
 */

/** Every loader the tree below was asked for, in order. A loader not in here was never imported. */
let loaded: string[] = [];

/** A thunk that records being called, standing in for a lazily imported command module. */
function lazy<T extends ArgsDef>(name: string, cmd: CommandDef<T>): () => Promise<CommandDef<T>> {
  return async () => {
    loaded.push(name);
    return cmd;
  };
}

const create = defineCommand({
  meta: { name: "create", description: "Make one" },
  args: {
    name: { type: "positional", required: true, description: "The name" },
    env: { type: "string", default: "dev", description: "Target environment" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: () => undefined,
});

const tree: CommandDef = defineCommand({
  meta: { name: "pithy", version: "9.9.9" },
  subCommands: {
    secrets: lazy(
      "secrets",
      defineCommand({
        meta: { name: "secrets", description: "Secrets" },
        subCommands: {
          create,
          rm: defineCommand({ meta: { name: "rm", description: "Remove one" }, run: () => undefined }),
          hush: defineCommand({ meta: { name: "hush", description: "Hidden", hidden: true }, run: () => undefined }),
        },
      }),
    ),
    dev: lazy(
      "dev",
      defineCommand({
        meta: { name: "dev", description: "Run locally" },
        args: {
          app: { type: "string", description: "Start only this worker" },
          tui: { type: "boolean", default: true, description: "Draw the roster" },
          mode: { type: "string", description: "How" },
        },
        subCommands: {
          logs: defineCommand({ meta: { name: "logs", description: "Read the logs" }, run: () => undefined }),
        },
        run: () => undefined,
      }),
    ),
    add: lazy(
      "add",
      defineCommand({
        meta: { name: "add", description: "Add a capability" },
        args: {
          capability: { type: "positional", required: false, description: "Capability name" },
          worker: { type: "string", description: "Which worker" },
        },
        run: () => undefined,
      }),
    ),
    shape: lazy(
      "shape",
      withContract(
        defineCommand({
          meta: { name: "shape", description: "Pick a shape" },
          args: { kind: { type: "string", description: "Which kind" } },
          run: () => undefined,
        }),
        {
          output: "none",
          mutates: false,
          idempotent: true,
          needsNetwork: false,
          flags: { kind: { enum: ["a", "b"] } },
        },
      ),
    ),
  },
});

/** Sources that answer from fixed lists, so nothing here reads a disk or a repository. */
const sources: ValueSources = {
  environments: () => ["dev", "staging", "prod"],
  capabilities: () => [
    { value: "auth", description: "Sign-in" },
    { value: "audit", description: "A log" },
  ],
  workers: async () => ["api", "web"],
  featureBranches: async () => ["feature/12-thing"],
};

/** The values alone, for the cases where descriptions are not the point. */
async function values(line: string): Promise<string[]> {
  return (await complete(tree, line, { cwd: "/nowhere", sources })).map((candidate) => candidate.value);
}

afterEach(() => {
  loaded = [];
  vi.restoreAllMocks();
});

describe("splitLine", () => {
  test("drops the command word and keeps the word under the cursor last", () => {
    expect(splitLine("pithy secrets cr")).toEqual({ words: ["secrets"], current: "cr" });
  });

  test("a trailing space starts a new, empty word", () => {
    expect(splitLine("pithy secrets ")).toEqual({ words: ["secrets"], current: "" });
  });

  test("whatever the command was called, it is dropped: p., a path, nothing", () => {
    expect(splitLine("p. dev --")).toEqual({ words: ["dev"], current: "--" });
    expect(splitLine("/usr/local/bin/pithy ")).toEqual({ words: [], current: "" });
    expect(splitLine("")).toEqual({ words: [], current: "" });
  });
});

describe("commands", () => {
  test("the root offers every top-level command in the order it declares them, and loads none of them", async () => {
    expect(await values("pithy ")).toEqual(["secrets", "dev", "add", "shape"]);
    expect(loaded).toEqual([]);
  });

  test("a prefix narrows the offer", async () => {
    expect(await values("pithy se")).toEqual(["secrets"]);
  });

  test("a group offers its subcommands with their descriptions, and only its own module is loaded", async () => {
    const candidates = await complete(tree, "pithy secrets ", { cwd: "/nowhere", sources });
    expect(candidates).toEqual([
      { value: "create", description: "Make one" },
      { value: "rm", description: "Remove one" },
    ]);
    expect(loaded).toEqual(["secrets"]);
  });

  test("a hidden command is never offered", async () => {
    expect(await values("pithy secrets h")).toEqual([]);
  });

  test("a word the tree does not have completes nothing, and loads nothing past it", async () => {
    expect(await values("pithy nonsense ")).toEqual([]);
    expect(loaded).toEqual([]);
  });

  test("an inherited name is not a command", async () => {
    expect(await values("pithy constructor ")).toEqual([]);
    expect(await values("pithy valueOf --")).toEqual([]);
  });

  test("a command with its own run and subcommands offers the subcommands", async () => {
    expect(await values("pithy dev ")).toEqual(["logs"]);
  });

  test("a flag's value is skipped on the way down, the way citty skips it", async () => {
    expect(await values("pithy dev --app api l")).toEqual(["logs"]);
    expect(loaded).toEqual(["dev"]);
  });
});

describe("flags", () => {
  test("a dash offers the command's flags and the flags every command takes", async () => {
    expect(await values("pithy secrets create --")).toEqual([
      "--env",
      "--json",
      "--help",
      "--version",
      "--pretty",
      "--no-pretty",
      "--no-input",
    ]);
  });

  test("the flags carry their descriptions", async () => {
    const candidates = await complete(tree, "pithy secrets create --e", { cwd: "/nowhere", sources });
    expect(candidates).toEqual([{ value: "--env", description: "Target environment" }]);
  });

  test("a flag already typed is not offered again", async () => {
    expect(await values("pithy secrets create --json --j")).toEqual([]);
  });

  test("a group with no flags of its own still offers the ones every command takes", async () => {
    expect(await values("pithy secrets --")).toEqual(["--help", "--version", "--pretty", "--no-pretty", "--no-input"]);
  });

  test("after `--` nothing is a flag", async () => {
    expect(await values("pithy secrets create -- --")).toEqual([]);
  });
});

describe("values", () => {
  test("--env offers the environments", async () => {
    expect(await values("pithy secrets create --env ")).toEqual(["dev", "staging", "prod"]);
    expect(await values("pithy secrets create --env st")).toEqual(["staging"]);
  });

  test("--env= completes in the joined spelling", async () => {
    expect(await values("pithy secrets create --env=p")).toEqual(["--env=prod"]);
  });

  test("--worker and --app offer the project's Workers", async () => {
    expect(await values("pithy add --worker ")).toEqual(["api", "web"]);
    expect(await values("pithy dev --app w")).toEqual(["web"]);
  });

  test("a flag with a fixed set offers that set", async () => {
    expect(await values("pithy shape --kind ")).toEqual(["a", "b"]);
  });

  test("a string flag with no known values completes nothing", async () => {
    expect(await values("pithy dev --mode ")).toEqual([]);
  });

  test("a boolean takes no value, so the next word is a command again", async () => {
    expect(await values("pithy dev --tui l")).toEqual(["logs"]);
  });

  test("add offers the capabilities, with why each is enabled", async () => {
    const candidates = await complete(tree, "pithy add a", { cwd: "/nowhere", sources });
    expect(candidates).toEqual([
      { value: "auth", description: "Sign-in" },
      { value: "audit", description: "A log" },
    ]);
  });

  test("a positional already given is not completed again", async () => {
    expect(await values("pithy add auth ")).toEqual([]);
  });

  test("a positional with no known values completes nothing", async () => {
    expect(await values("pithy secrets create ")).toEqual([]);
  });
});

describe("renderCandidates", () => {
  test("one line per candidate, a tab before a description, none when there is none", () => {
    const candidates: Candidate[] = [
      { value: "dev", description: "Run locally" },
      { value: "staging", description: "" },
    ];
    expect(renderCandidates(candidates)).toBe("dev\tRun locally\nstaging\n");
  });

  test("a newline or tab inside a description cannot break the line", () => {
    expect(renderCandidates([{ value: "x", description: "one\ntwo\tthree" }])).toBe("x\tone two three\n");
  });

  test("no candidates is no output at all", () => {
    expect(renderCandidates([])).toBe("");
  });
});

describe("runComplete", () => {
  /** What one run wrote to each stream. */
  async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
    let out = "";
    let err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    await fn();
    return { out, err };
  }

  test("takes the line as one argument, or as words", async () => {
    // The root's members are still behind their thunks, so they are offered by name alone.
    expect((await capture(() => runComplete(tree, ["pithy se"], { sources }))).out).toBe("secrets\n");
    expect((await capture(() => runComplete(tree, ["pithy", "dev", ""], { sources }))).out).toBe(
      "logs\tRead the logs\n",
    );
  });

  test("a failure anywhere completes nothing and prints nothing", async () => {
    const broken: CommandDef = defineCommand({
      meta: { name: "pithy" },
      subCommands: {
        boom: async () => {
          throw new Error("a module that will not load");
        },
      },
    });
    const { out, err } = await capture(() => runComplete(broken, ["pithy boom "], { sources }));
    expect(out).toBe("");
    expect(err).toBe("");
  });

  test("a source that throws completes nothing and prints nothing", async () => {
    const failing: ValueSources = {
      ...sources,
      workers: async () => {
        throw new Error("no disk");
      },
    };
    const { out, err } = await capture(() => runComplete(tree, ["pithy add --worker "], { sources: failing }));
    expect(out).toBe("");
    expect(err).toBe("");
  });
});
