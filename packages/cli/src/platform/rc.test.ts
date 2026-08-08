// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmodSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  test("an rc file that is there and will not open is a PithyError naming it, not node's own", async () => {
    // The two commands that read an rc file — `pithy alias` and `pithy doctor` — are the two most likely
    // to be run *because* something is already wrong. A bare EACCES with a stack is the failure the error
    // model exists to prevent. A directory where the file should be is EISDIR for every uid, root included.
    const path = join(home, ".zshrc");
    await mkdir(path);

    const thrown = (await readRcFile(path).catch((error: unknown) => error)) as PithyError;
    expect(thrown).toBeInstanceOf(PithyError);
    // The file, so the adopter knows which one; an action, so they know what to do about it.
    expect(thrown.payload.message).toContain(path);
    expect(thrown.payload.action ?? "").not.toBe("");
    // The errno stays in `detail`, which the HTTP codec strips, with node's own error as the cause.
    expect(thrown.payload.detail).toContain("EISDIR");
    expect((thrown.cause as { code?: string } | undefined)?.code).toBe("EISDIR");
  });

  test("the refusal carries no line of the rc file it could not read", async () => {
    // An rc file is where a developer keeps `export GITHUB_TOKEN=…`. A refusal that quotes it is a leak.
    const path = join(home, ".zshrc");
    await writeFile(path, "export GITHUB_TOKEN=super-secret-value\n");
    await chmod(path, 0o000);

    const thrown = await readRcFile(path).catch((error: unknown) => error);
    if (typeof thrown === "string") return; // root reads a 0o000 file; nothing to assert on this box.
    expect(JSON.stringify((thrown as PithyError).payload)).not.toContain("super-secret-value");
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
