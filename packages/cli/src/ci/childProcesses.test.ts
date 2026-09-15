// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { blankStrings, type ChildProcessReport, childProcessReport, type SourceModule } from "./childProcesses";

/**
 * **Every spelling of a child process this walk claims to follow, kept as a fixture (#593).**
 *
 * `ci/narration.test.ts` states its reach over the real tree, where today's modules happen to spell their
 * spawns one or two ways. A parser that lost the namespace form, or an alias, would still pass there — the
 * tree has no such module to miss — and the claim would quietly exceed the reach again. So each spelling is
 * planted here, in a command with no step, and each must reach that command. The spellings it cannot follow
 * are planted too, and each must be reported rather than skipped.
 */

const ROOT = "/virtual/src";
const POLICY = {
  boundedExecutables: new Set(["git"]),
  uncapturedModules: new Set([`${ROOT}/platform/editor.ts`]),
  progressModule: `${ROOT}/terminal/progress.ts`,
};

const PROGRESS = "export function startStep(what: string): void {}\n";

/** A report over these files, keyed by path under the virtual root. */
function walk(files: Record<string, string>): ChildProcessReport {
  const all = new Map<string, SourceModule>();
  for (const [path, code] of Object.entries({ "terminal/progress.ts": PROGRESS, ...files })) {
    all.set(`${ROOT}/${path}`, { file: `${ROOT}/${path}`, code });
  }
  return childProcessReport(all, POLICY);
}

/** The command declarations left silent, as `path#name`. */
function silentCommands(report: ChildProcessReport): string[] {
  return [...report.silent]
    .filter((key) => key.startsWith(`${ROOT}/commands/`))
    .map((key) => key.slice(ROOT.length + 1));
}

/** A command whose body calls `install` from `../pm`. */
const COMMAND = 'import { install } from "../pm";\n\nexport default async function run() {\n  await install();\n}\n';

describe("a spawn is found however the binding is spelled", () => {
  const spellings: Record<string, string> = {
    "a named import":
      'import { execFile } from "node:child_process";\nexport function install() {\n  execFile("npm", ["install"]);\n}\n',
    "an aliased import":
      'import { execFile as ef } from "node:child_process";\nexport function install() {\n  ef("npm", ["install"]);\n}\n',
    "a namespace import":
      'import * as cp from "node:child_process";\nexport function install() {\n  cp.execFile("npm", ["install"]);\n}\n',
    "a default import, without node:":
      'import cp from "child_process";\nexport function install() {\n  cp.spawnSync("npm", ["install"]);\n}\n',
    "a destructured dynamic import, renamed":
      'export async function install() {\n  const { execFile: go } = await import("node:child_process");\n  go("npm", ["install"]);\n}\n',
    "a require": 'const cp = require("child_process");\nexport function install() {\n  cp.exec("npm install");\n}\n',
    "a promisify through util's namespace":
      'import * as cp from "node:child_process";\nimport util from "node:util";\nconst run = util.promisify(cp.execFile);\nexport async function install() {\n  await run("npm", ["install"]);\n}\n',
    "a promisify called where it is made":
      'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nexport async function install() {\n  await promisify(execFile)("npm", ["install"]);\n}\n',
    "a plain copy of the binding":
      'import { spawn } from "node:child_process";\nconst start = spawn;\nexport function install() {\n  start("npm", ["install"]);\n}\n',
    "a call on the module where it is obtained":
      'export async function install() {\n  (await import("node:child_process")).execFileSync("npm", ["install"]);\n}\n',
    "a dynamic import written as a template":
      'export async function install() {\n  const cp = await import(`node:child_process`);\n  cp.execFile("npm", ["install"]);\n}\n',
    "Bun's global through globalThis":
      'export function install() {\n  globalThis.Bun.spawnSync(["npm", "install"]);\n}\n',
    "Bun's global": 'export function install() {\n  Bun.spawn(["npm", "install"]);\n}\n',
    "a local helper one frame up":
      'import { execFile } from "node:child_process";\nfunction spawnIt() {\n  execFile("npm", ["install"]);\n}\nexport function install() {\n  spawnIt();\n}\n',
  };

  for (const [spelling, pm] of Object.entries(spellings)) {
    test(spelling, () => {
      const report = walk({ "pm.ts": pm, "commands/add.ts": COMMAND });
      expect(report.unfollowable).toEqual([]);
      expect(silentCommands(report)).toEqual(["commands/add.ts#run"]);
    });
  }
});

describe("a silent spawner is followed however it is imported", () => {
  const PM =
    'import { execFile } from "node:child_process";\nexport function install() {\n  execFile("npm", ["install"]);\n}\n';

  test("under an alias", () => {
    const command = 'import { install as setup } from "../pm";\nexport default function run() {\n  setup();\n}\n';
    expect(silentCommands(walk({ "pm.ts": PM, "commands/add.ts": command }))).toEqual(["commands/add.ts#run"]);
  });

  test("through a namespace", () => {
    const command = 'import * as pm from "../pm";\nexport default function run() {\n  pm.install();\n}\n';
    expect(silentCommands(walk({ "pm.ts": PM, "commands/add.ts": command }))).toEqual(["commands/add.ts#run"]);
  });

  test("through a renaming re-export", () => {
    const relay = 'export { install as setup } from "./pm";\n';
    const command = 'import { setup } from "../relay";\nexport default function run() {\n  setup();\n}\n';
    const report = walk({ "pm.ts": PM, "relay.ts": relay, "commands/add.ts": command });
    expect(silentCommands(report)).toEqual(["commands/add.ts#run"]);
  });

  test("through a namespace destructured rather than dotted", () => {
    const command =
      'import * as pm from "../pm";\nexport default function run() {\n  const { install: go } = pm;\n  go();\n}\n';
    expect(silentCommands(walk({ "pm.ts": PM, "commands/add.ts": command }))).toEqual(["commands/add.ts#run"]);
  });

  test("through a dynamic import", () => {
    const command = 'export default async function run() {\n  (await import("../pm")).install();\n}\n';
    expect(silentCommands(walk({ "pm.ts": PM, "commands/add.ts": command }))).toEqual(["commands/add.ts#run"]);
  });

  test("and a step raised under an alias narrates it", () => {
    const command =
      'import { install } from "../pm";\nimport { startStep as say } from "../terminal/progress";\nexport default function run() {\n  say("Installing");\n  install();\n}\n';
    const report = walk({ "pm.ts": PM, "commands/add.ts": command });
    expect(silentCommands(report)).toEqual([]);
    expect([...report.narrated]).toContain(`${ROOT}/commands/add.ts#run`);
  });
});

describe("what is not a captured child needing a step", () => {
  test("a bounded executable, written as a literal", () => {
    const pm =
      'import { execFile } from "node:child_process";\nexport function install() {\n  execFile("git", ["worktree", "add"]);\n}\n';
    expect(silentCommands(walk({ "pm.ts": pm, "commands/add.ts": COMMAND }))).toEqual([]);
  });

  test("a bounded executable held in a variable is not one", () => {
    const pm =
      'import { execFile } from "node:child_process";\nconst GIT = "git";\nexport function install() {\n  execFile(GIT, ["status"]);\n}\n';
    expect(silentCommands(walk({ "pm.ts": pm, "commands/add.ts": COMMAND }))).toEqual(["commands/add.ts#run"]);
  });

  test("a spawn in a module that hands its streams on — but not an execFile there", () => {
    const spawned =
      'import { spawn, execFile } from "node:child_process";\nexport function install() {\n  spawn("vim", []);\n}\n';
    const collected =
      'import { spawn, execFile } from "node:child_process";\nexport function install() {\n  execFile("npm", ["install"]);\n}\n';
    const command = 'import { install } from "../platform/editor";\nexport default function run() {\n  install();\n}\n';
    expect(silentCommands(walk({ "platform/editor.ts": spawned, "commands/add.ts": command }))).toEqual([]);
    expect(silentCommands(walk({ "platform/editor.ts": collected, "commands/add.ts": command }))).toEqual([
      "commands/add.ts#run",
    ]);
  });

  test("the binding's name in a message", () => {
    const pm =
      'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nexport function hint() {\n  return `run $' +
      '{"pithy"} again, or run it by hand`;\n}\n';
    const report = walk({ "pm.ts": pm });
    expect(report.unfollowable).toEqual([]);
    expect(report.silent.size).toBe(0);
  });
});

describe("what the walk cannot follow is reported, not skipped", () => {
  const cases: Record<string, string> = {
    "a binding passed as a value":
      'import { execFile } from "node:child_process";\nexport function install() {\n  retry(execFile);\n}\n',
    "a binding in a shorthand property":
      'import { spawn } from "node:child_process";\nexport const seams = { spawn };\n',
    "a namespace passed as a value": 'import * as cp from "node:child_process";\nexport const tools = cp;\n',
    "a specifier held in a variable":
      'const name = "node:child_process";\nexport async function install() {\n  (await import(name)).execFile("npm");\n}\n',
    "a re-export of a primitive": 'export { execFile } from "node:child_process";\n',
    "Bun's global as a value": 'const runtime = Bun;\nexport function install() {\n  runtime.spawn(["npm"]);\n}\n',
  };

  for (const [what, pm] of Object.entries(cases)) {
    test(what, () => {
      expect(walk({ "pm.ts": pm }).unfollowable).not.toEqual([]);
    });
  }
});

describe("blankStrings", () => {
  test("keeps offsets, quotes and template expressions, and blanks the text", () => {
    const code = [
      'const a = "run it";',
      " const b = `run $" + '{run("x")} now`;',
      " const c = /[\"']/;",
      "\nrun();",
    ].join("");
    const blanked = blankStrings(code);
    expect(blanked).toHaveLength(code.length);
    expect(blanked).toBe(
      ['const a = "      ";', " const b = `    $" + '{run(" ")}    `;', " const c = /    /;", "\nrun();"].join(""),
    );
  });
});
