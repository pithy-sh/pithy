// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type DevLogEntry, followDevLogs, listDevLogs, parseDevLogText, parseSince, readDevLogs } from "./devLogRead";
import type { DevLogRecord } from "./devLogRecord";
import { formatDevLogRecord } from "./devLogRecord";

const line = (record: DevLogRecord) => `${formatDevLogRecord(record)}\n`;
const out = (ts: string, text: string): DevLogRecord => ({ ts, stream: "stdout", text });

describe("parseDevLogText", () => {
  /** A live session is mid-append, so the last line may be half a record. That is not corruption. */
  test("a trailing partial line is tolerated and is not reported as corruption", () => {
    const text = `${line(out("2026-07-27T00:00:00.000Z", "one"))}{"ts":"2026-07-27T00:00:01`;
    expect(parseDevLogText(text)).toEqual({ records: [out("2026-07-27T00:00:00.000Z", "one")], skipped: 0 });
  });

  test("a malformed line mid-file is skipped and counted", () => {
    const text = [
      line(out("2026-07-27T00:00:00.000Z", "one")),
      "not json\n",
      line(out("2026-07-27T00:00:02.000Z", "two")),
    ].join("");
    expect(parseDevLogText(text)).toEqual({
      records: [out("2026-07-27T00:00:00.000Z", "one"), out("2026-07-27T00:00:02.000Z", "two")],
      skipped: 1,
    });
  });

  test("an empty file has nothing in it and nothing wrong with it", () => {
    expect(parseDevLogText("")).toEqual({ records: [], skipped: 0 });
  });
});

describe("the directory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-dev-logs-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, text: string) => writeFile(join(dir, name), text);

  describe("listDevLogs", () => {
    /**
     * Across **every** branch, not only the one checked out: the listing is how a developer learns what
     * `--branch` would take, and the whole point of the directory is that it outlives the worktree.
     */
    test("lists every branch and worker in the directory, with lines, size and last write", async () => {
      await write("dev.main.api.jsonl", line(out("2026-07-27T00:00:00.000Z", "one")));
      await write(
        "dev.feature-671-x.web.jsonl",
        `${line(out("2026-07-27T00:00:00.000Z", "a"))}${line(out("2026-07-27T00:00:01.000Z", "b"))}`,
      );

      const found = await listDevLogs(dir);

      expect(found.map((row) => [row.branch, row.worker, row.lines])).toEqual([
        ["feature-671-x", "web", 2],
        ["main", "api", 1],
      ]);
      expect(found.every((row) => row.bytes > 0)).toBe(true);
      expect(found.every((row) => !Number.isNaN(Date.parse(row.lastWrite)))).toBe(true);
    });

    /** A branch whose worktree is gone is listed, not marked and not pruned: surviving it is the point. */
    test("a branch with no worktree anywhere is still a row, because that is what the file is for", async () => {
      await write("dev.feature-999-long-gone.api.jsonl", line(out("2026-07-27T00:00:00.000Z", "x")));
      expect((await listDevLogs(dir)).map((row) => row.branch)).toEqual(["feature-999-long-gone"]);
    });

    test("anything that is not one of ours is not listed", async () => {
      await write("dev.log", "[api] an older pithy wrote this\n");
      await write("notes.txt", "hello\n");
      expect(await listDevLogs(dir)).toEqual([]);
    });

    /** Only files are listed: a directory named like a log is not one, and `stat` is where that is told. */
    test("something shaped like a log file but not a file is left out", async () => {
      await mkdir(join(dir, "dev.main.api.jsonl"), { recursive: true });

      expect(await listDevLogs(dir)).toEqual([]);
    });

    test("a directory that does not exist yet is empty rather than an error", async () => {
      expect(await listDevLogs(join(dir, "nothing-here"))).toEqual([]);
    });
  });

  describe("readDevLogs", () => {
    test("renders one worker's records, newest last", async () => {
      await write(
        "dev.main.api.jsonl",
        [line(out("2026-07-27T00:00:00.000Z", "first")), line(out("2026-07-27T00:00:01.000Z", "second"))].join(""),
      );

      const read = await readDevLogs({ dir, branch: "main", workers: ["api"], lines: 200 });

      expect(read.entries.map((entry) => (entry.record as { text: string }).text)).toEqual(["first", "second"]);
      expect(read.skipped).toBe(0);
    });

    /** `--app` is repeatable, as it is on `pithy dev`; `ts` is the only ordering two files share. */
    test("several workers merge by ts", async () => {
      await write(
        "dev.main.api.jsonl",
        [line(out("2026-07-27T00:00:00.000Z", "api-1")), line(out("2026-07-27T00:00:02.000Z", "api-2"))].join(""),
      );
      await write("dev.main.web.jsonl", line(out("2026-07-27T00:00:01.000Z", "web-1")));

      const read = await readDevLogs({ dir, branch: "main", workers: ["api", "web"], lines: 200 });

      expect(read.entries.map((entry) => [entry.worker, (entry.record as { text: string }).text])).toEqual([
        ["api", "api-1"],
        ["web", "web-1"],
        ["api", "api-2"],
      ]);
    });

    /**
     * Bounded **after** the merge. Taking each file's last 200 first would give a two-worker read 400
     * records, and a quiet worker's whole session would crowd out the busy one's recent minutes.
     */
    test("-n bounds the merge, not each file", async () => {
      await write(
        "dev.main.api.jsonl",
        [line(out("2026-07-27T00:00:00.000Z", "a1")), line(out("2026-07-27T00:00:02.000Z", "a2"))].join(""),
      );
      await write(
        "dev.main.web.jsonl",
        [line(out("2026-07-27T00:00:01.000Z", "w1")), line(out("2026-07-27T00:00:03.000Z", "w2"))].join(""),
      );

      const read = await readDevLogs({ dir, branch: "main", workers: ["api", "web"], lines: 2 });

      expect(read.entries.map((entry) => (entry.record as { text: string }).text)).toEqual(["a2", "w2"]);
    });

    test("--since bounds by time, inclusive of the instant named", async () => {
      await write(
        "dev.main.api.jsonl",
        [
          line(out("2026-07-27T00:00:00.000Z", "before")),
          line(out("2026-07-27T00:00:05.000Z", "at")),
          line(out("2026-07-27T00:00:10.000Z", "after")),
        ].join(""),
      );

      const read = await readDevLogs({
        dir,
        branch: "main",
        workers: ["api"],
        lines: 200,
        since: new Date("2026-07-27T00:00:05.000Z"),
      });

      expect(read.entries.map((entry) => (entry.record as { text: string }).text)).toEqual(["at", "after"]);
    });

    test("the skipped count is the total across every file read, reported once", async () => {
      await write("dev.main.api.jsonl", `${line(out("2026-07-27T00:00:00.000Z", "a"))}garbage\n`);
      await write("dev.main.web.jsonl", `${line(out("2026-07-27T00:00:01.000Z", "w"))}also garbage\n`);

      expect((await readDevLogs({ dir, branch: "main", workers: ["api", "web"], lines: 200 })).skipped).toBe(2);
    });

    /** Both named, because `--branch` defaults to the checkout and the file may belong to a branch that is gone. */
    test("a worker with no file is an error naming the worker and the branch", async () => {
      await expect(readDevLogs({ dir, branch: "main", workers: ["nope"], lines: 200 })).rejects.toThrow(NotFoundError);
      const error = await readDevLogs({ dir, branch: "feature/671-x", workers: ["nope"], lines: 200 }).then(
        () => {
          throw new Error("expected a refusal");
        },
        (e: unknown) => e as NotFoundError,
      );
      expect(error.payload.message).toContain("nope");
      expect(error.payload.message).toContain("feature-671-x");
      expect(error.payload.action).toContain("pithy dev logs");
    });
  });

  describe("followDevLogs", () => {
    const tail = (
      workers: readonly { worker: string; offset: number }[],
      sink: { entries: DevLogEntry[]; restarted: string[]; skipped: number[] },
    ) =>
      followDevLogs({
        dir,
        branch: "main",
        workers,
        sinks: {
          record: (entry) => sink.entries.push(entry),
          restarted: (worker) => sink.restarted.push(worker),
          skipped: (count) => sink.skipped.push(count),
        },
      });

    test("emits what has been appended since the last poll, and nothing twice", async () => {
      await write("dev.main.api.jsonl", line(out("2026-07-27T00:00:00.000Z", "one")));
      const sink = { entries: [] as DevLogEntry[], restarted: [] as string[], skipped: [] as number[] };
      const following = tail([{ worker: "api", offset: 0 }], sink);

      await following.poll();
      await appendFile(join(dir, "dev.main.api.jsonl"), line(out("2026-07-27T00:00:01.000Z", "two")));
      await following.poll();
      await following.poll();

      expect(sink.entries.map((entry) => (entry.record as { text: string }).text)).toEqual(["one", "two"]);
    });

    /** A chunk boundary mid-record is the ordinary case: the tail holds the half-line rather than losing it. */
    test("a record written in two halves is emitted once, whole", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      const whole = line(out("2026-07-27T00:00:00.000Z", "split"));
      await writeFile(path, whole.slice(0, 20));
      const sink = { entries: [] as DevLogEntry[], restarted: [] as string[], skipped: [] as number[] };
      const following = tail([{ worker: "api", offset: 0 }], sink);

      await following.poll();
      expect(sink.entries).toEqual([]);
      await appendFile(path, whole.slice(20));
      await following.poll();

      expect(sink.entries.map((entry) => (entry.record as { text: string }).text)).toEqual(["split"]);
    });

    /**
     * **Truncation is handled, not prevented.** The next `pithy dev` opens the file with `flags: "w"`, and
     * a tail that kept its offset would sit silent for the rest of the new session.
     */
    test("reseeks when a new session truncates the file under it, and says so", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      await writeFile(
        path,
        [line(out("2026-07-27T00:00:00.000Z", "old-1")), line(out("2026-07-27T00:00:01.000Z", "old-2"))].join(""),
      );
      const sink = { entries: [] as DevLogEntry[], restarted: [] as string[], skipped: [] as number[] };
      const backlog = await readDevLogs({ dir, branch: "main", workers: ["api"], lines: 200 });
      const following = tail(backlog.offsets, sink);

      await following.poll();
      expect(sink.entries).toEqual([]);

      await writeFile(path, line(out("2026-07-27T00:01:00.000Z", "new-1")));
      await following.poll();

      expect(sink.entries.map((entry) => (entry.record as { text: string }).text)).toEqual(["new-1"]);
      expect(sink.restarted).toEqual(["api"]);
    });

    /** A file that is not there yet is waited on: `--follow` is a tail, and a missing file is the read's refusal. */
    test("a file that does not exist is waited for rather than thrown over", async () => {
      const sink = { entries: [] as DevLogEntry[], restarted: [] as string[], skipped: [] as number[] };
      const following = tail([{ worker: "later", offset: 0 }], sink);
      await expect(following.poll()).resolves.toBeUndefined();
      expect(sink.entries).toEqual([]);
    });

    test("a malformed line in the stream is counted once per poll", async () => {
      await write("dev.main.api.jsonl", "garbage\nalso garbage\n");
      const sink = { entries: [] as DevLogEntry[], restarted: [] as string[], skipped: [] as number[] };
      const following = tail([{ worker: "api", offset: 0 }], sink);

      await following.poll();

      expect(sink.skipped).toEqual([2]);
    });
  });

  /**
   * **The seam the two halves of `--follow` meet at.** The offset a tail resumes from comes out of the
   * backlog read itself; a second `stat` of the file is wrong in both directions, and each wrong
   * direction is a test below.
   */
  describe("the offsets a backlog read hands its tail", () => {
    const tail = (
      workers: readonly { worker: string; offset: number }[],
      sink: { entries: DevLogEntry[]; restarted: string[]; skipped: number[] },
    ) =>
      followDevLogs({
        dir,
        branch: "main",
        workers,
        sinks: {
          record: (entry) => sink.entries.push(entry),
          restarted: (worker) => sink.restarted.push(worker),
          skipped: (count) => sink.skipped.push(count),
        },
      });

    test("is the byte after the last complete record, counted in bytes and not characters", async () => {
      const text = line(out("2026-07-27T00:00:00.000Z", "héllo — a multi-byte line"));
      await write("dev.main.api.jsonl", text);

      const read = await readDevLogs({ dir, branch: "main", workers: ["api"], lines: 200 });

      expect(read.offsets).toEqual([{ worker: "api", offset: Buffer.byteLength(text) }]);
    });

    /**
     * **A completed partial line is a record, not corruption.** `stat().size` counts the bytes of the
     * half-written last line the backlog correctly discarded, so a tail seeded from it joins that record
     * in the middle: the remainder fails to parse, `1 malformed line skipped.` goes to stderr, and the
     * record itself is dropped — against the one promise this reader makes about a live file.
     */
    test("stops short of a half-written line, so the tail emits it once it is finished", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      const whole = line(out("2026-07-27T00:00:01.000Z", "half-written when the backlog was read"));
      await writeFile(path, line(out("2026-07-27T00:00:00.000Z", "complete")) + whole.slice(0, 20));
      const read = await readDevLogs({ dir, branch: "main", workers: ["api"], lines: 200 });
      const sink = { entries: [] as DevLogEntry[], restarted: [] as string[], skipped: [] as number[] };
      const following = tail(read.offsets, sink);

      await appendFile(path, whole.slice(20));
      await following.poll();

      expect(sink.entries.map((entry) => (entry.record as { text: string }).text)).toEqual([
        "half-written when the backlog was read",
      ]);
      expect(sink.skipped).toEqual([]);
    });

    /**
     * **And nothing falls between the two halves.** The window a second measurement opens is the whole
     * duration of rendering the backlog, which on a chatty session is long enough to lose dozens of
     * lines with nothing said. Here the session appends after the read and before the first poll.
     */
    test("covers every byte the backlog read, so a record appended in between is still tailed", async () => {
      const path = join(dir, "dev.main.api.jsonl");
      await writeFile(path, line(out("2026-07-27T00:00:00.000Z", "in the backlog")));
      const read = await readDevLogs({ dir, branch: "main", workers: ["api"], lines: 200 });

      await appendFile(path, line(out("2026-07-27T00:00:01.000Z", "written while the backlog rendered")));
      const sink = { entries: [] as DevLogEntry[], restarted: [] as string[], skipped: [] as number[] };
      const following = tail(read.offsets, sink);
      await following.poll();

      expect(read.entries.map((entry) => (entry.record as { text: string }).text)).toEqual(["in the backlog"]);
      expect(sink.entries.map((entry) => (entry.record as { text: string }).text)).toEqual([
        "written while the backlog rendered",
      ]);
    });

    /** A file with nothing complete in it yet starts the tail at zero rather than past its one line. */
    test("is zero for a file holding only a line still being written", async () => {
      await write("dev.main.api.jsonl", '{"ts":"2026-07-27T00:00:00');

      const read = await readDevLogs({ dir, branch: "main", workers: ["api"], lines: 200 });

      expect(read.offsets).toEqual([{ worker: "api", offset: 0 }]);
    });
  });
});

describe("parseSince", () => {
  const now = new Date("2026-07-27T12:00:00.000Z");

  test("a duration is that long before now", () => {
    expect(parseSince("30s", now).toISOString()).toBe("2026-07-27T11:59:30.000Z");
    expect(parseSince("5m", now).toISOString()).toBe("2026-07-27T11:55:00.000Z");
    expect(parseSince("2h", now).toISOString()).toBe("2026-07-27T10:00:00.000Z");
    expect(parseSince("1d", now).toISOString()).toBe("2026-07-26T12:00:00.000Z");
  });

  test("an absolute instant is itself", () => {
    expect(parseSince("2026-07-27T09:00:00Z", now).toISOString()).toBe("2026-07-27T09:00:00.000Z");
  });

  test("anything else is refused, naming both shapes it takes", () => {
    expect(() => parseSince("soon", now)).toThrow(ValidationError);
    const error = (() => {
      try {
        parseSince("5 minutes", now);
      } catch (e) {
        return e as ValidationError;
      }
      throw new Error("expected a refusal");
    })();
    expect(error.payload.action).toContain("5m");
    expect(error.payload.action).toContain("2026-07-27T09:00:00Z");
  });
});
