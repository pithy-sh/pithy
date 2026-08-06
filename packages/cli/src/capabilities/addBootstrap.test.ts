// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { EncryptionConfig } from "@pithy-sh/secrets/src/crypto/envelope";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

/** The master key `.dev.vars` holds in `dir`, or `undefined` when nothing was written. */
async function devMasterKey(dir: string): Promise<string | undefined> {
  const content = await readFile(join(dir, ".dev.vars"), "utf8").catch(() => "");
  return parseDevVars(content).SECRETS_ENCRYPTION_KEYS;
}

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

  test("email says what EMAIL_SENDER needs, and fabricates nothing", async () => {
    const notes = await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("email") });

    expect(notes.join(" ")).toContain("EMAIL_SENDER");
    expect(notes.join(" ")).toContain("pithy email provision");
    // A Workflow binding points at a deployed Worker. There is no local stand-in to write.
    await expect(readFile(join(dir, ".dev.vars"), "utf8")).rejects.toThrow();
  });

  test("a capability whose bindings pithy add already writes has nothing to say", async () => {
    expect(await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("auth") })).toEqual([]);
  });

  test("an optional binding says nothing — the fail-fast never asks for one", async () => {
    // payments declares `workflow:PAYMENTS_RECONCILE` optional; a note would send the adopter
    // provisioning a Workflow nothing in their app requires.
    expect(await bootstrapAdd({ projectDir: dir, manifest: await shippedManifest("payments") })).toEqual([]);
  });
});
