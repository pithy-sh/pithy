// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { EncryptionConfig } from "@pithy-sh/secrets/src/crypto/envelope";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readDevSecrets } from "../devSecrets/file";
import { resolveDevSecretsFile } from "../devSecrets/location";
import { bootstrapAdd } from "./addBootstrap";

/**
 * The capability's **shipped** manifest, read from the package the same file `pithy add` installs.
 * Not a hand-written copy: what this asserts is what `pithy add secrets` does, so a manifest that
 * stops declaring `secret:SECRETS_ENCRYPTION_KEYS` must fail here rather than pass against a fixture.
 */
async function shippedManifest(pkg: string): Promise<CapabilityManifest> {
  const url = new URL(`../../../${pkg}/pithy.manifest.json`, import.meta.url);
  return CapabilityManifest.parse(JSON.parse(await readFile(url, "utf8")));
}

/** The value `.dev.vars` holds for `name` in `dir`, or `undefined` when nothing was written. */
async function devVar(dir: string, name: string): Promise<string | undefined> {
  const content = await readFile(join(dir, ".dev.vars"), "utf8").catch(() => "");
  return parseDevVars(content)[name];
}

/** The master key `.dev.vars` holds in `dir`, or `undefined` when nothing was written. */
async function devMasterKey(dir: string): Promise<string | undefined> {
  return devVar(dir, "SECRETS_ENCRYPTION_KEYS");
}

/**
 * A throwaway project root that has a `name` — the dev secrets file is keyed on it, not on the
 * directory (#156), so a project without one cannot resolve a place to put a credential at all.
 *
 * **A distinct name per call, which is the whole reason this is a function.** Two projects sharing a
 * name share one secrets file, so "the key is random per project" would compare a value with itself
 * and pass for the wrong reason. `vitest.setup.ts` keeps every one of them out of the real config dir.
 */
let projects = 0;
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-bootstrap-"));
  projects += 1;
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: "bootstrap-${projects}" };\n`);
  return dir;
}

/** Where this project's dev secrets landed — outside the checkout, resolved the way the CLI resolves it. */
function secretsPath(dir: string): Promise<string> {
  return resolveDevSecretsFile(dir);
}

/** The current-version value the dev secrets file holds for `name`, or `undefined` when it has none. */
async function devSecret(dir: string, name: string): Promise<unknown> {
  const envelope = (await readDevSecrets(await secretsPath(dir)))[name];
  return envelope?.versions[envelope.currentVersion];
}

/** A seeder that does nothing — these cases are about what `bootstrapAdd` itself writes and says. */
const emptySeed = async () => ({
  seeded: [],
  unchanged: [],
  minted: [],
  devVars: [],
  missing: [],
  undeclared: [],
  skipped: [],
});

describe("bootstrapAdd", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await project();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("mints a dev master key into .dev.vars — the one value an adopter cannot invent", async () => {
    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("secrets") });

    const raw = await devMasterKey(dir);
    expect(raw).toBeDefined();
    const config = EncryptionConfig.parse(JSON.parse(raw ?? ""));
    expect(config.currentVersion).toBe("1");
    expect(config.versions["1"]).toMatch(/^[A-Za-z0-9+/=]{40,}$/);

    // The two halves of the reminder: this is local, and production comes from somewhere else.
    expect(notes.join(" ")).toMatch(/local/i);
    expect(notes.join(" ")).toMatch(/pithy secrets provision/);
    // Never the key itself — a printed key ends up in a terminal scrollback and a CI log.
    expect(notes.join(" ")).not.toContain(config.versions["1"]);
  });

  test("the key is random per project — one shipped literal would be every adopter's key", async () => {
    const other = await project();
    try {
      const manifest = await shippedManifest("secrets");
      await bootstrapAdd({ projectDir: dir, manifest });
      await bootstrapAdd({ projectDir: other, manifest });
      expect(await devMasterKey(dir)).not.toBe(await devMasterKey(other));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("an existing key survives a re-run — replacing it orphans every secret already stored", async () => {
    const manifest = await shippedManifest("secrets");
    await bootstrapAdd({ projectDir: dir, manifest });
    const minted = await devMasterKey(dir);

    const notes = await bootstrapAdd({ projectDir: dir, manifest });

    expect(await devMasterKey(dir)).toBe(minted);
    expect(notes.join(" ")).toMatch(/already/i);
  });

  test("every other line of .dev.vars is left alone", async () => {
    await writeFile(join(dir, ".dev.vars"), "# creds\nCLOUDFLARE_ACCOUNT_ID=abc\n");
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("secrets") });

    const content = await readFile(join(dir, ".dev.vars"), "utf8");
    expect(content).toContain("# creds");
    expect(content).toContain("CLOUDFLARE_ACCOUNT_ID=abc");
  });

  test("writes .dev.vars, never the committed .dev.vars.example", async () => {
    const example = "CLOUDFLARE_ACCOUNT_ID=\nCLOUDFLARE_API_TOKEN=\n";
    await writeFile(join(dir, ".dev.vars.example"), example);

    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("secrets") });

    // `.dev.vars` is gitignored; the example is committed. A key in the example is a key in the repo.
    expect(await readFile(join(dir, ".dev.vars.example"), "utf8")).toBe(example);
    expect(await devMasterKey(dir)).toBeDefined();
  });

  test("email says what EMAIL_SENDER needs, and fabricates nothing for it", async () => {
    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("email") });

    expect(notes.join(" ")).toContain("EMAIL_SENDER");
    expect(notes.join(" ")).toContain("pithy email provision");
    // A Workflow binding points at a deployed Worker. There is no local stand-in to write.
    expect(await devVar(dir, "EMAIL_SENDER")).toBeUndefined();
  });

  test("a capability whose bindings pithy add writes, and which declares no dev secret, has nothing to say", async () => {
    expect(await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("audit") })).toEqual([]);
  });

  test("an optional binding says nothing — the fail-fast never asks for one", async () => {
    // payments declares `workflow:PAYMENTS_RECONCILE` optional; a note would send the adopter
    // provisioning a Workflow nothing in their app requires.
    expect(await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("payments") })).toEqual([]);
  });

  test("mints the session secret auth reads lazily — nothing else names it before the first sign-in", async () => {
    // Auth's required bindings are its D1 and its rate limiter, so the Worker boots healthy without
    // this one and fails at the first sign-in with `secrets/not_found`. Minting it is the difference.
    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });

    const value = await devSecret(dir, "auth-session-secret");
    expect(typeof value).toBe("string");
    expect(String(value).length).toBeGreaterThanOrEqual(32);
    expect(notes.join(" ")).toContain("auth-session-secret");
    expect(notes.join(" ")).toContain("pithy secrets create auth-session-secret");
    expect(notes.join(" ")).toMatch(/local/i);
    // Never the value — a printed secret ends up in a terminal scrollback and a CI log.
    expect(notes.join(" ")).not.toContain(String(value));
  });

  test("the secret lands in the dev secrets file, and nothing about it reaches .dev.vars (#153)", async () => {
    // The dual-write, deleted. `.dev.vars` carried a copy while dev resolved every secret from its
    // injected binding whatever its backend; dev reads the seeded row now, so a copy there would be a
    // second plaintext of the session key in wrangler's env-binding file, under a kebab name, unread.
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });

    const value = await devSecret(dir, "auth-session-secret");
    expect(value).toBeDefined();
    expect((await readFile(await secretsPath(dir), "utf8")).includes("auth-session-secret")).toBe(true);
    expect(await devVar(dir, "auth-session-secret")).toBeUndefined();
  });

  test("re-running names the file rather than minting a second value", async () => {
    const manifest = await shippedManifest("auth");
    await bootstrapAdd({ projectDir: dir, manifest });

    const notes = await bootstrapAdd({ projectDir: dir, manifest });

    expect(notes.join(" ")).toContain(`already in ${await secretsPath(dir)}`);
  });

  test("a minted secret is a full version-1 envelope — the shape the store actually holds", async () => {
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });

    const envelope = (await readDevSecrets(await secretsPath(dir)))["auth-session-secret"];
    expect(envelope?.currentVersion).toBe("1");
    expect(Object.keys(envelope?.versions ?? {})).toEqual(["1"]);
  });

  test("the file it writes is 0600 — it will hold OAuth client secrets next to this one", async () => {
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });
    expect((await stat(await secretsPath(dir))).mode & 0o777).toBe(0o600);
  });

  test("mints the email link-signing key beside the note about EMAIL_SENDER", async () => {
    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("email") });

    const value = await devSecret(dir, "email-link-signing-key");
    expect(value).toBeDefined();
    expect(notes.join(" ")).toContain("pithy secrets create email-link-signing-key");
    expect(notes.join(" ")).not.toContain(String(value));
  });

  test("a minted secret is random per project — one shipped literal would sign every adopter's sessions", async () => {
    const other = await project();
    try {
      const manifest = await shippedManifest("auth");
      await bootstrapAdd({ projectDir: dir, manifest });
      await bootstrapAdd({ projectDir: other, manifest });
      expect(await devSecret(dir, "auth-session-secret")).not.toBe(await devSecret(other, "auth-session-secret"));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("an existing dev secret survives a re-run — a new session secret signs nobody out politely", async () => {
    const manifest = await shippedManifest("auth");
    await bootstrapAdd({ projectDir: dir, manifest });
    const minted = await devSecret(dir, "auth-session-secret");

    const notes = await bootstrapAdd({ projectDir: dir, manifest });

    expect(await devSecret(dir, "auth-session-secret")).toBe(minted);
    expect(notes.join(" ")).toMatch(/already/i);
  });

  test("a secret stranded in .dev.vars is named, and the mint happens anyway (#153)", async () => {
    // The migration case, inverted. That line used to be where dev read the value, so minting beside it
    // gave the project two live values and no way to say which signed what — the honest answer was to
    // refuse. Dev reads the seeded row now: refusing would leave the Worker with no session key at all.
    // So the value is minted, their file is not touched, and the stranded line is named.
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=already-mine\n");

    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });

    expect(await devVar(dir, "auth-session-secret")).toBe("already-mine");
    expect(await devSecret(dir, "auth-session-secret")).toBeDefined();
    expect(notes.join(" ")).toContain("which dev no longer reads");
    // The absolute path, not the file's name: it is outside the checkout, so a name locates nothing.
    expect(notes.join(" ")).toContain(await secretsPath(dir));
  });

  test("a dev secret goes to the dev secrets file, never a committed example file", async () => {
    const example = "CLOUDFLARE_ACCOUNT_ID=\nCLOUDFLARE_API_TOKEN=\n";
    await writeFile(join(dir, ".dev.vars.example"), example);
    await writeFile(join(dir, ".dev.secrets.example.jsonc"), "{}\n");

    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });

    expect(await readFile(join(dir, ".dev.vars.example"), "utf8")).toBe(example);
    expect(await readFile(join(dir, ".dev.secrets.example.jsonc"), "utf8")).toBe("{}\n");
    expect(await devSecret(dir, "auth-session-secret")).toBeDefined();
  });

  test("nothing is invented for a secret whose value must match a third party", async () => {
    // The four OAuth credential pairs are registered with a provider; payments' is a Stripe key. A
    // generated value for either is a value that authenticates against nothing, hiding the real gap.
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });
    const file = await readDevSecrets(await secretsPath(dir));
    for (const name of ["google", "apple", "facebook", "github"]) {
      expect(file[`auth-${name}-credentials`]).toBeUndefined();
    }

    const payments = await project();
    try {
      expect(await bootstrapAdd({ projectDir: payments, manifest: await shippedManifest("payments") })).toEqual([]);
      await expect(readFile(await secretsPath(payments), "utf8")).rejects.toThrow();
    } finally {
      await rm(payments, { recursive: true, force: true });
    }
  });

  test("a sentence both halves reach is said once, not twice", async () => {
    // Two things reach the same `.dev.vars` delivery note in one `pithy add`: the mint here injects
    // the value it just minted, and the seeder that runs after it injects the same one. Printing the
    // sentence twice reads as two problems. An adopter counts lines.
    const shared = "apps/board reads a .dev.vars of its own. wrangler opens that one, so nothing written reaches it.";

    const notes = await bootstrapAdd({
      projectDir: dir,
      manifest: await shippedManifest("auth"),
      seed: async () => ({
        seeded: [],
        unchanged: [],
        minted: [],
        devVars: [],
        missing: [],
        undeclared: [],
        skipped: [],
        shadowed: ["apps/board"],
      }),
    });

    expect(notes.filter((note) => note === shared)).toHaveLength(1);
  });

  test("a project with no name refuses rather than guessing where to put a credential", async () => {
    // The file is keyed on `pithy.config.ts`'s `name`. A guess — the directory basename — would give a
    // worktree a different set of secrets from the checkout it was cut from, silently.
    const nameless = await mkdtemp(join(tmpdir(), "pithy-bootstrap-"));
    await writeFile(join(nameless, "pithy.config.ts"), "export default {};\n");
    try {
      await expect(bootstrapAdd({ projectDir: nameless, manifest: await shippedManifest("auth") })).rejects.toThrow(
        /name/,
      );
    } finally {
      await rm(nameless, { recursive: true, force: true });
    }
  });

  test("deleting the secret from the file mints a fresh one, whatever .dev.vars holds", async () => {
    // Deleting the entry is how you ask for a new value. A line left in `.dev.vars` used to suppress
    // every mint after the first one, silently and for good.
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth"), seed: emptySeed });
    const first = await devSecret(dir, "auth-session-secret");
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=left-over\n");
    await rm(await secretsPath(dir));

    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth"), seed: emptySeed });

    expect(notes.join("\n")).toContain("Minted a dev auth-session-secret");
    expect(await devSecret(dir, "auth-session-secret")).toBeDefined();
    expect(await devSecret(dir, "auth-session-secret")).not.toBe(first);
  });

  test("an unreadable .dev.vars is refused rather than read as an empty one", async () => {
    // `readFile(...).catch(() => "")` made an EACCES read as "nothing here" for every errno, so the
    // stranded line went unmentioned and `pithy doctor` was the only thing that ever said it. Only
    // ENOENT means absent — the rule `writeDevVars` already enforces on the same file.
    const path = join(dir, ".dev.vars");
    await writeFile(path, "auth-session-secret=already-mine\n");
    await chmod(path, 0o000);
    try {
      await expect(
        bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth"), seed: emptySeed }),
      ).rejects.toThrow(/could not be read/);

      await chmod(path, 0o600);
      expect(await devSecret(dir, "auth-session-secret")).toBeUndefined();
    } finally {
      await chmod(path, 0o600).catch(() => {});
    }
  });

  test("a Worker reading a .dev.vars of its own is named — the minted key never reached it", async () => {
    // `writeDevVars` grew `shadowed` and `undelivered` precisely so a delivery that did not happen stops
    // being reported as one. Both direct calls here took `.refused` off the result and dropped the rest,
    // so the defect survived at the caller: `pithy add secrets` printed "Minted a dev master key" and
    // the Worker still answered `Missing required bindings: secret:SECRETS_ENCRYPTION_KEYS`.
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await writeFile(join(dir, "apps", "board", ".dev.vars"), "MINE=1\n");

    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("secrets"), seed: emptySeed });

    expect(notes.join("\n")).toContain(join(dir, "apps", "board"));
    expect(notes.join("\n")).toMatch(/wrangler opens that one/);
  });

  test("a Worker the master key could not be linked into is named, never counted as delivered", async () => {
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await chmod(join(dir, "apps", "board"), 0o500);
    try {
      const notes = await bootstrapAdd({
        projectDir: dir,
        manifest: await shippedManifest("secrets"),
        seed: emptySeed,
      });

      expect(notes.join("\n")).toContain("could not be linked");
      expect(notes.join("\n")).toContain(join(dir, "apps", "board"));
    } finally {
      await chmod(join(dir, "apps", "board"), 0o700);
    }
  });
});
