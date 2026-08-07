// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DEV_SECRETS_FILE } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devSecretsPath, mergeDevSecretsContent, readDevSecrets, removeDevSecrets, writeDevSecrets } from "./file";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-dev-secrets-"));
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("readDevSecrets", () => {
  test("an absent file is no secrets, not an error — a project starts without one", async () => {
    expect(await readDevSecrets(dir)).toEqual({});
  });

  test("reads envelopes through the loader's validation", async () => {
    await writeFile(
      devSecretsPath(dir),
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "abc" } } }',
    );
    expect(await readDevSecrets(dir)).toEqual({
      "auth-session-secret": { currentVersion: "1", versions: { "1": "abc" } },
    });
  });

  test("comments and a trailing comma are the point of JSONC — both parse", async () => {
    await writeFile(
      devSecretsPath(dir),
      `// The session key.
{
  // Minted by pithy add auth.
  "auth-session-secret": { "currentVersion": "1", "versions": { "1": "abc" } },
}
`,
    );
    expect(Object.keys(await readDevSecrets(dir))).toEqual(["auth-session-secret"]);
  });

  test("an unreadable file is not an absent one — only ENOENT means there are no secrets", async () => {
    // `.catch(() => null)` answered `{}` for every errno. An EACCES or EIO then merged into an empty
    // base, and the file's real contents were gone — silently, on a file holding OAuth client secrets.
    await mkdir(devSecretsPath(dir));

    const error = await readDevSecrets(dir).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(DEV_SECRETS_FILE);
  });

  test("a zero-byte file is no secrets, the same answer the write path gives", async () => {
    // `touch .dev.secrets.jsonc` failed `pithy add` with exit 1 while `mergeDevSecretsContent` was
    // deciding that empty content meant `{}`. One state, two answers, in one module.
    await writeFile(devSecretsPath(dir), "");
    expect(await readDevSecrets(dir)).toEqual({});
  });

  test("a malformed file names the real path, not the default", async () => {
    await writeFile(devSecretsPath(dir), "{ nope }");
    const error = await readDevSecrets(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(join(dir, DEV_SECRETS_FILE));
  });
});

describe("mergeDevSecretsContent", () => {
  test("an empty file is written with the header that says what belongs here", () => {
    const out = mergeDevSecretsContent("", { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    expect(out).toContain("Gitignored");
    expect(out).toContain('"auth-session-secret"');
  });

  test("an adopter's comments survive a write-back — the file is hand-edited", () => {
    const source = `// Ours.
{
  // Google's console gave us this.
  "auth-google-credentials": { "currentVersion": "1", "versions": { "1": { "clientId": "a" } } }
}
`;
    const out = mergeDevSecretsContent(source, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "minted" } },
    });
    expect(out).toContain("// Ours.");
    expect(out).toContain("// Google's console gave us this.");
    expect(out).toContain('"auth-session-secret"');
  });

  test("an existing secret is never overwritten — a fresh session key invalidates every live session", () => {
    const source = '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "kept" } } }';
    const out = mergeDevSecretsContent(source, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "fresh" } },
    });
    expect(out).toContain("kept");
    expect(out).not.toContain("fresh");
  });

  test("nothing to add returns the source byte for byte — no churn on a re-run", () => {
    const source = '// keep\n{\n  "a-b": { "currentVersion": "1", "versions": { "1": "v" } },\n}\n';
    expect(mergeDevSecretsContent(source, {})).toBe(source);
  });

  test("a name matching an Object.prototype key is added like any other", () => {
    // `name in tree` walked the prototype chain, so such a name read as already present and was
    // silently dropped — a mint the caller was told had landed.
    const out = mergeDevSecretsContent("{}", { toString: { currentVersion: "1", versions: { "1": "v" } } });

    expect(out).toContain('"toString"');
  });
});

describe("writeDevSecrets", () => {
  test("the file it creates is 0600 — it holds OAuth client secrets", async () => {
    await writeDevSecrets(dir, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    expect((await stat(devSecretsPath(dir))).mode & 0o777).toBe(0o600);
  });

  test("0600 survives the second write, which is where the atomic rename used to widen it", async () => {
    await writeDevSecrets(dir, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    await writeDevSecrets(dir, { "email-link-signing-key": { currentVersion: "1", versions: { "1": "k" } } });
    expect((await stat(devSecretsPath(dir))).mode & 0o777).toBe(0o600);
  });

  test("writes nothing when there is nothing to add — no empty file appears from a no-op add", async () => {
    await writeDevSecrets(dir, {});
    await expect(readFile(devSecretsPath(dir), "utf8")).rejects.toThrow();
  });

  test("what it writes reads back through the loader", async () => {
    await writeDevSecrets(dir, {
      "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "a", clientSecret: "b" } } },
    });
    expect(await readDevSecrets(dir)).toEqual({
      "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "a", clientSecret: "b" } } },
    });
  });

  test("returns the names it actually added, so the caller reports minting rather than assuming it", async () => {
    const first = await writeDevSecrets(dir, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } },
    });
    const second = await writeDevSecrets(dir, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "other" } },
    });
    expect(first).toEqual({ added: ["auth-session-secret"], refused: null });
    expect(second).toEqual({ added: [], refused: null });
  });

  test("the project's .gitignore is made to cover the file before a value goes into it", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");

    await writeDevSecrets(dir, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });

    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(ignore).toContain(DEV_SECRETS_FILE);
    expect(ignore).toContain(`${DEV_SECRETS_FILE}.tmp`);
  });

  test("a project whose .gitignore cannot be fixed gets no secret at all, and is told what to add", async () => {
    // Mint first and hope is not a guarantee. The value never leaves memory: a live signing secret in
    // a file git will commit is worse than a `pithy add` that stopped and said one sentence.
    await chmod(dir, 0o500);
    try {
      const result = await writeDevSecrets(dir, {
        "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } },
      });

      expect(result.added).toEqual([]);
      expect(result.refused).toContain(DEV_SECRETS_FILE);
      await expect(readFile(devSecretsPath(dir), "utf8")).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }
  });

  test("a write over an unreadable file refuses rather than replacing it with the new value alone", async () => {
    // The merge base comes from that read. Treating a failed read as empty content is how a write
    // replaces a file of secrets with the one value it happened to be adding.
    await mkdir(devSecretsPath(dir));

    await expect(
      writeDevSecrets(dir, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } }),
    ).rejects.toThrow(PithyError);
  });

  test("nothing to add checks nothing — a no-op add does not touch the adopter's .gitignore", async () => {
    await writeDevSecrets(dir, {});
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toThrow();
  });
});

describe("writeDevSecrets({ replace })", () => {
  test("a provisioned value replaces the one in the file — it is issued, not minted", async () => {
    // `pithy turnstile provision` receives the widget secret from Cloudflare. Keeping the old value
    // because one is already there would leave the project verifying against a widget it no longer has.
    await writeFile(
      devSecretsPath(dir),
      '{ "turnstile-secret-keys": { "currentVersion": "1", "versions": { "1": "old" } } }',
    );

    const result = await writeDevSecrets(
      dir,
      { "turnstile-secret-keys": { currentVersion: "1", versions: { "1": "new" } } },
      { replace: true },
    );

    expect(result.added).toEqual(["turnstile-secret-keys"]);
    expect(await readDevSecrets(dir)).toEqual({
      "turnstile-secret-keys": { currentVersion: "1", versions: { "1": "new" } },
    });
  });

  test("replacing a value with itself writes nothing — a re-provision must not churn the file", async () => {
    const content = '{ "turnstile-secret-keys": { "currentVersion": "1", "versions": { "1": "same" } } }';
    await writeFile(devSecretsPath(dir), content);

    const result = await writeDevSecrets(
      dir,
      { "turnstile-secret-keys": { currentVersion: "1", versions: { "1": "same" } } },
      { replace: true },
    );

    expect(result.added).toEqual([]);
    expect(await readFile(devSecretsPath(dir), "utf8")).toBe(content);
  });

  test("without replace a present value still wins — a mint never overwrites", async () => {
    await writeFile(
      devSecretsPath(dir),
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "old" } } }',
    );

    const result = await writeDevSecrets(dir, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "new" } },
    });

    expect(result.added).toEqual([]);
    expect(await readDevSecrets(dir)).toEqual({
      "auth-session-secret": { currentVersion: "1", versions: { "1": "old" } },
    });
  });
});

describe("removeDevSecrets", () => {
  test("a deprovisioned secret leaves the file, comments and siblings intact", async () => {
    await writeFile(
      devSecretsPath(dir),
      `{
  // minted by pithy add auth
  "auth-session-secret": { "currentVersion": "1", "versions": { "1": "keep" } },
  "turnstile-secret-keys": { "currentVersion": "1", "versions": { "1": "gone" } }
}
`,
    );

    expect(await removeDevSecrets(dir, ["turnstile-secret-keys"])).toEqual(["turnstile-secret-keys"]);

    const content = await readFile(devSecretsPath(dir), "utf8");
    expect(content).toContain("minted by pithy add auth");
    expect(Object.keys(await readDevSecrets(dir))).toEqual(["auth-session-secret"]);
  });

  test("a name that is not there writes nothing at all — teardown is idempotent", async () => {
    const content = '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "keep" } } }';
    await writeFile(devSecretsPath(dir), content);

    expect(await removeDevSecrets(dir, ["turnstile-secret-keys"])).toEqual([]);
    expect(await readFile(devSecretsPath(dir), "utf8")).toBe(content);
  });

  test("no file is nothing to remove — a deprovision on a project that never had one is silent", async () => {
    expect(await removeDevSecrets(dir, ["turnstile-secret-keys"])).toEqual([]);
    await expect(readFile(devSecretsPath(dir), "utf8")).rejects.toThrow();
  });
});
