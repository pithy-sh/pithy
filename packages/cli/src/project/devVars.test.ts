// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { removeDevVars, removeDevVarsContent, upsertDevVarsContent } from "./devVars";

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

describe("removeDevVars", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-remove-dev-vars-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("leaves the file at 0600 — deprovisioning must not widen a file holding session keys", async () => {
    // `pithy turnstile deprovision` is the only caller, and it passed no mode at all: the atomic write
    // renames a temp file created at the umask over a `.dev.vars` that `pithy init` chmods to 0600, so
    // deleting one key handed the whole file — `SECRETS_ENCRYPTION_KEYS` included — back to 0644.
    const path = join(dir, ".dev.vars");
    await writeFile(path, "A=1\nturnstile-secret-keys=x\n");
    await chmod(path, 0o600);

    await removeDevVars(path, ["turnstile-secret-keys"]);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
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
