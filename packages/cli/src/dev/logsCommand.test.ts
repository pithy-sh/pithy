// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DevLogRecord } from "./devLogRecord";
import { formatDevLogRecord } from "./devLogRecord";
import { stripAnsi } from "./logging";
import logs, { collectLogAppFlags, formatBytes, parseLines, runDevLogs } from "./logsCommand";

type ArgSpec = { type: string; default?: unknown; alias?: string; description?: string };
const args = logs.args as Record<string, ArgSpec>;

const at = (seconds: number) => `2026-07-27T00:00:${String(seconds).padStart(2, "0")}.000Z`;
const line = (record: DevLogRecord) => `${formatDevLogRecord(record)}\n`;
const out = (seconds: number, text: string): DevLogRecord => ({ ts: at(seconds), stream: "stdout", text });

describe("the command surface", () => {
  test("declares exactly the reader's flags", () => {
    expect(Object.keys(args)).toEqual(["app", "lines", "since", "follow", "timestamps", "branch", "json"]);
    expect(args.lines).toMatchObject({ type: "string", alias: "n" });
    expect(args.follow).toMatchObject({ type: "boolean", default: false });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });

  test("says --app is repeatable, because citty's own parse does not make it so", () => {
    expect(args.app?.description).toContain("repeatable");
  });
});

describe("collectLogAppFlags", () => {
  test("keeps every occurrence, which citty does not", () => {
    expect(collectLogAppFlags(["--app", "api", "--app=web"])).toEqual(["api", "web"]);
  });

  test("a --app with no name is refused — the permissive reading is *list everything*", () => {
    expect(() => collectLogAppFlags(["--app", "--json"])).toThrow(ValidationError);
    expect(() => collectLogAppFlags(["--app="])).toThrow(ValidationError);
  });
});

describe("parseLines", () => {
  test("defaults to the last two hundred records", () => {
    expect(parseLines(undefined)).toBe(200);
  });

  test("takes a whole number and refuses anything else", () => {
    expect(parseLines("50")).toBe(50);
    expect(() => parseLines("fifty")).toThrow(ValidationError);
    expect(() => parseLines("-5")).toThrow(ValidationError);
  });
});

describe("formatBytes", () => {
  test("reads as a size, because growth has to be visible without a cap or a rotation", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("runDevLogs", () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-dev-logs-cmd-"));
    stdout = [];
    stderr = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, text: string) => writeFile(join(dir, name), text);

  const run = (overrides: Partial<Parameters<typeof runDevLogs>[0]> = {}) =>
    runDevLogs({
      projectDir: "/proj",
      apps: [],
      lines: 200,
      follow: false,
      timestamps: false,
      branch: "main",
      json: false,
      dir,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      sleep: async () => {},
      ...overrides,
    });

  describe("the listing", () => {
    test("no flags prints a table of what is readable, across every branch", async () => {
      await write("dev.main.api.jsonl", line(out(0, "one")));
      await write("dev.feature-671-x.web.jsonl", line(out(1, "two")));

      await run();

      const printed = stripAnsi(stdout.join(""));
      expect(printed).toContain("api");
      expect(printed).toContain("main");
      expect(printed).toContain("feature-671-x");
      expect(printed).toContain("1 lines");
      // It reads no output out: the table is the answer, not a session.
      expect(printed).not.toContain("one");
      expect(printed).not.toContain("two");
    });

    test("nothing to read says so, and names the directory it looked in", async () => {
      await run();
      expect(stripAnsi(stdout.join(""))).toContain("No session logs yet. Run pithy dev.");
      expect(stripAnsi(stdout.join(""))).toContain(dir);
    });

    test("--json is one object naming every readable file", async () => {
      await write("dev.main.api.jsonl", line(out(0, "one")));

      await run({ json: true });

      const parsed = JSON.parse(stdout.join("").trim()) as { command: string; event: string; logs: unknown[] };
      expect(parsed.command).toBe("dev");
      expect(parsed.event).toBe("logs");
      expect(parsed.logs).toHaveLength(1);
      expect(parsed.logs[0]).toMatchObject({ branch: "main", worker: "api", lines: 1 });
    });
  });

  describe("reading a worker back", () => {
    test("--app renders that worker's session as [name] text, newest last", async () => {
      await write("dev.main.api.jsonl", [line(out(0, "first")), line(out(1, "second"))].join(""));

      await run({ apps: ["api"] });

      expect(stdout.map((text) => stripAnsi(text.trimEnd()))).toEqual(["[api] first", "[api] second"]);
    });

    test("-n changes the count", async () => {
      await write("dev.main.api.jsonl", [line(out(0, "first")), line(out(1, "second"))].join(""));

      await run({ apps: ["api"], lines: 1 });

      expect(stdout.map((text) => stripAnsi(text.trimEnd()))).toEqual(["[api] second"]);
    });

    test("--timestamps prefixes each line with its instant", async () => {
      await write("dev.main.api.jsonl", line(out(3, "hello")));

      await run({ apps: ["api"], timestamps: true });

      expect(stripAnsi(stdout.join("").trimEnd())).toBe(`${at(3)} [api] hello`);
    });

    test("--branch reads another branch's files", async () => {
      await write("dev.feature-671-x.api.jsonl", line(out(0, "from the feature")));

      await run({ apps: ["api"], branch: "feature/671-x" });

      expect(stripAnsi(stdout.join("").trimEnd())).toBe("[api] from the feature");
    });

    /** Once, as a count: a truncated write produces a run of them, and a line each buries the session. */
    test("malformed lines are reported once, on stderr, with the session still rendered", async () => {
      await write("dev.main.api.jsonl", `${line(out(0, "good"))}garbage\nmore garbage\n`);

      await run({ apps: ["api"] });

      expect(stripAnsi(stdout.join("").trimEnd())).toBe("[api] good");
      expect(stderr.join("")).toBe("2 malformed lines skipped.\n");
    });

    test("a worker with no file is an actionable error naming the worker and the branch", async () => {
      await expect(run({ apps: ["absent"] })).rejects.toThrow(NotFoundError);
    });
  });

  describe("--json", () => {
    /**
     * **One compact object per line, with or without `--follow`** — `pithy dev`'s standing exception in
     * `docs/CLI.md` §1.2, extended to its reader. A consumer's parse does not change with a flag it did
     * not pass.
     */
    test("emits the records themselves, one compact object per line, uncolored", async () => {
      await write(
        "dev.main.api.jsonl",
        [line({ ts: at(0), event: "spawned", port: 8787 }), line(out(1, "hello"))].join(""),
      );

      await run({ apps: ["api"], json: true });

      expect(stdout).toEqual([
        `{"ts":"${at(0)}","event":"spawned","port":8787}\n`,
        `{"ts":"${at(1)}","stream":"stdout","text":"hello"}\n`,
      ]);
    });

    test("carries no worker field, because the file is the name", async () => {
      await write("dev.main.api.jsonl", line(out(0, "hello")));

      await run({ apps: ["api"], json: true });

      expect(Object.keys(JSON.parse(stdout[0] as string) as object)).toEqual(["ts", "stream", "text"]);
    });

    test("a missing worker under --json puts nothing on stdout", async () => {
      await expect(run({ apps: ["absent"], json: true })).rejects.toThrow(NotFoundError);
      expect(stdout).toEqual([]);
    });
  });

  describe("--follow", () => {
    test("renders the backlog, then tails what is appended", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      await writeFile(path, line(out(0, "backlog")));
      let polls = 0;

      await run({
        apps: ["api"],
        follow: true,
        // Two turns of the loop: the file grows between them, which is what a live session does.
        // Appended synchronously, because the poll that reads it is the next statement.
        following: () => {
          polls += 1;
          if (polls === 2) appendFileSync(path, line(out(1, "live")));
          return polls <= 3;
        },
      });

      expect(stdout.map((text) => stripAnsi(text.trimEnd()))).toEqual(["[api] backlog", "[api] live"]);
    });

    test("under --json a followed record is the same one line it would be without the flag", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      await writeFile(path, line(out(0, "backlog")));
      let polls = 0;

      await run({
        apps: ["api"],
        follow: true,
        json: true,
        following: () => {
          polls += 1;
          if (polls === 2) appendFileSync(path, line(out(1, "live")));
          return polls <= 3;
        },
      });

      expect(stdout).toEqual([
        `{"ts":"${at(0)}","stream":"stdout","text":"backlog"}\n`,
        `{"ts":"${at(1)}","stream":"stdout","text":"live"}\n`,
      ]);
    });

    /**
     * **Nothing falls between the backlog and the tail**, which is the one thing a tail must not do.
     * The window is the whole duration of rendering the backlog — long on a chatty session through a
     * slow terminal or a pipe — so the append happens from inside `stdout`, which is the render. A tail
     * seeded from a later `stat` starts past these bytes and they appear in neither half of the stream.
     */
    test("a record written while the backlog renders is still tailed, not lost between the halves", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      await writeFile(path, line(out(0, "backlog")));
      let polls = 0;

      await run({
        apps: ["api"],
        follow: true,
        stdout: (text) => {
          stdout.push(text);
          // The live session writing while the reader is mid-render. Once: this is the window, not a loop.
          if (stdout.length === 1) appendFileSync(path, line(out(1, "written mid-render")));
        },
        following: () => {
          polls += 1;
          return polls <= 2;
        },
      });

      expect(stdout.map((text) => stripAnsi(text.trimEnd()))).toEqual(["[api] backlog", "[api] written mid-render"]);
    });

    /**
     * **And a half-written line is a record, not corruption.** `stat().size` counts the bytes of the
     * partial line the backlog correctly discarded, so a tail seeded from it joins the record in the
     * middle: the remainder fails to parse and the reader is told `1 malformed line skipped.` about a
     * line that was perfectly good.
     */
    test("a line half-written when the backlog was read is emitted whole, and called malformed by nobody", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      const whole = line(out(1, "finished after the read"));
      await writeFile(path, line(out(0, "backlog")) + whole.slice(0, 20));
      let polls = 0;

      await run({
        apps: ["api"],
        follow: true,
        following: () => {
          polls += 1;
          if (polls === 2) appendFileSync(path, whole.slice(20));
          return polls <= 3;
        },
      });

      expect(stdout.map((text) => stripAnsi(text.trimEnd()))).toEqual([
        "[api] backlog",
        "[api] finished after the read",
      ]);
      expect(stderr).toEqual([]);
    });

    /** A new session truncates the file this is on, and a tail that kept its offset would go silent. */
    test("a new session taking the log is named, and the tail follows it from the start", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      await writeFile(path, [line(out(0, "old-1")), line(out(1, "old-2"))].join(""));
      let polls = 0;

      await run({
        apps: ["api"],
        follow: true,
        // Truncated and rewritten in one synchronous call, exactly as `flags: "w"` does it.
        following: () => {
          polls += 1;
          if (polls === 2) writeFileSync(path, line(out(5, "new-1")));
          return polls <= 3;
        },
      });

      expect(stdout.map((text) => stripAnsi(text.trimEnd()))).toEqual(["[api] old-1", "[api] old-2", "[api] new-1"]);
      expect(stderr.join("")).toContain("api: a new session took this log.");
    });
  });
});
