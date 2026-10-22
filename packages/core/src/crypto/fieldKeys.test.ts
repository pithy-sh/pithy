// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { InternalError } from "../error/pithyError";
import type { EncryptionConfig } from "./envelope";
import { FIELD_KEYS_BINDING, liveVersions, resolveFieldKeys } from "./fieldKeys";

/**
 * **The field key's two readers (#390).** `resolveFieldKeys` turns a binding into a key set and refuses everything
 * else without echoing a byte of it, because what failed to parse is the key. `liveVersions` is what the rotator's
 * retirement decision is computed from, so its order and its refusal are pinned here, not through the rotator.
 */

const KEY = "a2V5LW1hdGVyaWFsLXRoYXQtbXVzdC1uZXZlci1sZWFrIQ==";

function keySet(versions: string[], current = versions[0] as string): EncryptionConfig {
  return {
    currentVersion: current,
    versions: Object.fromEntries(versions.map((version) => [version, `${KEY}${version}`])),
    lastRotatedAt: "2026-09-01T00:00:00.000Z",
  };
}

/** Everything a refusal carries out of the process: its message and its whole payload. */
function surfaced(error: unknown): string {
  return JSON.stringify({ message: (error as Error).message, payload: (error as InternalError).payload });
}

async function refusal(keys: Parameters<typeof resolveFieldKeys>[0]): Promise<unknown> {
  try {
    await resolveFieldKeys(keys);
  } catch (error) {
    return error;
  }
  throw new Error("resolveFieldKeys did not refuse");
}

describe("resolveFieldKeys", () => {
  test("reads a Secrets Store binding, a JSON string, and a config already resolved, to the same key set", async () => {
    const config = keySet(["2", "1"]);
    expect(await resolveFieldKeys({ get: async () => JSON.stringify(config) })).toEqual(config);
    expect(await resolveFieldKeys(JSON.stringify(config))).toEqual(config);
    expect(await resolveFieldKeys(config)).toEqual(config);
  });

  test("refuses a Worker with no binding, naming the binding and the command that binds it", async () => {
    const error = await refusal(undefined);
    expect(error).toBeInstanceOf(InternalError);
    expect(surfaced(error)).toContain(FIELD_KEYS_BINDING);
    expect(surfaced(error)).toContain("secrets provision");
  });

  test("refuses text that is not JSON, and never echoes it", async () => {
    const text = `{"currentVersion":"1","versions":{"1":"${KEY}"`;
    for (const keys of [text, { get: async () => text }]) {
      const error = await refusal(keys);
      expect(error).toBeInstanceOf(InternalError);
      expect(surfaced(error)).toContain("is not valid JSON");
      expect(surfaced(error)).not.toContain(KEY);
    }
  });

  test("refuses JSON that is not a key set, and never echoes it", async () => {
    const wrong = { currentVersion: 1, versions: { "1": KEY } };
    for (const keys of [JSON.stringify(wrong), wrong as unknown as EncryptionConfig]) {
      const error = await refusal(keys);
      expect(error).toBeInstanceOf(InternalError);
      expect(surfaced(error)).toContain("is not a valid EncryptionConfig");
      expect(surfaced(error)).not.toContain(KEY);
    }
  });
});

describe("liveVersions", () => {
  test("is every version, newest first, as numbers, sorted numerically rather than as text", () => {
    expect(liveVersions(keySet(["9", "10", "1", "2"]))).toEqual([10, 9, 2, 1]);
  });

  test("refuses a version key that is not an integer, and names no key", () => {
    for (const bad of ["1.5", "two", "v3"]) {
      let caught: unknown;
      try {
        liveVersions(keySet(["1", bad], "1"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InternalError);
      expect(surfaced(caught)).toContain("not a stringified integer");
      expect(surfaced(caught)).not.toContain(KEY);
    }
  });
});
