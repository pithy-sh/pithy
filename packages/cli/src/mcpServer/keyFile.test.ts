// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test } from "vitest";
import {
  generateAgentKey,
  importSigningKey,
  keyFilePath,
  keyFileProblem,
  readAgentKey,
  removeAgentKey,
  writeAgentKey,
} from "./keyFile";

const posix = process.platform !== "win32";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-keys-"));
});

describe("writeAgentKey", () => {
  test.runIf(posix)("writes the key 0600 in a 0700 directory", async () => {
    const path = keyFilePath("conn-1", join(dir, "keys"));
    await writeAgentKey(path, await generateAgentKey("mcp-1"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "keys"))).mode & 0o777).toBe(0o700);
  });

  test("names the file after the connection", () => {
    expect(keyFilePath("4b0e", "/k")).toBe(join("/k", "4b0e.jwk"));
  });
});

describe("readAgentKey", () => {
  test("reads back a key it can sign with", async () => {
    const path = keyFilePath("conn-1", dir);
    const written = await generateAgentKey("mcp-1");
    await writeAgentKey(path, written);
    const read = await readAgentKey(path);
    expect(read).toEqual(written);
    const key = await importSigningKey(read);
    expect(key.type).toBe("private");
  });

  test.runIf(posix)("refuses a key others can read, naming chmod 600", async () => {
    const path = keyFilePath("conn-1", dir);
    await writeAgentKey(path, await generateAgentKey("mcp-1"));
    await chmod(path, 0o644);
    const refusal = await readAgentKey(path).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PithyError);
    expect((refusal as PithyError).payload.message).toContain("mode 0644, readable by others");
    expect((refusal as PithyError).payload.action).toBe(`Run chmod 600 ${path}, then start the server again.`);
  });

  test.runIf(posix)("refuses a key another user owns, naming the fix", async () => {
    const path = keyFilePath("conn-1", dir);
    await writeAgentKey(path, await generateAgentKey("mcp-1"));
    const owner = (await stat(path)).uid;
    const refusal = await readAgentKey(path, { uid: owner + 1 }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.message).toContain("belongs to another user");
    expect((refusal as PithyError).payload.action).toContain("as this user");
  });

  test("refuses a symlink, which could point at any key", async () => {
    const real = join(dir, "real.jwk");
    await writeFile(real, "{}", { mode: 0o600 });
    const path = keyFilePath("conn-1", dir);
    await symlink(real, path);
    expect(await keyFileProblem(path)).toContain("is a symlink");
  });

  test("on Windows the mode says nothing, so it is not read", async () => {
    const path = keyFilePath("conn-1", dir);
    await writeAgentKey(path, await generateAgentKey("mcp-1"));
    if (posix) await chmod(path, 0o644);
    expect(await keyFileProblem(path, { platform: "win32" })).toBeNull();
  });

  test("a missing key says so, and names connect", async () => {
    const refusal = await readAgentKey(join(dir, "nope.jwk")).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.message).toContain("is not there");
    expect((refusal as PithyError).payload.action).toContain("pithy mcp connect");
  });
});

describe("removeAgentKey", () => {
  test("removes the file, and a second removal is not an error", async () => {
    const path = keyFilePath("conn-1", dir);
    await writeAgentKey(path, await generateAgentKey("mcp-1"));
    expect(await removeAgentKey(path)).toBe(true);
    expect(await removeAgentKey(path)).toBe(false);
  });
});
