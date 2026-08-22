// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { availableManifests, loadManifest } from "./manifests";

/** Drop a `pithy.manifest.json` into `<dir>/node_modules/@pithy-sh/<name>`. */
async function installManifest(dir: string, name: string, manifest: Record<string, unknown>): Promise<void> {
  const pkgDir = join(dir, "node_modules", "@pithy-sh", name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
}

const authManifest = {
  name: "auth",
  package: "@pithy-sh/auth",
  requiredBindings: [{ type: "d1", name: "DB" }],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-manifests-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The shipped payments manifest, read from the package rather than from `node_modules`, so a mistake in
 * it fails the moment it is written.
 *
 * `billingSubject` is the first **required** option the kit ships — no default, a closed set of two — and
 * it is the whole reason a manifest can express one (#412). Asserted here as well as in the repo-wide
 * parse, because "it still validates" and "it is still required" are different claims and only the second
 * one is the feature.
 */
describe("the payments manifest", () => {
  const raw = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "payments", "pithy.manifest.json"),
    "utf8",
  );

  test("validates, and declares billingSubject with no default and both choices", () => {
    const manifest = CapabilityManifest.parse(JSON.parse(raw));
    const option = manifest.configOptions.find((each) => each.key === "billingSubject");
    expect(option).toBeDefined();
    expect(option?.default).toBeUndefined();
    expect(option?.choices).toEqual(["user", "organization"]);
  });

  test("every other option still carries a default — nothing about their behavior moved", () => {
    const manifest = CapabilityManifest.parse(JSON.parse(raw));
    for (const option of manifest.configOptions) {
      if (option.key === "billingSubject") continue;
      expect(option.default, `${option.key} lost its default`).toBeDefined();
    }
  });
});

describe("loadManifest", () => {
  test("resolves and validates an installed capability's manifest", async () => {
    await installManifest(dir, "auth", authManifest);

    const manifest = await loadManifest("auth", dir);
    expect(manifest.name).toBe("auth");
    expect(manifest.package).toBe("@pithy-sh/auth");
    // BindingSpec normalization ran — proof it went through the schema.
    expect(manifest.requiredBindings).toEqual([{ type: "d1", name: "DB", optional: false }]);
  });

  test("an uninstalled capability fails with its name and how to add it", async () => {
    const error = await loadManifest("auth", dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).message).toContain("auth");
    expect((error as PithyError).payload.action).toContain("pithy add auth");
  });

  /**
   * Installed and not a capability is a third answer, and it used to be given the first one's words.
   *
   * `runAdd` installs the package and *then* reads the manifest, so the branch a missing manifest lands
   * in is reached with the package sitting in `node_modules`. Answering "no capability named rating is
   * installed — run pithy add rating to install it" sends the adopter to the command that has just run,
   * and it is not a message they can act on twice. `@pithy-sh/matchmaking` and `@pithy-sh/rating` shipped
   * complete and unaddable behind exactly that sentence (#415).
   */
  test("an installed package that ships no manifest says so, and does not name the command that just ran", async () => {
    const pkgDir = join(dir, "node_modules", "@pithy-sh", "rating");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@pithy-sh/rating", version: "0.0.0" }));

    const error = (await loadManifest("rating", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.message).toContain("@pithy-sh/rating");
    expect(error.message).toContain("pithy.manifest.json");
    expect(error.payload.action).not.toContain("pithy add rating");
  });

  /**
   * **Both absences keep `core/not_found`, which is the code they already shared.**
   *
   * What was wrong was the sentence, not the classification, and only the sentence moved. A package that
   * is installed and is not a capability is an adopter naming the wrong thing — `pithy add cloudflare` is
   * a real `@pithy-sh` package that ships no manifest — so a 500 would tell them to read *our* logs for an
   * answer that is not in them (CLAUDE.md §Errors). It would also make an ordinary mistake
   * indistinguishable from a Pithy defect for `--json` callers, who could then branch on nothing but prose.
   */
  test("both absences answer core/not_found, so an agent can still branch on the code", async () => {
    const pkgDir = join(dir, "node_modules", "@pithy-sh", "cloudflare");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@pithy-sh/cloudflare" }));

    const installed = (await loadManifest("cloudflare", dir).catch((thrown: unknown) => thrown)) as PithyError;
    const uninstalled = (await loadManifest("vector", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(installed.payload.code).toBe("core/not_found");
    expect(uninstalled.payload.code).toBe(installed.payload.code);
  });

  test("and an uninstalled one still gets the install instruction, which is the right answer for it", async () => {
    // The two branches are one line apart, so the second is asserted beside the first: narrowing the
    // absent case must not cost the adopter who really did type a name they never installed.
    const error = (await loadManifest("storage", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(error.payload.action).toContain("pithy add storage");
  });

  test("a malformed manifest fails validation", async () => {
    await installManifest(dir, "auth", { name: "auth" }); // no package, no requiredBindings
    await expect(loadManifest("auth", dir)).rejects.toThrow();
  });

  /**
   * A manifest is third-party data, read out of `node_modules`, and its option keys and rationales are
   * interpolated into the TypeScript `pithy add` writes. #174 narrowed both at the schema; this is the
   * refusal an adopter actually sees, and it has to say which manifest and which option — a capability
   * with a dozen options and one bad key is otherwise a "malformed manifest" and nothing more.
   */
  test("an option key that is not a bare identifier is refused, naming the manifest and the option", async () => {
    await installManifest(dir, "auth", {
      ...authManifest,
      configOptions: [
        { key: "basePath", default: "/auth", describe: "Where the auth routes mount." },
        { key: "content-type", default: "x", describe: "Not renderable as a bare key." },
      ],
    });

    const error = (await loadManifest("auth", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.message).toContain("@pithy-sh/auth"); // the manifest
    expect(error.message).toContain("configOptions[1].key"); // the option
    expect(error.message).toContain('"content-type"'); // and what it said
    expect(error.payload.detail).toContain("bare identifier");
  });

  test("a describe that spans lines is refused the same way", async () => {
    await installManifest(dir, "auth", {
      ...authManifest,
      configOptions: [{ key: "basePath", default: "/auth", describe: "Where the routes mount.\nevil();" }],
    });

    const error = (await loadManifest("auth", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.message).toContain("configOptions[0].describe");
    expect(error.message).toContain("one line");
  });
});

describe("availableManifests", () => {
  test("a project with no node_modules has no capabilities", async () => {
    expect(await availableManifests(dir)).toEqual({ manifests: [], faults: [] });
  });

  test("scans node_modules/@pithy-sh/* and returns every validated manifest", async () => {
    await installManifest(dir, "auth", authManifest);
    await installManifest(dir, "storage", {
      name: "storage",
      package: "@pithy-sh/storage",
      requiredBindings: [{ type: "r2", name: "BUCKET" }],
    });

    const { manifests, faults } = await availableManifests(dir);
    expect(manifests.map((m) => m.name).sort()).toEqual(["auth", "storage"]);
    expect(faults).toEqual([]);
  });

  test("skips @pithy-sh packages that ship no manifest (core, cli)", async () => {
    await installManifest(dir, "auth", authManifest);
    await mkdir(join(dir, "node_modules", "@pithy-sh", "core"), { recursive: true });

    const { manifests, faults } = await availableManifests(dir);
    expect(manifests.map((m) => m.name)).toEqual(["auth"]);
    // The silent skip, and the only one: a package that is not a capability says nothing.
    expect(faults).toEqual([]);
  });
});

/**
 * Missing and invalid are different answers, and this code gave them the same one.
 *
 * One `catch` covered both, so a manifest the schema refused made its capability vanish from
 * `pithy add --list`, `pithy upgrade` and `pithy doctor` with no message anywhere — the three commands an
 * adopter runs *because* something is missing were the three that stayed silent (#184). The four cases
 * are separated here because they were one case in the code.
 *
 * Third instance of the shape: `readDevVarsSource` and `readDevJson` (`../devSecrets/`) each read every
 * errno as absence too, and each now says only `ENOENT` means gone.
 */
describe("availableManifests tells a missing manifest from a broken one", () => {
  test("missing: a package with no manifest is skipped, silently, as it always was", async () => {
    await mkdir(join(dir, "node_modules", "@pithy-sh", "cli"), { recursive: true });
    expect(await availableManifests(dir)).toEqual({ manifests: [], faults: [] });
  });

  test("unparseable: a manifest that is not JSON is reported, naming the package and why", async () => {
    await mkdir(join(dir, "node_modules", "@pithy-sh", "audit"), { recursive: true });
    await writeFile(join(dir, "node_modules", "@pithy-sh", "audit", "pithy.manifest.json"), "{ not json");

    const { manifests, faults } = await availableManifests(dir);
    expect(manifests).toEqual([]);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.package).toBe("@pithy-sh/audit");
    expect(faults[0]?.reason).toMatch(/JSON/i);
  });

  test("schema-invalid: the reason is the schema's own refusal, the same sentence loadManifest gives", async () => {
    await installManifest(dir, "audit", {
      ...authManifest,
      name: "audit",
      package: "@pithy-sh/audit",
      configOptions: [{ key: "content-type", default: "x", describe: "Not renderable as a bare key." }],
    });

    const { manifests, faults } = await availableManifests(dir);
    expect(manifests).toEqual([]);
    expect(faults[0]?.package).toBe("@pithy-sh/audit");
    expect(faults[0]?.reason).toContain("configOptions[0].key");
    expect(faults[0]?.reason).toContain("bare identifier");

    // And it matches the direct path, so an adopter reading either sees the same words.
    const direct = (await loadManifest("audit", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(direct.payload.detail).toBe(faults[0]?.reason);
  });

  test("unreadable: a manifest that will not open is reported, not read as absent", async () => {
    // A directory where the file should be. Every uid gets EISDIR from `readFile`, so this says the same
    // thing on a developer's laptop and in a container running as root — unlike a chmod, which root
    // ignores. The rule under test is that only ENOENT means "not there".
    await mkdir(join(dir, "node_modules", "@pithy-sh", "audit", "pithy.manifest.json"), { recursive: true });

    const { manifests, faults } = await availableManifests(dir);
    expect(manifests).toEqual([]);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.package).toBe("@pithy-sh/audit");
    expect(faults[0]?.reason).toContain("EISDIR");
  });

  test("one broken package does not cost the listing of the others", async () => {
    await installManifest(dir, "auth", authManifest);
    await mkdir(join(dir, "node_modules", "@pithy-sh", "audit"), { recursive: true });
    await writeFile(join(dir, "node_modules", "@pithy-sh", "audit", "pithy.manifest.json"), "{ not json");

    const { manifests, faults } = await availableManifests(dir);
    expect(manifests.map((m) => m.name)).toEqual(["auth"]);
    expect(faults.map((fault) => fault.package)).toEqual(["@pithy-sh/audit"]);
  });
});

/**
 * The same rule on the direct path. `loadManifest` caught every read failure and said "No capability
 * named X is installed" — which for an unreadable file sends the adopter to `pithy add`, the command that
 * has just declined to run.
 */
describe("loadManifest tells a missing manifest from an unreadable one", () => {
  test("an unreadable manifest is not reported as uninstalled", async () => {
    await mkdir(join(dir, "node_modules", "@pithy-sh", "auth", "pithy.manifest.json"), { recursive: true });

    const error = (await loadManifest("auth", dir).catch((thrown: unknown) => thrown)) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.action).not.toContain("pithy add auth");
    expect(error.payload.detail).toContain("EISDIR");
  });
});
