// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DevLogRecord } from "./devLogRecord";
import { createDevLogSinks, devLogStreamWriter, openDevLogDefault } from "./devLogSink";

const at = "2026-07-27T00:00:00.000Z";

describe("createDevLogSinks", () => {
  test("one file per worker, named for the branch, under the directory it was given", async () => {
    const opened: string[] = [];
    const sinks = createDevLogSinks({
      dir: "/cfg/acme/logs",
      branch: "feature/671-dev-logs",
      open: async (path) => {
        opened.push(path);
        return { record: () => {}, end: () => {} };
      },
    });

    await sinks.open("api");
    await sinks.open("web");

    expect(opened).toEqual([
      "/cfg/acme/logs/dev.feature-671-dev-logs.api.jsonl",
      "/cfg/acme/logs/dev.feature-671-dev-logs.web.jsonl",
    ]);
  });

  /**
   * **Opened once per invocation**, which is what makes a restart append: `flags: "w"` truncates, so a
   * second open inside one session would lose the records a developer went to the file for.
   */
  test("a worker asked for twice is opened once, so a restart inside a session appends", async () => {
    let opens = 0;
    const sinks = createDevLogSinks({
      dir: "/logs",
      branch: "main",
      open: async () => {
        opens += 1;
        return { record: () => {}, end: () => {} };
      },
    });

    await sinks.open("api");
    await sinks.open("api");

    expect(opens).toBe(1);
  });

  /** Two opens racing on one worker — `pithy dev` opens eagerly, `r` opens again — still open one file. */
  test("two concurrent opens of one worker share the one file", async () => {
    let opens = 0;
    const sinks = createDevLogSinks({
      dir: "/logs",
      branch: "main",
      open: async () => {
        opens += 1;
        await Promise.resolve();
        return { record: () => {}, end: () => {} };
      },
    });

    await Promise.all([sinks.open("api"), sinks.open("api")]);

    expect(opens).toBe(1);
  });

  /** A project with no name has nowhere under `<config>/<project>/` to put a log, and writes nowhere. */
  test("a null directory opens nothing and drops every record", async () => {
    let opens = 0;
    const sinks = createDevLogSinks({
      dir: null,
      branch: "main",
      open: async () => {
        opens += 1;
        return { record: () => {}, end: () => {} };
      },
    });

    const writer = await sinks.open("api");
    writer.record({ ts: at, event: "ready" });
    await sinks.end();

    expect(opens).toBe(0);
    expect(sinks.dir).toBeNull();
  });

  /** `writer` never opens: the orchestrator calls it per line, and a line must not create a file. */
  test("writer answers a no-op for a worker whose file was never opened", () => {
    const sinks = createDevLogSinks({
      dir: "/logs",
      branch: "main",
      open: async () => ({ record: () => {}, end: () => {} }),
    });
    expect(() => sinks.writer("never-opened").record({ ts: at, event: "ready" })).not.toThrow();
  });

  test("end closes every file it opened", async () => {
    const ended: string[] = [];
    const sinks = createDevLogSinks({
      dir: "/logs",
      branch: "main",
      open: async (path) => ({ record: () => {}, end: () => void ended.push(path) }),
    });

    await sinks.open("api");
    await sinks.open("web");
    await sinks.end();

    expect(ended).toEqual(["/logs/dev.main.api.jsonl", "/logs/dev.main.web.jsonl"]);
  });
});

describe("openDevLogDefault", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-dev-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes one JSON object per line, newline-terminated", async () => {
    const path = join(dir, "logs", "dev.main.api.jsonl");
    const writer = await openDevLogDefault(path);
    const records: DevLogRecord[] = [
      { ts: at, event: "spawned", port: 8787 },
      { ts: at, stream: "stdout", text: "Ready on http://localhost:8787" },
    ];
    for (const record of records) writer.record(record);
    await writer.end();

    const text = await readFile(path, "utf8");
    expect(
      text
        .split("\n")
        .slice(0, -1)
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual(records);
  });

  /**
   * **`logs/` is held to `<config>/<project>/`'s existing rule, not to a new one.** `ensureOwnerOnlyDirFor`
   * is what `secrets.jsonc`, `dev.json` and `cloudflare.json` already get; without this `logs/` would be
   * the one exception, and a *listing* of it names every worker a project runs.
   */
  test("the directory is 0700 and the file is owner-only", async () => {
    const path = join(dir, "logs", "dev.main.api.jsonl");
    const writer = await openDevLogDefault(path);
    writer.record({ ts: at, event: "ready" });
    await writer.end();

    expect((await stat(join(dir, "logs"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  /**
   * **The one that must never kill the session.** `createWriteStream` is lazy, so before the open was
   * awaited this resolved with a writer and the real failure arrived a tick later as an un-listened
   * `'error'` — an uncaught exception on Node, which takes `pithy dev` down and orphans every child it
   * spawned. Reached for real, with a name no filesystem will take, rather than a mocked throw: a mock
   * would not have caught this, because the bug was that nothing ever threw where the `catch` was.
   */
  test("a name no filesystem will take rejects, rather than resolving and failing a tick later", async () => {
    const path = join(dir, "logs", `dev.main.${"w".repeat(300)}.jsonl`);

    await expect(openDevLogDefault(path)).rejects.toThrow(/ENAMETOOLONG/);
  });

  /**
   * The other half of what the move made reachable: `<config>/<project>/logs/` is shared and outlives any
   * one checkout, so it can be a directory this account cannot write — root-owned after one `sudo pithy`,
   * or a restored `~/.config`. A real 0500 directory, not a stubbed `EACCES`.
   */
  test("a directory this account cannot write rejects, naming the reason", async () => {
    const logs = join(dir, "logs");
    await mkdir(logs, { recursive: true });
    await chmod(logs, 0o500);

    await expect(openDevLogDefault(join(logs, "dev.main.api.jsonl"))).rejects.toThrow(/EACCES/);

    await chmod(logs, 0o700);
  });

  /**
   * **And the session goes on.** The worker keeps the no-op writer `writer` answers with, its records go
   * nowhere, and the teardown's `end()` still resolves — which is the call that stands between the
   * children and being orphaned.
   */
  test("a worker whose log cannot be opened degrades to a writer that drops, and the teardown still ends", async () => {
    const logs = join(dir, "logs");
    await mkdir(logs, { recursive: true });
    await chmod(logs, 0o500);
    const sinks = createDevLogSinks({ dir: logs, branch: "main" });

    await expect(sinks.open("api")).rejects.toThrow(/EACCES/);
    expect(() => sinks.writer("api").record({ ts: at, event: "ready" })).not.toThrow();
    await expect(sinks.end()).resolves.toBeUndefined();

    await chmod(logs, 0o700);
  });

  /**
   * Mid-session, which is the same path: `ENOSPC` or a quota on the disk holding `<config>/` arrives as
   * an `'error'` on an open stream. A real `fs.WriteStream` destroyed with a real error is what that
   * looks like from in here — and `end()` must not wait for a `'finish'` that is never coming.
   */
  test("a stream that breaks mid-session drops records and still ends", async () => {
    const path = join(dir, "broken.jsonl");
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    const writer = devLogStreamWriter(stream);

    stream.destroy(new Error("ENOSPC: no space left on device"));
    await new Promise<void>((resolve) => void setTimeout(resolve, 0));

    expect(() => writer.record({ ts: at, event: "ready" })).not.toThrow();
    await expect(writer.end()).resolves.toBeUndefined();
  });

  /** One file is one session: there is no cap and no rotation, so the truncate is what bounds it. */
  test("a second session truncates the file it opens", async () => {
    const path = join(dir, "logs", "dev.main.api.jsonl");
    const first = await openDevLogDefault(path);
    first.record({ ts: at, stream: "stdout", text: "the first session" });
    await first.end();

    const second = await openDevLogDefault(path);
    second.record({ ts: at, stream: "stdout", text: "the second session" });
    await second.end();

    expect(await readFile(path, "utf8")).toBe(`{"ts":"${at}","stream":"stdout","text":"the second session"}\n`);
  });
});
