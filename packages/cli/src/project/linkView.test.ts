// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeFileAtomic } from "./atomic";
import { linkStandingAt, lstatAsProject, withLinkStandIns } from "./linkView";
import { ensureEmptyTarget, ensureScaffoldPath, pathExists } from "./scaffold";

/**
 * **The guards answer a dry run's copy as they would the project (#697).** In the copy, a link out of the project
 * to a directory is a real directory holding a snapshot, and every guard that refuses a link has to refuse it all
 * the same — or the dry run plans what the real run refuses. These register a stand-in by hand, the way the copy
 * does, and hold each guard to it; and hold the seam to being plain `lstat` everywhere else.
 */

let dir: string;
/** A real link, to stand in for: its `lstat` is what the copy registers. */
let link: Stats;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "pithy-linkview-")));
  await mkdir(join(dir, "elsewhere"));
  await symlink(join(dir, "elsewhere"), join(dir, "link"));
  link = await lstat(join(dir, "link"));
  // What the copy holds where the project has that link: a directory, with something in it.
  await mkdir(join(dir, "apps", "api", "src"), { recursive: true });
  await writeFile(join(dir, "apps", "api", "src", "index.ts"), "export {};\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run `work` with `apps/api/src` standing in for a link whose `lstat` is `stats`. */
const asLink = <T>(work: () => Promise<T>, stats: Stats = link) =>
  withLinkStandIns(new Map([[join(dir, "apps", "api", "src"), stats]]), work);

describe("lstatAsProject", () => {
  test("is lstat where nothing stands in", async () => {
    expect((await lstatAsProject(join(dir, "link"))).isSymbolicLink()).toBe(true);
    expect((await lstatAsProject(join(dir, "apps", "api", "src"))).isDirectory()).toBe(true);
    expect(linkStandingAt(join(dir, "apps", "api", "src"))).toBeUndefined();
  });

  test("answers for a stand-in with the link's own lstat, by any spelling of its path, and nowhere else", async () => {
    await asLink(async () => {
      expect((await lstatAsProject(join(dir, "apps", "api", "src"))).isSymbolicLink()).toBe(true);
      expect(linkStandingAt(`${dir}/apps/api/./src`)).toBe(link);
      expect((await lstatAsProject(join(dir, "apps", "api", "src", "index.ts"))).isFile()).toBe(true);
    });
    // Scoped to the work it was registered for.
    expect(linkStandingAt(join(dir, "apps", "api", "src"))).toBeUndefined();
  });
});

describe("the guards, through a stand-in", () => {
  test("the scaffold gate refuses a stand-in as the symlink it stands for", async () => {
    const refusal = await asLink(() => ensureScaffoldPath(dir, join(dir, "apps", "api", "src", "routes"))).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as ConflictError).payload.message).toBe("apps/api/src is a symlink.");
    // And without one, the same directory is no refusal at all.
    await expect(ensureScaffoldPath(dir, join(dir, "apps", "api", "src", "routes"))).resolves.toBeUndefined();
  });

  test("a directory Pithy takes over is refused when it stands in for a link, however empty it reads", async () => {
    await rm(join(dir, "apps", "api", "src", "index.ts"));
    await expect(
      asLink(() => ensureEmptyTarget(join(dir, "apps", "api"), join(dir, "apps", "api", "src"))),
    ).rejects.toThrow(/src is a symlink/);
    await expect(ensureEmptyTarget(join(dir, "apps", "api"), join(dir, "apps", "api", "src"))).resolves.toBeUndefined();
  });

  test("something is there, link or snapshot", async () => {
    expect(await asLink(() => pathExists(join(dir, "apps", "api", "src")))).toBe(true);
  });

  test("the atomic writer checks a stand-in's owner as it checks every link it follows", async () => {
    const target = join(dir, "apps", "api", "src", "index.ts");
    // A link the run's own user made is followed, so the write lands.
    await asLink(() => writeFileAtomic(target, "export const a = 1;\n"));
    expect(await readFile(target, "utf8")).toBe("export const a = 1;\n");
    // One somebody else made is refused, before anything is written.
    const us = process.geteuid?.();
    if (us === undefined) return;
    const foreign = Object.assign(Object.create(Object.getPrototypeOf(link)) as Stats, link, { uid: us + 4242 });
    const refusal = await asLink(() => writeFileAtomic(target, "export const a = 2;\n"), foreign).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as ConflictError).payload.message).toContain("is a symlink somebody else owns.");
    expect(await readFile(target, "utf8")).toBe("export const a = 1;\n");
  });
});
