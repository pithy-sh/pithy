// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { LOCK_STALE_MS, withFileLock } from "./fileLock";

const refusal = ({ lockPath, attempts }: { lockPath: string; attempts: number }) =>
  new InternalError({ message: `could not lock (${attempts})`, detail: lockPath });

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "pithy-lock-")), "thing.json");
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("withFileLock", () => {
  test("holds the lock beside the file while fn runs, and releases it after", async () => {
    const path = scratch();
    let held = false;
    await withFileLock(
      path,
      async () => {
        held = await exists(`${path}.lock`);
      },
      { refusal },
    );
    expect(held).toBe(true);
    expect(await exists(`${path}.lock`)).toBe(false);
  });

  test("releases the lock when fn throws, and lets the throw through", async () => {
    const path = scratch();
    await expect(withFileLock(path, async () => Promise.reject(new Error("boom")), { refusal })).rejects.toThrow(
      "boom",
    );
    expect(await exists(`${path}.lock`)).toBe(false);
  });

  test("serializes two holders: the second runs only after the first has finished", async () => {
    const path = scratch();
    const order: string[] = [];
    const first = withFileLock(
      path,
      async () => {
        order.push("first:in");
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("first:out");
      },
      { refusal, budget: { retryDelayMs: 5 } },
    );
    const second = withFileLock(
      path,
      async () => {
        order.push("second:in");
      },
      { refusal, budget: { retryDelayMs: 5 } },
    );
    await Promise.all([first, second]);
    expect(order).toEqual(["first:in", "first:out", "second:in"]);
  });

  test("a fresh lock survives a spent budget, and the refusal is the caller's, naming the attempts spent", async () => {
    const path = scratch();
    writeFileSync(`${path}.lock`, "{}");
    const failure = await withFileLock(path, async () => "ran", {
      refusal,
      budget: { maxAttempts: 3, retryDelayMs: 1 },
    }).catch((error: unknown) => error);
    expect((failure as InternalError).payload.message).toBe("could not lock (3)");
    expect(await exists(`${path}.lock`)).toBe(true);
  });

  test("a lock older than LOCK_STALE_MS is reclaimed rather than holding forever", async () => {
    const path = scratch();
    writeFileSync(`${path}.lock`, "{}");
    const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
    utimesSync(`${path}.lock`, old, old);
    expect(await withFileLock(path, async () => "ran", { refusal, budget: { retryDelayMs: 1 } })).toBe("ran");
  });
});
