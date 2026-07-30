// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmodSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendToRcFile, readRcFile, removeFromRcFile } from "./rc";

const OPEN = "# >>> pithy alias >>>";
const CLOSE = "# <<< pithy alias <<<";

let home: string;
let outside: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pithy-home-"));
  outside = await mkdtemp(join(tmpdir(), "pithy-out-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("readRcFile", () => {
  test("returns '' when the file does not exist", async () => {
    expect(await readRcFile(join(home, "nope"))).toBe("");
  });

  test("returns the file contents when it exists", async () => {
    const path = join(home, ".zshrc");
    await writeFile(path, "export FOO=1\n");
    expect(await readRcFile(path)).toBe("export FOO=1\n");
  });
});

describe("appendToRcFile", () => {
  test("creates a missing file with mode 0644, including parent directories", async () => {
    const path = join(home, ".config", "fish", "config.fish");
    await appendToRcFile(path, "line\n");
    expect(await readFile(path, "utf8")).toBe("line\n");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  test("appends to an existing file without rewriting it", async () => {
    const path = join(home, ".zshrc");
    await writeFile(path, "export FOO=1\n");
    await appendToRcFile(path, "added\n");
    expect(await readFile(path, "utf8")).toBe("export FOO=1\nadded\n");
  });

  test("refuses a read-only file with a PithyError and changes nothing", async () => {
    const path = join(home, ".zshrc");
    await writeFile(path, "keep\n");
    chmodSync(path, 0o444);
    await expect(appendToRcFile(path, "added\n")).rejects.toThrow(PithyError);
    chmodSync(path, 0o644);
    expect(await readFile(path, "utf8")).toBe("keep\n");
  });

  test("refuses a symlink whose target is outside the home directory", async () => {
    const evil = join(outside, "evil");
    await writeFile(evil, "secret\n");
    const path = join(home, ".zshrc");
    await symlink(evil, path);
    await expect(appendToRcFile(path, "added\n")).rejects.toThrow(PithyError);
    expect(await readFile(evil, "utf8")).toBe("secret\n");
  });

  test("allows a symlink whose target is inside the home directory", async () => {
    const real = join(home, "real-rc");
    await writeFile(real, "keep\n");
    const path = join(home, ".zshrc");
    await symlink(real, path);
    await appendToRcFile(path, "added\n");
    expect(await readFile(real, "utf8")).toBe("keep\nadded\n");
  });

  test("refuses a DANGLING symlink pointing outside home, never creating the escaped target", async () => {
    // The target does not exist yet — a plain existsSync (which follows the link) would report the path
    // absent and skip the guard, then create the file outside home. lstat must still catch the symlink.
    const evil = join(outside, "planted");
    const path = join(home, ".zshrc");
    await symlink(evil, path);
    await expect(appendToRcFile(path, "added\n")).rejects.toThrow(PithyError);
    await expect(readFile(evil, "utf8")).rejects.toThrow(); // the escaped target was never created
  });
});

describe("removeFromRcFile", () => {
  test("removes only the marker block, leaving other lines intact", async () => {
    const path = join(home, ".zshrc");
    await writeFile(path, "export FOO=1\n");
    await appendToRcFile(path, `\n${[OPEN, "alias p.='pithy'", CLOSE].join("\n")}\n`);
    await appendToRcFile(path, "alias bar='baz'\n");

    expect(await removeFromRcFile(path, OPEN, CLOSE)).toBe(true);
    const after = await readFile(path, "utf8");
    expect(after).toContain("export FOO=1");
    expect(after).toContain("alias bar='baz'");
    expect(after).not.toContain(OPEN);
    expect(after).not.toContain("alias p.='pithy'");
  });

  test("returns false and changes nothing when no block is present", async () => {
    const path = join(home, ".zshrc");
    await writeFile(path, "export FOO=1\n");
    expect(await removeFromRcFile(path, OPEN, CLOSE)).toBe(false);
    expect(await readFile(path, "utf8")).toBe("export FOO=1\n");
  });

  test("returns false when the file does not exist", async () => {
    expect(await removeFromRcFile(join(home, "nope"), OPEN, CLOSE)).toBe(false);
  });
});
