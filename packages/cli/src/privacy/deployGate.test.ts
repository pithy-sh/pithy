// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { PRIVACY_ATTESTATION_VAR, privacyAttestation } from "@pithy-sh/core/src/privacy/posture";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NO_CONSOLE_OVERRIDE } from "./consoleGate";
import { deployPrivacy, privacyVarArgs, unverifiableGateLine } from "./deployGate";

let dir: string;
const NOW = new Date("2026-10-20T12:00:00.000Z");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-deploy-gate-"));
  await mkdir(join(dir, "apps/app/src"), { recursive: true });
  await writeFile(join(dir, "apps/app/src/index.ts"), "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function biome(config: unknown): Promise<void> {
  await writeFile(join(dir, "biome.jsonc"), JSON.stringify(config));
}

describe("deployPrivacy", () => {
  /** The refusal a deploy of a `pii` project raises against the Biome config `biome(config)` wrote. */
  async function refusal(): Promise<PithyError["payload"]> {
    try {
      await deployPrivacy({ projectDir: dir, config: { privacy: { classes: ["pii"] } }, now: () => NOW });
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      return (error as PithyError).payload;
    }
    throw new Error("deployPrivacy did not refuse");
  }

  test("refuses when a class is declared and the rule is never stated, naming the file, the rule and enable", async () => {
    await biome({ linter: { rules: { preset: "recommended" } } });
    const payload = await refusal();
    expect(payload.code).toBe("core/precondition_failed");
    expect(payload.message).toContain("biome.jsonc");
    expect(payload.message).toContain("suspicious/noConsole");
    expect(payload.action).toContain("pithy privacy enable");
  });

  test("a rule a person turned down names the edit, not `pithy privacy enable`, which will not override it", async () => {
    await biome({ linter: { rules: { suspicious: { noConsole: "off" } } } });
    const payload = await refusal();
    expect(payload.message).toContain("suspicious/noConsole");
    expect(payload.action).not.toContain("privacy enable");
    expect(payload.action).toContain('"error"');
    expect(payload.action).toContain("biome.jsonc");
  });

  test("a disabled linter names turning it back on, not `pithy privacy enable`", async () => {
    await biome({ linter: { enabled: false, rules: { suspicious: { noConsole: "error" } } } });
    const payload = await refusal();
    expect(payload.action).not.toContain("privacy enable");
    expect(payload.action).toContain("linter");
  });

  test("passes when the rule is on, and attests the classes and the gate", async () => {
    await biome({ overrides: [NO_CONSOLE_OVERRIDE] });
    const privacy = await deployPrivacy({
      projectDir: dir,
      config: { privacy: { classes: ["pii", "phi"] } },
      now: () => NOW,
    });
    expect(privacy.attestation).toEqual({
      classes: ["pii", "phi"],
      consoleGate: "enforced",
      reason: null,
      attestedAt: NOW.toISOString(),
    });
  });

  test("deploys with no Biome config, attesting `unverifiable` with the reason — never `enforced`", async () => {
    const privacy = await deployPrivacy({ projectDir: dir, config: { privacy: { classes: ["phi"] } }, now: () => NOW });
    expect(privacy.attestation.consoleGate).toBe("unverifiable");
    expect(privacy.attestation.reason).toContain("No biome.json or biome.jsonc");
    expect(unverifiableGateLine(privacy)).toContain("unverified");
  });

  test("a project with no declared class deploys unchanged whether the rule is on or off", async () => {
    await biome({ linter: { rules: { suspicious: { noConsole: "off" } } } });
    const off = await deployPrivacy({ projectDir: dir, config: {}, now: () => NOW });
    expect(off.attestation).toEqual({
      classes: [],
      consoleGate: "not_required",
      reason: null,
      attestedAt: NOW.toISOString(),
    });
    await biome({ overrides: [NO_CONSOLE_OVERRIDE] });
    expect((await deployPrivacy({ projectDir: dir, config: {}, now: () => NOW })).attestation.consoleGate).toBe(
      "not_required",
    );
    expect(unverifiableGateLine(off)).toBeUndefined();
  });
});

describe("privacyVarArgs", () => {
  test("is the one --var the Worker's attestation reader parses back exactly", async () => {
    await biome({ overrides: [NO_CONSOLE_OVERRIDE] });
    const { attestation } = await deployPrivacy({
      projectDir: dir,
      config: { privacy: { classes: ["pii"] } },
      now: () => NOW,
    });
    const args = privacyVarArgs(attestation);
    expect(args[0]).toBe("--var");
    // wrangler splits a --var on its first colon and joins the rest back (wrangler 4.151.0 `collectKeyValues`).
    const [key, ...rest] = (args[1] as string).split(":");
    expect(key).toBe(PRIVACY_ATTESTATION_VAR);
    expect(privacyAttestation({ [PRIVACY_ATTESTATION_VAR]: rest.join(":") })).toEqual(attestation);
  });
});
