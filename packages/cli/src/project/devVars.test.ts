// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { removeDevVars, removeDevVarsContent, upsertDevVars, upsertDevVarsContent } from "./devVars";

describe("upsertDevVarsContent", () => {
  test("appends a new key to an empty file", () => {
    expect(upsertDevVarsContent("", { APP_TOKEN: "s" })).toBe("APP_TOKEN=s\n");
  });

  test("updates an existing key in place, preserving comments and other keys", () => {
    const before = "# creds\nCLOUDFLARE_ACCOUNT_ID=acct\nAPP_TOKEN=old\n";
    expect(upsertDevVarsContent(before, { APP_TOKEN: "new" })).toBe(
      "# creds\nCLOUDFLARE_ACCOUNT_ID=acct\nAPP_TOKEN=new\n",
    );
  });

  test("appends keys that are not present and updates ones that are, in one pass", () => {
    const before = "A=1\n";
    expect(upsertDevVarsContent(before, { A: "2", B: "3" })).toBe("A=2\nB=3\n");
  });

  test("collapses a duplicated key to a single line so the last-wins reader can't pick a stale value", () => {
    // parseDevVars takes the last occurrence; upsert must not leave an earlier-updated line shadowed.
    expect(upsertDevVarsContent("A=old1\nA=old2\n", { A: "new" })).toBe("A=new\n");
  });

  test("preserves a JSON-object value (the turnstile secret shape) verbatim", () => {
    const json = '{"visible":{"key":"1x0000"}}';
    expect(upsertDevVarsContent("", { "turnstile-secret-keys": json })).toBe(`turnstile-secret-keys=${json}\n`);
  });
});

describe("removeDevVarsContent", () => {
  test("drops only the named keys, keeping comments and others", () => {
    const before = "# creds\nA=1\nAPP_TOKEN=s\nB=2\n";
    expect(removeDevVarsContent(before, ["APP_TOKEN"])).toBe("# creds\nA=1\nB=2\n");
  });

  test("returns an empty string when the last key is removed", () => {
    expect(removeDevVarsContent("A=1\n", ["A"])).toBe("");
  });
});

describe("CRLF fidelity", () => {
  test("upsert preserves CRLF line endings", () => {
    const before = "# creds\r\nA=1\r\n";
    expect(upsertDevVarsContent(before, { A: "2" })).toBe("# creds\r\nA=2\r\n");
  });

  test("upsert appends a new key with CRLF when file uses CRLF", () => {
    const before = "A=1\r\n";
    expect(upsertDevVarsContent(before, { B: "2" })).toBe("A=1\r\nB=2\r\n");
  });

  test("remove preserves CRLF line endings", () => {
    const before = "A=1\r\nB=2\r\n";
    expect(removeDevVarsContent(before, ["A"])).toBe("B=2\r\n");
  });

  test("empty file defaults to LF on upsert", () => {
    expect(upsertDevVarsContent("", { A: "1" })).toBe("A=1\n");
  });
});

describe("upsertDevVars — the file it writes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-devvars-io-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates a .dev.vars owner-only, because that is the first thing written into it", async () => {
    // `pithy add` mints SECRETS_ENCRYPTION_KEYS into a file that may not exist yet. The umask is not a
    // permission policy for a credential file.
    const path = join(dir, ".dev.vars");
    await upsertDevVars(path, { SECRETS_ENCRYPTION_KEYS: '{"active":"k1"}' });
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
  });

  test("keeps the 0600 pithy init set, rather than handing it back the umask", async () => {
    const path = join(dir, ".dev.vars");
    await writeFile(path, "# copy this file\n");
    await chmod(path, 0o600);
    await upsertDevVars(path, { CLOUDFLARE_API_TOKEN: "tok" });
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
  });

  test("writes through a worker's symlink instead of detaching it into a stale copy", async () => {
    // apps/<worker>/.dev.vars links at the project's shared file. Detached, the worker keeps a private
    // copy that never sees another secret — and nothing afterwards repairs it.
    const shared = join(dir, ".dev.vars");
    await writeFile(shared, "SHARED=abc\n");
    const linked = join(dir, "worker.dev.vars");
    await symlink(shared, linked);

    await upsertDevVars(linked, { CLOUDFLARE_API_TOKEN: "tok" });

    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readFile(shared, "utf8")).toBe("SHARED=abc\nCLOUDFLARE_API_TOKEN=tok\n");
  });

  test("refuses a read it could not make, rather than replacing the file with only the new keys", async () => {
    // The third data loss of this exact `catch(() => "")` shape. Every read failure read as an empty
    // file, and the atomic write then landed a file holding *only* the upserted keys — every other
    // secret in `.dev.vars` gone, with no copy anywhere because the file is gitignored. `EACCES` on a
    // file that plainly exists is enough; no attacker is involved.
    const path = join(dir, ".dev.vars");
    await writeFile(path, 'CLOUDFLARE_API_TOKEN=tok\nSECRETS_ENCRYPTION_KEYS={"active":"k1"}\n');
    await chmod(path, 0o200); // -w-: writable, unreadable — the file is there and cannot be read back

    const failure = await upsertDevVars(path, { APP_TOKEN: "new" }).catch((error: unknown) => error);
    await chmod(path, 0o600);

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.detail).toContain("EACCES");
    expect(await readFile(path, "utf8")).toBe('CLOUDFLARE_API_TOKEN=tok\nSECRETS_ENCRYPTION_KEYS={"active":"k1"}\n');
  });

  test("removeDevVars refuses the same read, rather than reporting a key it never removed", async () => {
    // The sibling with the same shape. A read failure returned early and the caller printed success,
    // so the adopter was told a credential had been removed while it sat in the file untouched.
    const path = join(dir, ".dev.vars");
    await writeFile(path, "APP_TOKEN=tok\n");
    await chmod(path, 0o200);

    const failure = await removeDevVars(path, ["APP_TOKEN"]).catch((error: unknown) => error);
    await chmod(path, 0o600);

    expect(failure).toBeInstanceOf(PithyError);
    expect(await readFile(path, "utf8")).toBe("APP_TOKEN=tok\n");
  });

  test("an absent file is still absent — only ENOENT means there is nothing to preserve", async () => {
    const path = join(dir, ".dev.vars");
    await upsertDevVars(path, { APP_TOKEN: "tok" });
    expect(await readFile(path, "utf8")).toBe("APP_TOKEN=tok\n");
    await expect(removeDevVars(join(dir, "absent.dev.vars"), ["APP_TOKEN"])).resolves.toBeUndefined();
  });

  test("removes a key through the link too, so the shared file is what changes", async () => {
    const shared = join(dir, ".dev.vars");
    await writeFile(shared, "A=1\nB=2\n");
    const linked = join(dir, "worker.dev.vars");
    await symlink(shared, linked);

    await removeDevVars(linked, ["A"]);

    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readFile(shared, "utf8")).toBe("B=2\n");
  });
});
