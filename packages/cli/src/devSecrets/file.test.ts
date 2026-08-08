// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mergeDevSecretsContent, readDevSecrets, removeDevSecrets, writeDevSecrets } from "./file";
import { devSecretsFile } from "./location";

let config: string;
/** The resolved absolute path every function here takes — `<config>/replay/secrets.jsonc`. */
let path: string;
beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "pithy-dev-secrets-"));
  path = devSecretsFile("replay", { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } });
});
afterEach(async () => {
  await chmod(config, 0o700).catch(() => {});
  await chmod(dirname(path), 0o700).catch(() => {});
  await rm(config, { recursive: true, force: true });
});

/** Put a file at the resolved path, creating the project directory the CLI would have created. */
async function seedFile(contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents);
}

describe("readDevSecrets", () => {
  test("an absent file is no secrets, not an error — a project starts without one", async () => {
    expect(await readDevSecrets(path)).toEqual({});
  });

  test("reads envelopes through the loader's validation", async () => {
    await seedFile('{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "abc" } } }');
    expect(await readDevSecrets(path)).toEqual({
      "auth-session-secret": { currentVersion: "1", versions: { "1": "abc" } },
    });
  });

  test("comments and a trailing comma are the point of JSONC — both parse", async () => {
    await seedFile(
      `// The session key.
{
  // Minted by pithy add auth.
  "auth-session-secret": { "currentVersion": "1", "versions": { "1": "abc" } },
}
`,
    );
    expect(Object.keys(await readDevSecrets(path))).toEqual(["auth-session-secret"]);
  });

  test("an unreadable file is not an absent one — only ENOENT means there are no secrets", async () => {
    // `.catch(() => null)` answered `{}` for every errno. An EACCES or EIO then merged into an empty
    // base, and the file's real contents were gone — silently, on a file holding OAuth client secrets.
    await mkdir(path, { recursive: true });

    const error = await readDevSecrets(path).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(path);
  });

  test("a zero-byte file is no secrets, the same answer the write path gives", async () => {
    // `touch` on the file failed `pithy add` with exit 1 while `mergeDevSecretsContent` was deciding
    // that empty content meant `{}`. One state, two answers, in one module.
    await seedFile("");
    expect(await readDevSecrets(path)).toEqual({});
  });

  test("a malformed file names the absolute path — it is outside the checkout and nothing else names it", async () => {
    await seedFile("{ nope }");
    const error = await readDevSecrets(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain(path);
  });
});

describe("mergeDevSecretsContent", () => {
  test("an empty file is written with the header that says what belongs here", () => {
    const out = mergeDevSecretsContent("", { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    expect(out).toContain("outside every checkout");
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
  test("the file it creates is 0600 and its directory 0700 — both hold OAuth client secrets", async () => {
    await writeDevSecrets(path, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  test("it creates the project directory itself — nothing else in the run has been there", async () => {
    // The file is outside the checkout, so no scaffold, no `pithy init`, and no worktree setup has
    // made this directory. A first `pithy add` on a fresh machine is the only thing that will.
    await writeDevSecrets(path, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    expect(await readdir(config)).toEqual(["replay"]);
  });

  test("0600 survives the second write, which is where the atomic rename used to widen it", async () => {
    await writeDevSecrets(path, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    await writeDevSecrets(path, { "email-link-signing-key": { currentVersion: "1", versions: { "1": "k" } } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a file already world-readable is tightened, even when its content needs no write", async () => {
    // `.dev.vars` got this and its sibling did not, so a secrets file created at the umask — by an
    // older pithy, an editor, a `cp` — stayed 0644 forever while holding OAuth client secrets. The one
    // thing that set the mode was a write, and a re-run's write never has to happen.
    const envelope = { currentVersion: "1", versions: { "1": "s" } };
    await writeDevSecrets(path, { "auth-session-secret": envelope });
    await chmod(path, 0o644);

    expect(await writeDevSecrets(path, { "auth-session-secret": envelope })).toEqual([]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a directory left at 0755 is narrowed on a later write — its listing names every secret", async () => {
    // `mkdir`'s `mode` applies only to a directory it creates, so a project directory made by an older
    // pithy, a `cp -r`, or a restore keeps 0755 forever while `ls` on it names the provider and the
    // vendor of every credential in the project.
    await writeDevSecrets(path, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    await chmod(dirname(path), 0o755);

    await writeDevSecrets(path, { "email-link-signing-key": { currentVersion: "1", versions: { "1": "k" } } });

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  test("a file already world-readable is tightened when the caller has nothing to add at all", async () => {
    // The shape every real caller has: `pithy add` filters out what is already in the file and hands
    // this an empty set, so a re-run never reaches the merge. Tightening only past that point left the
    // most common run of all doing nothing — `pithy add auth` twice, with a `chmod 644` between, and
    // the file stayed 644.
    await writeDevSecrets(path, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } });
    await chmod(path, 0o644);

    await writeDevSecrets(path, {});

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a deliberately tighter mode survives — this narrows, it never widens", async () => {
    const envelope = { currentVersion: "1", versions: { "1": "s" } };
    await writeDevSecrets(path, { "auth-session-secret": envelope });
    await chmod(path, 0o400);
    try {
      await writeDevSecrets(path, { "auth-session-secret": envelope });
      expect((await stat(path)).mode & 0o777).toBe(0o400);
    } finally {
      await chmod(path, 0o600);
    }
  });

  test("writes nothing when there is nothing to add — no empty file, and no directory either", async () => {
    await writeDevSecrets(path, {});
    await expect(readFile(path, "utf8")).rejects.toThrow();
    expect(await readdir(config)).toEqual([]);
  });

  test("what it writes reads back through the loader", async () => {
    await writeDevSecrets(path, {
      "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "a", clientSecret: "b" } } },
    });
    expect(await readDevSecrets(path)).toEqual({
      "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "a", clientSecret: "b" } } },
    });
  });

  test("returns the names it actually added, so the caller reports minting rather than assuming it", async () => {
    const first = await writeDevSecrets(path, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } },
    });
    const second = await writeDevSecrets(path, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "other" } },
    });
    expect(first).toEqual(["auth-session-secret"]);
    expect(second).toEqual([]);
  });

  test("a project whose checkout cannot be written to still gets its secret — the file is not in it", async () => {
    // This is the acceptance criterion of the move, stated as a behaviour. The write used to be gated
    // on making the project's `.gitignore` cover the file, so a read-only checkout refused the mint
    // outright. There is nothing in the repository to ignore now, and nothing in the repository to
    // write, so the checkout's state has no say at all.
    const project = await mkdtemp(join(tmpdir(), "pithy-dev-secrets-ro-"));
    await chmod(project, 0o500);
    try {
      expect(
        await writeDevSecrets(path, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } }),
      ).toEqual(["auth-session-secret"]);
      expect(await readdir(project)).toEqual([]);
    } finally {
      await chmod(project, 0o700);
      await rm(project, { recursive: true, force: true });
    }
  });

  test("a write over an unreadable file refuses rather than replacing it with the new value alone", async () => {
    // The merge base comes from that read. Treating a failed read as empty content is how a write
    // replaces a file of secrets with the one value it happened to be adding.
    await mkdir(path, { recursive: true });

    await expect(
      writeDevSecrets(path, { "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } } }),
    ).rejects.toThrow(PithyError);
  });
});

describe("writeDevSecrets({ replace })", () => {
  test("a provisioned value replaces the one in the file — it is issued, not minted", async () => {
    // `pithy turnstile provision` receives the widget secret from Cloudflare. Keeping the old value
    // because one is already there would leave the project verifying against a widget it no longer has.
    await seedFile('{ "turnstile-secret-keys": { "currentVersion": "1", "versions": { "1": "old" } } }');

    const added = await writeDevSecrets(
      path,
      { "turnstile-secret-keys": { currentVersion: "1", versions: { "1": "new" } } },
      { replace: true },
    );

    expect(added).toEqual(["turnstile-secret-keys"]);
    expect(await readDevSecrets(path)).toEqual({
      "turnstile-secret-keys": { currentVersion: "1", versions: { "1": "new" } },
    });
  });

  test("replacing a value with itself writes nothing — a re-provision must not churn the file", async () => {
    const content = '{ "turnstile-secret-keys": { "currentVersion": "1", "versions": { "1": "same" } } }';
    await seedFile(content);

    const added = await writeDevSecrets(
      path,
      { "turnstile-secret-keys": { currentVersion: "1", versions: { "1": "same" } } },
      { replace: true },
    );

    expect(added).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("without replace a present value still wins — a mint never overwrites", async () => {
    await seedFile('{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "old" } } }');

    const added = await writeDevSecrets(path, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "new" } },
    });

    expect(added).toEqual([]);
    expect(await readDevSecrets(path)).toEqual({
      "auth-session-secret": { currentVersion: "1", versions: { "1": "old" } },
    });
  });
});

describe("removeDevSecrets", () => {
  test("a deprovisioned secret leaves the file, comments and siblings intact", async () => {
    await seedFile(
      `{
  // minted by pithy add auth
  "auth-session-secret": { "currentVersion": "1", "versions": { "1": "keep" } },
  "turnstile-secret-keys": { "currentVersion": "1", "versions": { "1": "gone" } }
}
`,
    );

    expect(await removeDevSecrets(path, ["turnstile-secret-keys"])).toEqual(["turnstile-secret-keys"]);

    const content = await readFile(path, "utf8");
    expect(content).toContain("minted by pithy add auth");
    expect(Object.keys(await readDevSecrets(path))).toEqual(["auth-session-secret"]);
  });

  test("a name that is not there writes nothing at all — teardown is idempotent", async () => {
    const content = '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "keep" } } }';
    await seedFile(content);

    expect(await removeDevSecrets(path, ["turnstile-secret-keys"])).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("no file is nothing to remove — a deprovision on a project that never had one is silent", async () => {
    expect(await removeDevSecrets(path, ["turnstile-secret-keys"])).toEqual([]);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});

describe("a malformed file on the write path", () => {
  /** Every string a thrown error can carry to a terminal or a log. */
  function surfaces(error: unknown): string {
    const e = error as { message?: string; action?: string; detail?: string; stack?: string };
    return [e.message, e.action, e.detail, e.stack].filter(Boolean).join("\n");
  }

  test("prints no secret it could not parse, and names the absolute path it could not parse", async () => {
    // `comment-json`'s SyntaxError reads `Unexpected token … "<the entire file>" is not valid JSON`.
    // The write path re-parsed with a bare `parse` and no catch, so one missing brace put every OAuth
    // client secret in the file onto the terminal — the opposite of what this module's docstring says
    // it does, and the loader had already been taught not to.
    await seedFile(
      `{ "auth-google-credentials": { "currentVersion": "1", "versions": { "1": "SUPER-SECRET-VALUE" } } oops }`,
    );

    const error = await writeDevSecrets(path, {
      "auth-session-secret": { currentVersion: "1", versions: { "1": "s" } },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PithyError);
    expect(surfaces(error)).not.toContain("SUPER-SECRET-VALUE");
    expect(surfaces(error)).toContain(path);
  });

  test("removeDevSecrets is the same boundary, and says the same thing", async () => {
    await seedFile(`{ "turnstile-secret-keys": "SUPER-SECRET-VALUE" oops }`);

    const error = await removeDevSecrets(path, ["turnstile-secret-keys"]).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PithyError);
    expect(surfaces(error)).not.toContain("SUPER-SECRET-VALUE");
  });
});
