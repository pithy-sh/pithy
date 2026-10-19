// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { secretsTables } from "../data/tables";
import { secrets_0003_reencryptions } from "../migrations/0003_reencryptions";
import { MAX_SECRETS_CACHE_TTL_SECONDS } from "../sharedSecretsStore";
import {
  claimReencryption,
  currentSealedVersion,
  fingerprintVersions,
  pendingReencryptions,
  REENCRYPTION_SETTLE_MS,
  recordReencryption,
  recordSoleVersion,
  versionFingerprint,
} from "./reencryption";

const db = () => createDatabase(env.SECRETS, secretsTables);
const NAME = "auth-session-secret";
const JWKS = "auth-jwks";
const HOLDER = "DB";

/** Record `dependent`, in `holder`, moved under `version` of an envelope whose value there is `value`. */
async function moved(version: string, value: string, holder = HOLDER): Promise<void> {
  await recordReencryption(db(), {
    name: NAME,
    dependent: JWKS,
    holder,
    version,
    fingerprint: await versionFingerprint(value),
  });
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_reencryptions").run();
  await secrets_0003_reencryptions.up(db());
});

describe("versionFingerprint", () => {
  test("is stable for one value, differs between values, and is not the value", async () => {
    const one = await versionFingerprint("value-one");
    expect(await versionFingerprint("value-one")).toBe(one);
    expect(await versionFingerprint("value-two")).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(one).not.toContain("value-one");
  });

  test("an envelope's current version and its fingerprint, and every version's", async () => {
    const envelope = { currentVersion: "2", versions: { "1": "a", "2": "b" } };
    expect(await currentSealedVersion(envelope)).toEqual({ version: "2", fingerprint: await versionFingerprint("b") });
    expect(await fingerprintVersions(envelope.versions)).toEqual({
      "1": await versionFingerprint("a"),
      "2": await versionFingerprint("b"),
    });
  });
});

describe("pendingReencryptions — what a retirement still waits for (#602)", () => {
  test("a dependent that never recorded is pending, and one recorded at the version is not", async () => {
    const fingerprints = await fingerprintVersions({ "1": "a", "2": "b" });
    expect(await pendingReencryptions(db(), NAME, [JWKS], "2", fingerprints)).toEqual([JWKS]);
    await moved("2", "b");
    expect(await pendingReencryptions(db(), NAME, [JWKS], "2", fingerprints)).toEqual([]);
  });

  test("a record behind the version is pending, and one past it is not — compared as numbers", async () => {
    const fingerprints = await fingerprintVersions({ "9": "nine", "10": "ten", "11": "eleven" });
    await moved("9", "nine");
    expect(await pendingReencryptions(db(), NAME, [JWKS], "10", fingerprints)).toEqual([`${JWKS}/${HOLDER}`]);
    await moved("11", "eleven");
    expect(await pendingReencryptions(db(), NAME, [JWKS], "10", fingerprints)).toEqual([]);
  });

  test("a record from before an update reset the versions is pending, whatever its number says", async () => {
    // Rotated to 3 and moved there; then `update` wrote a fresh {"1"}, and the cron appended "2".
    await moved("3", "old-three");
    const afterReset = await fingerprintVersions({ "1": "new-one", "2": "new-two" });
    expect(await pendingReencryptions(db(), NAME, [JWKS], "2", afterReset)).toEqual([`${JWKS}/${HOLDER}`]);
  });

  test("a record at the same version key but another value is pending", async () => {
    await moved("2", "old-two");
    const afterReset = await fingerprintVersions({ "1": "new-one", "2": "new-two" });
    expect(await pendingReencryptions(db(), NAME, [JWKS], "2", afterReset)).toEqual([`${JWKS}/${HOLDER}`]);
  });

  test("a dependent still settling is pending, though its row names the version", async () => {
    const fingerprints = await fingerprintVersions({ "1": "a", "2": "b" });
    await claimReencryption(db(), {
      name: NAME,
      dependent: JWKS,
      holder: HOLDER,
      sealed: { version: "2", fingerprint: fingerprints["2"] as string },
    });
    expect(await pendingReencryptions(db(), NAME, [JWKS], "2", fingerprints)).toEqual([`${JWKS}/${HOLDER}`]);
  });

  test("recording again replaces the row rather than adding one", async () => {
    await moved("2", "b");
    await moved("3", "c");
    const rows = await env.SECRETS.prepare("select version from pithy_secrets_reencryptions").all<{
      version: string;
    }>();
    expect(rows.results).toEqual([{ version: "3" }]);
  });

  test("two databases holding one dependent are two holders, and the one behind holds retirement", async () => {
    // Two auth Workers over two databases, one environment-scoped session secret: one moving answers for itself.
    const fingerprints = await fingerprintVersions({ "1": "a", "2": "b" });
    await moved("1", "a", "COLLAB_DB");
    await moved("2", "b", "DB");
    expect(await pendingReencryptions(db(), NAME, [JWKS], "2", fingerprints)).toEqual([`${JWKS}/COLLAB_DB`]);
    await moved("2", "b", "COLLAB_DB");
    expect(await pendingReencryptions(db(), NAME, [JWKS], "2", fingerprints)).toEqual([]);
  });

  test("a holder records itself while the secret has one version, so the first rotation waits for it", async () => {
    await recordSoleVersion(db(), {
      name: NAME,
      dependent: JWKS,
      holder: "COLLAB_DB",
      sealed: { version: "1", fingerprint: await versionFingerprint("a") },
    });
    await moved("2", "b", "DB");
    const fingerprints = await fingerprintVersions({ "1": "a", "2": "b" });
    expect(await pendingReencryptions(db(), NAME, [JWKS], "2", fingerprints)).toEqual([`${JWKS}/COLLAB_DB`]);
  });

  test("recording a sole version again writes nothing", async () => {
    const input = {
      name: NAME,
      dependent: JWKS,
      holder: HOLDER,
      sealed: { version: "1", fingerprint: await versionFingerprint("a") },
    };
    await recordSoleVersion(db(), { ...input, now: new Date("2026-10-18T03:00:00.000Z") });
    await recordSoleVersion(db(), { ...input, now: new Date("2026-10-19T03:00:00.000Z") });
    const rows = await env.SECRETS.prepare("select moved_at from pithy_secrets_reencryptions").all<{
      moved_at: number;
    }>();
    expect(rows.results).toEqual([{ moved_at: new Date("2026-10-18T03:00:00.000Z").getTime() }]);
  });

  test("a secret with nothing sealed under it has nothing pending", async () => {
    expect(await pendingReencryptions(db(), "email-link-signing-key", [], "2", {})).toEqual([]);
  });
});

describe("claimReencryption — a dependent waits out every reader's cache before it moves (#602)", () => {
  const sealed = async (value: string) => ({ version: "2", fingerprint: await versionFingerprint(value) });

  test("the settling window is the longest cache any Worker may hold a secret for", () => {
    expect(REENCRYPTION_SETTLE_MS).toBe(MAX_SECRETS_CACHE_TTL_SECONDS * 1000);
  });

  test("the first sight of a version records it and settles; the move is due only once the window has passed", async () => {
    const at = new Date("2026-10-18T03:00:00.000Z");
    const first = await claimReencryption(db(), {
      name: NAME,
      dependent: JWKS,
      holder: HOLDER,
      sealed: await sealed("b"),
      now: at,
    });
    expect(first).toEqual({ state: "settling", until: new Date(at.getTime() + REENCRYPTION_SETTLE_MS) });

    // A second isolate, a minute later, does not restart the clock.
    const later = new Date(at.getTime() + 60_000);
    const second = await claimReencryption(db(), {
      name: NAME,
      dependent: JWKS,
      holder: HOLDER,
      sealed: await sealed("b"),
      now: later,
    });
    expect(second).toEqual(first);

    const past = new Date(at.getTime() + REENCRYPTION_SETTLE_MS);
    expect(
      await claimReencryption(db(), {
        name: NAME,
        dependent: JWKS,
        holder: HOLDER,
        sealed: await sealed("b"),
        now: past,
      }),
    ).toEqual({
      state: "due",
    });
  });

  test("once moved, the claim says so", async () => {
    await moved("2", "b");
    expect(
      await claimReencryption(db(), { name: NAME, dependent: JWKS, holder: HOLDER, sealed: await sealed("b") }),
    ).toEqual({
      state: "moved",
    });
  });

  test("a moved row for the same version key but another value starts a fresh window", async () => {
    await moved("2", "old-two");
    const at = new Date("2026-10-18T03:00:00.000Z");
    expect(
      await claimReencryption(db(), {
        name: NAME,
        dependent: JWKS,
        holder: HOLDER,
        sealed: await sealed("new-two"),
        now: at,
      }),
    ).toEqual({
      state: "settling",
      until: new Date(at.getTime() + REENCRYPTION_SETTLE_MS),
    });
  });
});
