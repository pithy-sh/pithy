// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { ensureOwnerOnlyDirFor, tightenMode } from "../devSecrets/mode";
import { devLogFileName } from "./devLogPath";
import type { DevLogRecord } from "./devLogRecord";
import { formatDevLogRecord } from "./devLogRecord";

/**
 * **Where a session's records go: one file per worker, owner-only, opened once per invocation** (#671).
 *
 * `logs/` is the fourth kind of file under `<config>/<project>/` — after `secrets.jsonc`, `dev.json` and
 * the account's `cloudflare.json` — and it is held to that root's existing rule rather than to a new one:
 * {@link ensureOwnerOnlyDirFor} on the directory, {@link tightenMode} on each file. Not as a fix; as the
 * rule every other file there already gets. A session log is the one place a worker's whole output sits
 * at rest on disk, and the *listing* alone names every worker a project runs.
 *
 * **Opened once per invocation, which is what decides truncation.** `flags: "w"` is what the single file
 * did and the behavior is kept: a new `pithy dev` starts each worker's file empty, so one file is one
 * session and there is nothing to rotate. A worker restarted *inside* a session reaches the same open
 * writer and appends — so a restart reads as `exited` then `spawned`, which is the thing a developer
 * went to the file for.
 */

/** One worker's open log file. */
export interface DevLogWriter {
  /** Append one record. Fire-and-forget: a log write is never in the failure path of supervising Workers. */
  record: (record: DevLogRecord) => void;
  /** Flush and close. */
  end: () => Promise<void> | void;
}

/** The seam a test replaces to capture records without touching a disk. */
export type OpenDevLog = (path: string) => Promise<DevLogWriter>;

/** A writer that drops everything — a project with no name has nowhere to put a log. */
export function nullDevLogWriter(): DevLogWriter {
  return { record: () => {}, end: () => {} };
}

/**
 * The real opener: make the directory 0700, truncate the file, narrow its mode, stream records to it.
 *
 * **Resolved once the file is actually open, and never before.** `createWriteStream` is lazy: it hands
 * back a stream while `open(2)` is still pending and reports a failure as an `'error'` event a tick
 * later. An `'error'` nobody listens for is an uncaught exception on Node — so a log file that could not
 * be opened would kill the supervisor and orphan every child it spawned, skipping the teardown that
 * reaps them and removes `.dev-state.json`. `pithy dev` must never die because it could not write a log.
 *
 * Both halves of that are closed here. The open is awaited, so the caller's `catch` is what sees the
 * failure and turns it into one line with the worker's writer left a no-op; and a listener stays attached
 * afterwards, so a write that fails mid-session — a full disk or a quota under `<config>/` — is dropped
 * rather than fatal.
 *
 * **This is reachable now in a way it was not before.** The single `<projectDir>/logs/dev.log` sat in a
 * checkout the developer had just written to; the path now carries the branch name in its basename, so a
 * long branch is `ENAMETOOLONG`, and it lives in a shared directory the developer may not own — root
 * after one `sudo pithy`, or a restored `~/.config` — so `EACCES` is reachable too.
 *
 * The narrowing runs after the stream rather than through an `open` mode, because `mode` is masked by the
 * umask and does nothing at all to a file already there — which is the case it exists for. Awaiting the
 * open is what makes it do that job: before the open resolves there is no file for its `stat` to find.
 */
export const openDevLogDefault: OpenDevLog = async (path) => {
  await ensureOwnerOnlyDirFor(path);
  const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
  await streamOpened(stream);
  await tightenMode(path);
  return devLogStreamWriter(stream);
};

/** Resolve when the file is open, reject with the reason it is not. Listened to either way. */
function streamOpened(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.off("open", onOpen);
      // Still listened to past the rejection. The caller drops this stream, but a destroyed stream can
      // emit again, and an `'error'` on an empty listener list is the uncaught exception this guards.
      stream.on("error", () => {});
      reject(error);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
  });
}

/**
 * One worker's writer over an already-open stream, with a write failure swallowed rather than thrown.
 *
 * Its own function so the mid-session half is reachable from a test: a real `fs.WriteStream` destroyed
 * with a real error is what a full disk looks like from in here, and a mocked throw would not have caught
 * the bug this exists for.
 */
export function devLogStreamWriter(stream: WriteStream): DevLogWriter {
  let broken: unknown = null;
  stream.on("error", (error: Error) => {
    broken = error;
  });
  return {
    record: (record) => {
      if (broken === null) stream.write(`${formatDevLogRecord(record)}\n`);
    },
    // **A broken stream resolves straight away.** One that errored may never reach `'finish'`, and this
    // is awaited by the teardown that reaps the children and removes `.dev-state.json` — so a wait on it
    // would hang the shutdown rather than lose a log line.
    end: () =>
      new Promise<void>((resolve) => {
        if (broken !== null) {
          resolve();
          return;
        }
        stream.end(() => resolve());
      }),
  };
}

/** Every worker's log file for one session, opened on demand and remembered. */
export interface DevLogSinks {
  /** The directory the files are in, or `null` when this project has nowhere to put them. */
  dir: string | null;
  /** This worker's writer, opened on first ask and the same one after. */
  open: (worker: string) => Promise<DevLogWriter>;
  /** The writer already open for this worker, or a no-op when none is. Never opens one. */
  writer: (worker: string) => DevLogWriter;
  /** Close every file this session opened. */
  end: () => Promise<void>;
}

/**
 * Open-on-demand writers for one session's workers.
 *
 * **On demand rather than all at once**, because `r` on a parked worker's row starts a worker the run
 * never spawned: its file has to appear then, and a file opened for a worker that never started would be
 * an empty log claiming a session it had no part in. The memo is what makes a restart append.
 */
export function createDevLogSinks(args: {
  dir: string | null;
  branch: string | null | undefined;
  open?: OpenDevLog;
}): DevLogSinks {
  const open = args.open ?? openDevLogDefault;
  const writers = new Map<string, DevLogWriter>();
  const pending = new Map<string, Promise<DevLogWriter>>();
  const dir = args.dir;

  const openOne = async (worker: string): Promise<DevLogWriter> => {
    const already = writers.get(worker);
    if (already) return already;
    if (dir === null) {
      const none = nullDevLogWriter();
      writers.set(worker, none);
      return none;
    }
    const inflight = pending.get(worker);
    if (inflight) return inflight;
    const opening = open(join(dir, devLogFileName(args.branch, worker)))
      .then((writer) => {
        writers.set(worker, writer);
        pending.delete(worker);
        return writer;
      })
      .catch((error: unknown) => {
        // Said by the caller, never thrown here: `pithy dev` supervises Workers, and a log file that
        // could not be opened is a reason for a sentence rather than for a session that will not start.
        pending.delete(worker);
        throw error;
      });
    pending.set(worker, opening);
    return opening;
  };

  return {
    dir,
    open: openOne,
    writer: (worker) => writers.get(worker) ?? nullDevLogWriter(),
    end: async () => {
      await Promise.allSettled([...writers.values()].map((writer) => writer.end()));
    },
  };
}
