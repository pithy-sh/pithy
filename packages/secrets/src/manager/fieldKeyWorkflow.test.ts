// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EncryptionConfig } from "@pithy-sh/core/src/crypto/envelope";
import { describe, expect, test } from "vitest";
import type { FieldKeyCommand } from "../rotation/fieldKeyRotation";
import {
  encryptedColumnStamp,
  type FieldKeyEnv,
  fieldKeyInstanceId,
  scheduleFieldKeyRotation,
} from "./fieldKeyWorkflow";

function env(over: Partial<FieldKeyEnv> = {}): FieldKeyEnv {
  return { SECRETS: {} as never, SECRETS_ENCRYPTION_KEYS: "{}", ...over };
}

function keys(versions: string[], lastRotatedAt: string): string {
  const config: EncryptionConfig = {
    currentVersion: versions[versions.length - 1] as string,
    versions: Object.fromEntries(versions.map((version) => [version, "a2V5"])),
    lastRotatedAt,
  };
  return JSON.stringify(config);
}

async function scheduled(fieldKeys: string | undefined, now: Date): Promise<[string, FieldKeyCommand][]> {
  const started: [string, FieldKeyCommand][] = [];
  await scheduleFieldKeyRotation(
    env(fieldKeys === undefined ? {} : { PITHY_FIELD_KEYS: fieldKeys }),
    now,
    async (id, command) => {
      started.push([id, command]);
    },
  );
  return started;
}

describe("scheduleFieldKeyRotation", () => {
  const now = new Date("2026-10-22T03:00:00.000Z");

  test("rotates every 30 days, by the field key's own clock", async () => {
    expect(await scheduled(keys(["1", "2"], "2026-09-22T03:00:00.000Z"), now)).toEqual([
      ["field-keys-rotate-2-2026-10-22", { mode: "rotate" }],
    ]);
    expect(await scheduled(keys(["1", "2"], "2026-10-01T03:00:00.000Z"), now)).toEqual([]);
  });

  test("between rotations, backfills only while a version is past the window", async () => {
    expect(await scheduled(keys(["1", "2", "3"], "2026-10-10T03:00:00.000Z"), now)).toEqual([
      ["field-keys-backfill-3-2026-10-22", { mode: "backfill" }],
    ]);
  });

  test("a manager that binds no field key starts nothing", async () => {
    expect(await scheduled(undefined, now)).toEqual([]);
  });

  test("one id per mode, pointer and UTC day", () => {
    expect(fieldKeyInstanceId("rotate", "4", now)).toBe("field-keys-rotate-4-2026-10-22");
  });
});

describe("encryptedColumnStamp", () => {
  test("absent is no columns, and anything that does not parse is refused without echoing it", () => {
    expect(encryptedColumnStamp(env())).toEqual({ columns: [], unread: [], unrotatable: [] });
    expect(() => encryptedColumnStamp(env({ ENCRYPTED_COLUMNS: "{nope" }))).toThrow();
    expect(() =>
      encryptedColumnStamp(env({ ENCRYPTED_COLUMNS: JSON.stringify({ columns: [{ table: "x; drop" }] }) })),
    ).toThrow();
  });
});
