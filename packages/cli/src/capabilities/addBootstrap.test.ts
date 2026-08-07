// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { EncryptionConfig } from "@pithy-sh/secrets/src/crypto/envelope";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devSecretsPath, readDevSecrets } from "../devSecrets/file";
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

/** The current-version value `.dev.secrets.jsonc` holds for `name`, or `undefined` when it has none. */
async function devSecret(dir: string, name: string): Promise<unknown> {
  const envelope = (await readDevSecrets(dir))[name];
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
  refused: null,
});

describe("bootstrapAdd", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-bootstrap-"));
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
    const other = await mkdtemp(join(tmpdir(), "pithy-bootstrap-"));
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

  test("the secret lands in .dev.secrets.jsonc, and is injected into .dev.vars too until #153", async () => {
    // The transition, not the design. `.dev.secrets.jsonc` is the source of truth; `.dev.vars` still
    // carries a copy because `secretsStore`'s dev branch resolves every secret from its injected
    // binding, whatever its backend. Writing only the new file left the Worker answering
    // `secrets/not_found` at the first sign-in. #153 routes dev by backend and deletes this half.
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });

    const value = await devSecret(dir, "auth-session-secret");
    expect(value).toBeDefined();
    expect((await readFile(devSecretsPath(dir), "utf8")).includes("auth-session-secret")).toBe(true);
    const injected = await devVar(dir, "auth-session-secret");
    expect(JSON.parse(injected ?? "")).toEqual({ currentVersion: "1", versions: { "1": value } });
  });

  test("the injected copy is not mistaken for the migration case on the next run", async () => {
    // `pithy add` names a secret found in `.dev.vars` and refuses to touch it — that is an adopter's
    // pre-#149 value. A copy this command wrote itself is not that, and telling someone to move a
    // value that is already in both files, into the file it is already in, is a false instruction.
    const manifest = await shippedManifest("auth");
    await bootstrapAdd({ projectDir: dir, manifest });

    const notes = await bootstrapAdd({ projectDir: dir, manifest });

    expect(notes.join(" ")).toContain("already in .dev.secrets.jsonc");
    expect(notes.join(" ")).not.toContain("where secrets no longer live");
  });

  test("a minted secret is a full version-1 envelope — the shape the store actually holds", async () => {
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });

    const envelope = (await readDevSecrets(dir))["auth-session-secret"];
    expect(envelope?.currentVersion).toBe("1");
    expect(Object.keys(envelope?.versions ?? {})).toEqual(["1"]);
  });

  test("the file it writes is 0600 — it will hold OAuth client secrets next to this one", async () => {
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });
    expect((await stat(devSecretsPath(dir))).mode & 0o777).toBe(0o600);
  });

  test("mints the email link-signing key beside the note about EMAIL_SENDER", async () => {
    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("email") });

    const value = await devSecret(dir, "email-link-signing-key");
    expect(value).toBeDefined();
    expect(notes.join(" ")).toContain("pithy secrets create email-link-signing-key");
    expect(notes.join(" ")).not.toContain(String(value));
  });

  test("a minted secret is random per project — one shipped literal would sign every adopter's sessions", async () => {
    const other = await mkdtemp(join(tmpdir(), "pithy-bootstrap-"));
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

  test("a secret still in .dev.vars is left there and named, never rewritten and never re-minted", async () => {
    // The migration case. An existing project has the value in `.dev.vars`, where dev still reads it.
    // Minting a second one into the new file would give the project two values and no way to tell
    // which one signed what; rewriting their file behind their back is worse. So: say it, change nothing.
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=already-mine\n");

    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") });

    expect(await devVar(dir, "auth-session-secret")).toBe("already-mine");
    expect(await devSecret(dir, "auth-session-secret")).toBeUndefined();
    expect(notes.join(" ")).toContain(".dev.vars");
    expect(notes.join(" ")).toContain(".dev.secrets.jsonc");
  });

  test("a dev secret goes to .dev.secrets.jsonc, never a committed example file", async () => {
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
    const file = await readDevSecrets(dir);
    for (const name of ["google", "apple", "facebook", "github"]) {
      expect(file[`auth-${name}-credentials`]).toBeUndefined();
    }

    const payments = await mkdtemp(join(tmpdir(), "pithy-bootstrap-"));
    try {
      expect(await bootstrapAdd({ projectDir: payments, manifest: await shippedManifest("payments") })).toEqual([]);
      await expect(readFile(devSecretsPath(payments), "utf8")).rejects.toThrow();
    } finally {
      await rm(payments, { recursive: true, force: true });
    }
  });

  test("a refusal is said once, not twice", async () => {
    // Two things reach the same refusal in one `pithy add`: the mint here, and the seeder that runs
    // after it and has just tried the same write. `pithy add auth` on a project whose `.gitignore`
    // cannot be written printed the sentence twice, which reads as two problems. An adopter counts lines.
    await mkdir(join(dir, ".gitignore"));
    const refusal =
      ".gitignore could not be updated. Add .dev.secrets.jsonc and .dev.secrets.jsonc.tmp to it, then run the command again.";

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
        refused: refusal,
      }),
    });

    expect(notes.filter((note) => note === refusal)).toHaveLength(1);
  });

  test("pithy's own injected copy is not read as a value the adopter left in .dev.vars", async () => {
    // Delete the secret from `.dev.secrets.jsonc` to ask for a fresh one, and `pithy add auth` answered
    // "auth-session-secret is in .dev.vars, where secrets no longer live. Move it." — about a line it
    // had written there itself, on purpose, an hour before. Nothing was ever minted again.
    await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth"), seed: emptySeed });
    const first = await devSecret(dir, "auth-session-secret");
    await rm(devSecretsPath(dir));

    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth"), seed: emptySeed });

    expect(notes.join("\n")).toContain("Minted a dev auth-session-secret");
    expect(await devSecret(dir, "auth-session-secret")).toBeDefined();
    expect(await devSecret(dir, "auth-session-secret")).not.toBe(first);
  });

  test("an adopter's own .dev.vars value is still left exactly where it is", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=written-by-hand\n");

    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth"), seed: emptySeed });

    expect(notes.join("\n")).toContain("where secrets no longer live");
    expect(await devSecret(dir, "auth-session-secret")).toBeUndefined();
    expect(await devVar(dir, "auth-session-secret")).toBe("written-by-hand");
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

  test("a Worker the injected copy could not be linked into is named, never counted as delivered", async () => {
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(join(dir, "apps", "board", "wrangler.jsonc"), "{}\n");
    await chmod(join(dir, "apps", "board"), 0o500);
    try {
      const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth"), seed: emptySeed });

      expect(notes.join("\n")).toContain("could not be linked");
      expect(notes.join("\n")).toContain(join(dir, "apps", "board"));
    } finally {
      await chmod(join(dir, "apps", "board"), 0o700);
    }
  });
});
