// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { nodeMediaFs } from "./media";

/**
 * The default {@link nodeMediaFs} seam. The orchestrator's suites drive the once/always logic against an
 * in-memory fake, so the real `node:fs` implementation had no test of its own — and its one decision is
 * the one this repository has now paid for four times: **absent is `ENOENT` and nothing else.**
 *
 * A sidecar that is there and will not open reading as `null` means "never uploaded", which re-uploads
 * the asset and renames a fresh id over the one recorded in it.
 */
describe("nodeMediaFs.readText", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-media-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a sidecar that is there comes back as its bytes", async () => {
    const path = join(dir, "hero.ref.json");
    await writeFile(path, '{ "id": "abc" }');
    expect(await nodeMediaFs.readText(path)).toBe('{ "id": "abc" }');
  });

  test("a sidecar that was never written is null — the first-run state", async () => {
    expect(await nodeMediaFs.readText(join(dir, "never.ref.json"))).toBeNull();
  });

  test("a sidecar that is there and will not open is a PithyError naming it, never null", async () => {
    // A directory where the file should be: EISDIR from `readFile` for every uid, root included.
    const path = join(dir, "unreadable.ref.json");
    await mkdir(path);

    const thrown = (await nodeMediaFs.readText(path).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    // The sidecar, and an action — a raw errno with a stack is not something an adopter can act on.
    expect(thrown.payload.message).toContain(path);
    expect(thrown.payload.action ?? "").not.toBe("");
    // The errno stays in `detail`, which the HTTP codec strips, and node's error survives as the cause.
    expect(thrown.payload.detail).toContain("EISDIR");
    expect((thrown.cause as { code?: string } | undefined)?.code).toBe("EISDIR");
  });
});
