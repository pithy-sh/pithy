// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clientById, DOCS_MCP_URL, MCP_CLIENTS, type McpClient, type Scope, scopesOf } from "../mcp/clients";
import { snippetFor, targetFor, targetsFor } from "../mcp/connect";
import { FIXTURES } from "../mcp/fixtures";
import type { HomeOptions, PathBase } from "../mcp/home";
import docs, { offerDocs } from "./docs";

/**
 * `pithy docs connect | disconnect | status`, exercised as the operator runs them.
 *
 * The writers each have their own suite over the fixture corpus, and `mcp/connect.ts` has its own over
 * the filesystem. What is left, and what is here, is the command: which flags refuse, which refuse
 * *before* anything is written, what the three columns say, and that the `--json` line is one line. So
 * every test below drives a subcommand's `run` with the arguments citty would have parsed, and asserts on
 * stdout, on stderr and on the bytes that ended up on disk.
 *
 * **Nothing here may touch the operator's own configuration.** These are ten files Pithy does not own,
 * and a test that resolved a real `~/.cursor/mcp.json` would not fail — it would quietly rewrite a
 * developer's editor. `mcp/home.ts` refuses the real home under vitest for exactly that reason, which is
 * the guard; every path below resolves under a `mkdtemp` home instead, and the project scope resolves
 * under a second one the run is `chdir`-ed into.
 *
 * **The home seam is injected through the module, because the command offers no other way in.**
 * `optionsOf()` in `docs.ts` builds `{ projectDir: process.cwd() }` and no `home`, so every user-scope
 * resolution would reach `homedir()` — which under vitest is the refusal, not the developer's home. The
 * mock below supplies `homedir` as the default and changes nothing else: the real resolver still decides
 * what XDG means on which platform, and a row's declared segments are still the ones joined on.
 */
vi.mock("../mcp/home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/home")>();
  const injected = (options?: HomeOptions): HomeOptions => ({ homedir: process.env.HOME, ...options });
  return {
    ...actual,
    baseDirectory: (base: PathBase, options?: HomeOptions) => actual.baseDirectory(base, injected(options)),
    resolveUnder: (path: { base: PathBase; segments: readonly string[] }, options?: HomeOptions) =>
      actual.resolveUnder(path, injected(options)),
  };
});

/**
 * The operator, scripted.
 *
 * `docs.ts` reaches `@clack/prompts` through a dynamic import at the point of use and offers no seam to
 * hand a prompter through, so the module itself is what a test replaces. Each prompt records the question
 * it put and answers with whatever the test queued — `cancel` included, which is the exact value
 * `isCancel` is mocked to recognize, so a cancellation test scripts the real thing rather than a flag
 * standing in for one.
 */
const prompt = vi.hoisted(() => ({
  /** Every question put to the operator, in the order they were asked. */
  asked: [] as string[],
  /** The choices each `select` offered — what proves the scope question names both scopes. */
  offered: [] as { value: string; label: string }[][],
  /** The sentinel a scripted cancellation answers with. */
  cancel: Symbol("clack.cancel") as unknown,
  /** What the next `confirm` answers. */
  confirm: undefined as unknown,
  /** What the next `select` answers. */
  select: undefined as unknown,
}));

vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => value === prompt.cancel,
  confirm: (options: { message: string }) => {
    prompt.asked.push(options.message);
    return Promise.resolve(prompt.confirm);
  },
  select: (options: { message: string; options: { value: string; label: string }[] }) => {
    prompt.asked.push(options.message);
    prompt.offered.push(options.options);
    return Promise.resolve(prompt.select);
  },
}));

/** The arguments a subcommand body reads, as citty would have handed them over. */
type Args = Record<string, unknown>;

/** The three subcommands, reached the way the dispatcher reaches them. */
const subCommands = docs.subCommands as unknown as Record<
  "connect" | "disconnect" | "status",
  { run: (context: { args: Args; rawArgs: string[] }) => Promise<void> }
>;

/** What one run said and how it ended. */
interface Run {
  /** Everything written to stdout, joined. */
  readonly out: string;
  /** Everything written to stderr, joined — where `withErrorReporting` renders a `PithyError`. */
  readonly err: string;
  /** The code passed to `process.exit`, or `undefined` when the command returned on its own. */
  readonly exitCode: number | undefined;
}

/** The sentinel a mocked `process.exit` throws, so a command that ends the process does not end the suite. */
class Exited extends Error {}

let home: string;
let project: string;
let savedHome: string | undefined;
let savedXdg: string | undefined;
let savedCwd: string;
let savedStdin: boolean | undefined;
let savedStdout: boolean | undefined;

/**
 * Run one piece of the command, capturing both streams and the exit.
 *
 * `process.exit` throws rather than returning, because the command's `--json` paths call it without
 * returning first — a spy that let execution fall through would print the human report after the JSON
 * line and make "exactly one line" untestable by construction.
 */
async function capture(work: () => Promise<void>): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const sink = (lines: string[]) =>
    ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as never;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(sink(out));
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(sink(err));
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Exited();
  }) as never);
  try {
    await work();
  } catch (error) {
    if (!(error instanceof Exited)) throw error;
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  }
  return { out: out.join(""), err: err.join(""), exitCode };
}

/** Run one subcommand, with the arguments citty would have parsed. */
async function run(sub: "connect" | "disconnect" | "status", args: Args = {}): Promise<Run> {
  return capture(() => subCommands[sub].run({ args: { json: false, all: false, print: false, ...args }, rawArgs: [] }));
}

/**
 * Put a human at the terminal, for the one thing that only happens when there is one.
 *
 * The suite's default is the opposite — see `beforeEach` — so a prompting test says so explicitly and
 * `afterEach` puts the real streams back either way.
 */
function attachTerminal(): void {
  (process.stdin as { isTTY?: boolean }).isTTY = true;
  (process.stdout as { isTTY?: boolean }).isTTY = true;
}

/** The registry row an id names, for a test that needs the client itself rather than its paths. */
function clientOf(id: string): McpClient {
  const client = clientById(id);
  if (client === undefined) throw new Error(`no client ${id}`);
  return client;
}

/** Put bytes no writer can read where a client keeps its configuration, so the run produces a real refusal. */
async function seedMalformed(id: string, scope: Scope): Promise<string> {
  const path = pathOf(id, scope);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ this is not a document any writer can read\n");
  return path;
}

/** The one line a `--json` run may write — asserted to be one, and handed back. */
function oneLine(out: string): string {
  const lines = out.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return lines[0] ?? "";
}

/** The file one client and scope names on this fake machine. */
function pathOf(id: string, scope: Scope): string {
  const client = clientById(id);
  if (client === undefined) throw new Error(`no client ${id}`);
  return targetFor(client, scope, { projectDir: project }).path;
}

/**
 * Put a client's realistic document where that client keeps it.
 *
 * The corpus rather than something invented here: each fixture already holds a server the adopter wrote,
 * and `survives` is the exact bytes of it — which is what every assertion below is really about.
 */
async function seed(id: string, scope: Scope): Promise<string> {
  const fixture = FIXTURES[id]?.[scope];
  if (fixture === undefined) throw new Error(`no fixture for ${id}/${scope}`);
  const path = pathOf(id, scope);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, fixture.document);
  return path;
}

/** The bytes the adopter's own server occupies in a client's fixture. */
function survives(id: string, scope: Scope): readonly string[] {
  const fixture = FIXTURES[id]?.[scope];
  if (fixture === undefined) throw new Error(`no fixture for ${id}/${scope}`);
  return fixture.survives;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pithy-docs-home-"));
  project = await mkdtemp(join(tmpdir(), "pithy-docs-project-"));
  savedHome = process.env.HOME;
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  // Zed and Goose resolve through XDG on both Unixes, so a developer who exports one would otherwise
  // have those two clients land outside the fake home entirely.
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  savedCwd = process.cwd();
  process.chdir(project);
  // The prompt path is a human being, and no test here is one. Both streams say so explicitly rather
  // than relying on how this suite happens to be invoked.
  savedStdin = process.stdin.isTTY;
  savedStdout = process.stdout.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = false;
  (process.stdout as { isTTY?: boolean }).isTTY = false;
  prompt.asked.length = 0;
  prompt.offered.length = 0;
  prompt.confirm = undefined;
  prompt.select = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  (process.stdin as { isTTY?: boolean }).isTTY = savedStdin;
  (process.stdout as { isTTY?: boolean }).isTTY = savedStdout;
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

/**
 * The guard the rest of this file rests on.
 *
 * Every assertion below is about a file, and each of them is worth nothing if the file is the
 * developer's own. So this asks the registry directly, once: no row, in either scope, resolves outside
 * the two directories this suite made — which is what fails first if the home seam is ever lost.
 */
test("every configuration this suite resolves is inside the throwaway home or project", () => {
  for (const client of MCP_CLIENTS) {
    for (const target of targetsFor(client, { projectDir: project })) {
      expect({ client: client.id, inside: target.path.startsWith(home) || target.path.startsWith(project) }).toEqual({
        client: client.id,
        inside: true,
      });
    }
  }
});

describe("pithy docs connect --print", () => {
  test("a named client prints its resolved path and its own snippet, and writes nothing", async () => {
    const { out, err, exitCode } = await run("connect", { print: true, client: "cursor", scope: "user" });
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    expect(out).toContain(`${pathOf("cursor", "user")}:`);
    expect(out).toContain(`"pithy"`);
    expect(out).toContain(DOCS_MCP_URL);
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(project)).toEqual([]);
  });

  test("with no client it prints the shape most of them take, and still writes nothing", async () => {
    const { out, err } = await run("connect", { print: true });
    expect(err).toBe("");
    expect(out).toContain("No client named, so this is the shape most of them take.");
    expect(out).toContain(`"mcpServers"`);
    expect(out).toContain(DOCS_MCP_URL);
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(project)).toEqual([]);
  });

  test("--json is one line carrying the command and what was printed", async () => {
    const { out, err } = await run("connect", { print: true, client: "cursor", scope: "user", json: true });
    expect(err).toBe("");
    const payload = JSON.parse(oneLine(out)) as { command: string; printed: Record<string, unknown> };
    expect(payload.command).toBe("docs connect");
    expect(payload.printed.client).toBe("cursor");
    expect(payload.printed.path).toBe(pathOf("cursor", "user"));
    expect(String(payload.printed.snippet)).toContain(DOCS_MCP_URL);
    expect(readdirSync(home)).toEqual([]);
  });
});

/**
 * The refusals, and the one property they share: nothing is on disk afterwards.
 *
 * `withErrorReporting` catches the `PithyError` these throw, renders the problem and action lines to
 * stderr and exits 1 — so a command test asserts on what the operator reads rather than on the throw.
 * The two lines are the payload's `message` and `action`, in that order.
 */
describe("pithy docs connect refuses before it writes", () => {
  test("a run that can ask nobody and was told no scope names the flag", async () => {
    const { out, err, exitCode } = await run("connect", { client: "cursor" });
    expect(err).toBe(
      "--scope is required when nothing can be asked.\n" +
        "Pass --scope project to commit it for the team, or --scope user for yourself.\n",
    );
    expect(out).toBe("");
    expect(exitCode).toBe(1);
    expect(existsSync(pathOf("cursor", "user"))).toBe(false);
  });

  test("an unknown client is refused with the ids there are", async () => {
    const { err, exitCode } = await run("connect", { client: "emacs", scope: "user" });
    expect(err).toContain("No client called emacs.");
    expect(err).toContain(
      "Pass one of: claude-code, cursor, vscode, gemini, claude-desktop, cline, zed, codex, goose, continue.",
    );
    expect(exitCode).toBe(1);
  });

  test("--client and --all together is a choice the operator has to make", async () => {
    const { err, exitCode } = await run("connect", { client: "cursor", all: true, scope: "user" });
    expect(err).toBe("Pass either --client or --all, not both.\nChoose one.\n");
    expect(exitCode).toBe(1);
  });

  test("a bare unattended run names the two flags that would have told it what to connect", async () => {
    const { err, exitCode } = await run("connect", { scope: "user" });
    expect(err).toBe("Name what to connect.\nPass --client <id> for one, or --all for every client detected here.\n");
    expect(exitCode).toBe(1);
  });

  test("a --scope that is neither scope is refused with both of them, on every path that reads the flag", async () => {
    const refusal =
      "--scope takes project or user, not everyone.\n" +
      "Pass --scope project to commit it for the team, or --scope user for yourself.\n";

    const connected = await run("connect", { client: "cursor", scope: "everyone" });
    expect(connected.err).toBe(refusal);
    expect(connected.exitCode).toBe(1);

    // `--print` writes nothing either way, so it would have been the easy one to leave unvalidated.
    const printed = await run("connect", { print: true, client: "cursor", scope: "everyone" });
    expect(printed.err).toBe(refusal);
    expect(printed.exitCode).toBe(1);
    expect(printed.out).toBe("");

    const removed = await run("disconnect", { client: "cursor", scope: "everyone" });
    expect(removed.err).toBe(refusal);
    expect(removed.exitCode).toBe(1);

    expect(existsSync(pathOf("cursor", "user"))).toBe(false);
  });
});

describe("pithy docs connect", () => {
  test("--all writes one row per detected client, and a second run changes nothing", async () => {
    await seed("cursor", "user");
    await seed("codex", "user");
    await seed("goose", "user");

    const first = await run("connect", { all: true, scope: "user" });
    expect(first.err).toBe("");
    expect(first.exitCode).toBeUndefined();

    const lines = first.out.trimEnd().split("\n");
    // Three clients in registry order, then the brand's full stop.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`Cursor     added  ${pathOf("cursor", "user")}`);
    expect(lines[1]).toBe(`Codex CLI  added  ${pathOf("codex", "user")}`);
    expect(lines[2]).toBe(`Goose      added  ${pathOf("goose", "user")}`);
    expect(lines[3]).toBe("Done.");

    const written: Record<string, string> = {};
    for (const id of ["cursor", "codex", "goose"]) {
      const contents = await readFile(pathOf(id, "user"), "utf8");
      written[id] = contents;
      expect(contents).toContain(DOCS_MCP_URL);
      for (const bytes of survives(id, "user")) expect(contents).toContain(bytes);
    }

    const second = await run("connect", { all: true, scope: "user" });
    const again = second.out.trimEnd().split("\n");
    expect(again.slice(0, 3).every((line) => line.includes("unchanged"))).toBe(true);
    expect(again[3]).toBe("Done.");
    for (const id of ["cursor", "codex", "goose"]) {
      expect(await readFile(pathOf(id, "user"), "utf8")).toBe(written[id]);
    }
  });

  test("a client that declares one scope takes it, whatever --scope asked for", async () => {
    await seed("goose", "user");
    const { out, err } = await run("connect", { client: "goose", scope: "project" });
    expect(err).toBe("");
    // Goose has no project configuration, so `--scope project` is a question with one answer.
    expect(out.trimEnd().split("\n")[0]).toBe(`Goose  added  ${pathOf("goose", "user")}`);
    const contents = await readFile(pathOf("goose", "user"), "utf8");
    expect(contents).toContain(DOCS_MCP_URL);
    for (const bytes of survives("goose", "user")) expect(contents).toContain(bytes);
    expect(existsSync(join(project, ".config"))).toBe(false);
  });

  test("--json is exactly one line, and carries one entry per client", async () => {
    await seed("cursor", "user");
    await seed("codex", "user");
    const { out, err, exitCode } = await run("connect", { all: true, scope: "user", json: true });
    expect(err).toBe("");
    expect(exitCode).toBe(0);
    const payload = JSON.parse(oneLine(out)) as {
      command: string;
      written: { client: string; scope: string; path: string; state: string; reason: string | null }[];
    };
    expect(payload.command).toBe("docs connect");
    expect(payload.written).toEqual([
      { client: "cursor", scope: "user", path: pathOf("cursor", "user"), state: "added", reason: null, snippet: null },
      { client: "codex", scope: "user", path: pathOf("codex", "user"), state: "added", reason: null, snippet: null },
    ]);
  });
});

describe("pithy docs disconnect", () => {
  test("removes the pithy entry and leaves the adopter's own server where it was", async () => {
    await seed("cursor", "user");
    await run("connect", { client: "cursor", scope: "user" });
    expect(await readFile(pathOf("cursor", "user"), "utf8")).toContain(DOCS_MCP_URL);

    const { out, err, exitCode } = await run("disconnect", { client: "cursor", scope: "user" });
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe(`Cursor  removed  ${pathOf("cursor", "user")}`);
    expect(lines[1]).toBe("Done.");

    const contents = await readFile(pathOf("cursor", "user"), "utf8");
    expect(contents).not.toContain(DOCS_MCP_URL);
    expect(contents).not.toContain(`"pithy"`);
    for (const bytes of survives("cursor", "user")) expect(contents).toContain(bytes);
  });

  test("--json is one line carrying the command and one entry per client", async () => {
    await seed("cursor", "user");
    await run("connect", { client: "cursor", scope: "user" });

    const { out, err, exitCode } = await run("disconnect", { client: "cursor", scope: "user", json: true });
    expect(err).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(oneLine(out))).toEqual({
      command: "docs disconnect",
      disconnected: [
        { client: "cursor", scope: "user", path: pathOf("cursor", "user"), state: "removed", reason: null },
      ],
    });
  });

  test("a machine running none of them is told so, and nothing is asked", async () => {
    const { out, err, exitCode } = await run("disconnect", { all: true, scope: "user" });
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    expect(out).toBe("No AI clients detected here.\n");
  });

  test("--json over nothing detected is a run that failed at nothing, so it exits 0", async () => {
    const { out, err, exitCode } = await run("disconnect", { all: true, scope: "user", json: true });
    expect(err).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(oneLine(out))).toEqual({ command: "docs disconnect", disconnected: [] });
  });

  test("--scope is required even when nothing is detected, so CI does not depend on the machine", async () => {
    // The same command must refuse the same way on a laptop with ten clients and a runner with none.
    // Deciding it on what happens to be installed is how a green CI step fails on somebody's desk.
    const { err, exitCode } = await run("disconnect", { all: true, json: true });
    expect(exitCode).toBe(1);
    expect(JSON.parse(err).error.message).toContain("--scope is required");
  });
});

describe("pithy docs status", () => {
  test("reports a client that is not here, and where a connected one is wired", async () => {
    await seed("cursor", "user");
    await run("connect", { client: "cursor", scope: "user" });

    const { out, err } = await run("status");
    expect(err).toBe("");
    const lines = out.trimEnd().split("\n");
    const lineFor = (label: string): string => {
      const line = lines.find((candidate) => candidate.startsWith(label));
      if (line === undefined) throw new Error(`no status line for ${label}`);
      return line;
    };
    expect(lineFor("Cursor")).toContain("connected: user");
    expect(lineFor("Zed")).toContain("not detected");
    expect(lineFor("Goose")).toContain("not detected");
  });

  test("--json is one line holding every client, with one entry per scope that client declares", async () => {
    const { out, err, exitCode } = await run("status", { json: true });
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();

    const payload = JSON.parse(oneLine(out)) as {
      command: string;
      clients: {
        client: string;
        label: string;
        detected: boolean;
        scopes: { scope: Scope; path: string; connected: boolean }[];
      }[];
    };
    expect(payload.command).toBe("docs status");
    expect(payload.clients.map((client) => client.client)).toEqual(MCP_CLIENTS.map((client) => client.id));

    // A client with no project configuration reports one line, not a second one about a file it has not
    // got — which is the one thing a reader of this list would otherwise have to know the registry to see.
    for (const client of MCP_CLIENTS) {
      const reported = payload.clients.find((candidate) => candidate.client === client.id);
      expect({ id: client.id, scopes: reported?.scopes.map((scope) => scope.scope) }).toEqual({
        id: client.id,
        scopes: [...scopesOf(client)],
      });
      expect(reported?.scopes.map((scope) => scope.path)).toEqual(
        scopesOf(client).map((scope) => pathOf(client.id, scope)),
      );
    }
  });
});

/**
 * The machine that runs none of them, which is most machines the first time.
 *
 * The fake home is empty, so no row's detection path resolves to anything — which is exactly the shape
 * `--all` has to answer for without writing a Zed configuration onto a machine with no Zed.
 */
describe("pithy docs connect with nothing detected", () => {
  test("says so, and names the flag that prints the snippet instead", async () => {
    const { out, err, exitCode } = await run("connect", { all: true, scope: "user" });
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    expect(out).toBe(
      "No AI clients detected here.\nRun `pithy docs connect --print` for the snippet to add by hand.\n",
    );
    expect(readdirSync(home)).toEqual([]);
  });

  test("--json says the same thing as an empty written list, on one line", async () => {
    const { out, err, exitCode } = await run("connect", { all: true, scope: "user", json: true });
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(oneLine(out))).toEqual({ command: "docs connect", written: [] });
  });
});

/**
 * A refusal is still an answer.
 *
 * Every refusal here is a real one: the document on disk is bytes no writer can read, so the reason in
 * the row comes from the writer that declined rather than from a test pretending one did.
 */
describe("pithy docs connect over a document it will not rewrite", () => {
  test("a refused client gets the snippet to paste, under the path to paste it into", async () => {
    const path = await seedMalformed("cursor", "user");

    const { out, err, exitCode } = await run("connect", { client: "cursor", scope: "user" });
    expect(err).toBe("");
    expect(exitCode).toBe(1);
    expect(out).toBe(
      `Cursor  refused  ${path} — The file is not valid JSON, so nothing was written.\n` +
        "\n" +
        `Add this to ${path} yourself:\n` +
        `${snippetFor(clientOf("cursor")).trimEnd()}\n`,
    );
  });

  test("a run where every client refused did nothing, so it does not say Done. and exits 1", async () => {
    await seedMalformed("cursor", "user");
    await seedMalformed("claude-code", "user");

    const { out, exitCode } = await run("connect", { all: true, scope: "user" });
    expect(out).not.toContain("Done.");
    expect(exitCode).toBe(1);
    expect(out).toContain(`Cursor       refused  ${pathOf("cursor", "user")}`);
    expect(out).toContain(`Claude Code  refused  ${pathOf("claude-code", "user")}`);
  });

  test("a run where one refused and one was written is a run that did something", async () => {
    await seedMalformed("cursor", "user");
    await seed("claude-code", "user");

    const { out, exitCode } = await run("connect", { all: true, scope: "user" });
    expect(exitCode).toBeUndefined();
    expect(out).toContain("refused");
    expect(out.trimEnd().endsWith("Done.")).toBe(true);
    expect(await readFile(pathOf("claude-code", "user"), "utf8")).toContain(DOCS_MCP_URL);
  });
});

/** The one question this command asks, and the two ways it ends. */
describe("the scope question a human is asked", () => {
  test("explains both scopes, offers both, and writes the one that was chosen", async () => {
    attachTerminal();
    prompt.select = "project";

    const { out, err, exitCode } = await run("connect", { client: "cursor" });
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    expect(out).toContain("A project file is committed and gives the docs to everyone on this repository.");
    expect(out).toContain("A user file follows you into every project you open.");
    expect(prompt.asked).toEqual(["Who is this for?"]);
    expect(prompt.offered[0]?.map((option) => option.value)).toEqual(["user", "project"]);

    expect(out).toContain(`Cursor  added  ${pathOf("cursor", "project")}`);
    expect(await readFile(pathOf("cursor", "project"), "utf8")).toContain(DOCS_MCP_URL);
    // The answer decided the file, so the scope that was not chosen has nothing in it.
    expect(existsSync(pathOf("cursor", "user"))).toBe(false);
  });

  test("a canceled question ends the run on stderr with exit 1, and writes nothing", async () => {
    attachTerminal();
    prompt.select = prompt.cancel;

    const { out, err, exitCode } = await run("connect", { client: "cursor" });
    expect(err).toBe("Canceled.\n");
    expect(exitCode).toBe(1);
    expect(out).not.toContain("Done.");
    expect(existsSync(pathOf("cursor", "project"))).toBe(false);
    expect(existsSync(pathOf("cursor", "user"))).toBe(false);
  });
});

/**
 * The offer `pithy init` makes at the end of a scaffold.
 *
 * `init` gates the call on a human at a terminal, so every test here attaches one — and the first of
 * them is the case that matters most, because an offer for tools the operator does not run is noise at
 * the end of the one command every adopter runs first.
 */
describe("the offer pithy init makes at the end", () => {
  test("says nothing at all on a machine running no AI client", async () => {
    attachTerminal();

    const { out, err } = await capture(() => offerDocs());
    expect(out).toBe("");
    expect(err).toBe("");
    expect(prompt.asked).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test("names what it found, and writes nothing when the operator says no", async () => {
    attachTerminal();
    const path = await seed("cursor", "user");
    const before = await readFile(path, "utf8");
    prompt.confirm = false;

    const { out, err } = await capture(() => offerDocs());
    expect(err).toBe("");
    expect(out).toBe("");
    expect(prompt.asked).toEqual(["Give your AI agent the Pithy docs? Found Cursor."]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("writes nothing when the operator cancels the offer instead of answering it", async () => {
    attachTerminal();
    const path = await seed("cursor", "user");
    const before = await readFile(path, "utf8");
    prompt.confirm = prompt.cancel;

    const { out, err } = await capture(() => offerDocs());
    expect(err).toBe("");
    expect(out).toBe("");
    expect(prompt.asked).toEqual(["Give your AI agent the Pithy docs? Found Cursor."]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("canceling the scope question declines the offer — it never fails the init that asked", async () => {
    // `init` has already scaffolded the project and printed `Done.` by the time this runs. Escaping an
    // optional question must not turn that successful run into exit 1, which is what a shared
    // `process.exit` on cancel did. The subcommands still end on a cancel; the offer does not.
    attachTerminal();
    const path = await seed("cursor", "user");
    const before = await readFile(path, "utf8");
    prompt.confirm = true;
    prompt.select = prompt.cancel;

    const { err, exitCode } = await capture(() => offerDocs());
    expect(exitCode).toBeUndefined();
    expect(err).toBe("");
    expect(prompt.asked).toEqual(["Give your AI agent the Pithy docs? Found Cursor.", "Who is this for?"]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("on yes it asks the scope question, writes, and prints the report", async () => {
    attachTerminal();
    await seed("cursor", "user");
    prompt.confirm = true;
    prompt.select = "user";

    const { out, err } = await capture(() => offerDocs());
    expect(err).toBe("");
    expect(prompt.asked).toEqual(["Give your AI agent the Pithy docs? Found Cursor.", "Who is this for?"]);
    expect(out.trimEnd().endsWith(`Cursor  added  ${pathOf("cursor", "user")}`)).toBe(true);

    const contents = await readFile(pathOf("cursor", "user"), "utf8");
    expect(contents).toContain(DOCS_MCP_URL);
    for (const bytes of survives("cursor", "user")) expect(contents).toContain(bytes);
  });
});

/** The two paths left: a bare run that has somebody to ask, and a removal that could not read the file. */
describe("pithy docs at a terminal, with no flag naming a client", () => {
  test("a bare connect acts on every client it detected", async () => {
    attachTerminal();
    await seed("cursor", "user");
    prompt.select = "user";

    const { out, err, exitCode } = await run("connect", {});
    expect(err).toBe("");
    expect(exitCode).toBeUndefined();
    expect(out).toContain(`Cursor  added  ${pathOf("cursor", "user")}`);
    expect(out.trimEnd().endsWith("Done.")).toBe(true);
  });

  test("a disconnect where every client refused does not say Done. either, and exits 1", async () => {
    const path = await seedMalformed("cursor", "user");

    const { out, exitCode } = await run("disconnect", { client: "cursor", scope: "user" });
    expect(exitCode).toBe(1);
    expect(out).toBe(`Cursor  refused  ${path} — The file is not valid JSON, so nothing was written.\n`);
  });
});
