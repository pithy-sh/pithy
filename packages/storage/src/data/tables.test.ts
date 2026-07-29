import { describe, expect, it } from "vitest";
import { StorageShare } from "./share";
import { StorageObject } from "./storageObject";
import { STORAGE_OBJECTS_TABLE, STORAGE_SHARES_TABLE, storageTables } from "./tables";

/** camelCase here; `CamelCasePlugin` snake-cases it in the DDL. */
const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("table prefixing (CLAUDE.md §Data layer)", () => {
  it("prefixes every provided table pithy_storage_, so it can never clash with an adopter's own", () => {
    for (const name of Object.keys(storageTables())) {
      expect(toSnake(name)).toMatch(/^pithy_storage_/);
    }
  });

  it("names the tables the migration creates", () => {
    expect(Object.keys(storageTables()).sort()).toEqual([STORAGE_OBJECTS_TABLE, STORAGE_SHARES_TABLE].sort());
  });
});

describe("StorageObject codec round-trip", () => {
  const object: StorageObject = {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    key: "obj/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    path: "invoices/2026/q3.pdf",
    ownerId: "u1",
    contentType: "application/pdf",
    size: 4096,
    visibility: "private",
    checksum: "a".repeat(64),
    status: "stored",
    uploadId: null,
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_001_000),
  };

  it("encodes dates to ms-epoch and decodes them back", () => {
    const row = StorageObject.encode(object);
    expect(row.createdAt).toBe(1_700_000_000_000);
    expect(row.updatedAt).toBe(1_700_000_001_000);
    expect(StorageObject.parse(row)).toEqual(object);
  });

  it("round-trips a pending multipart row — null size and checksum, an uploadId in flight", () => {
    const pending: StorageObject = { ...object, size: null, checksum: null, status: "pending", uploadId: "up-1" };
    expect(StorageObject.parse(StorageObject.encode(pending))).toEqual(pending);
  });

  it("round-trips a system-owned public object with no owner", () => {
    const system: StorageObject = { ...object, ownerId: null, visibility: "public" };
    expect(StorageObject.parse(StorageObject.encode(system))).toEqual(system);
  });

  it("rejects a status or visibility outside the enum, so a bad row never reaches the app shape", () => {
    expect(StorageObject.safeParse({ ...StorageObject.encode(object), status: "uploading" }).success).toBe(false);
    expect(StorageObject.safeParse({ ...StorageObject.encode(object), visibility: "unlisted" }).success).toBe(false);
  });
});

describe("StorageShare codec round-trip", () => {
  const share: StorageShare = {
    token: "sh_01HQ",
    objectId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    expiresAt: new Date(1_700_000_500_000),
    revokedAt: null,
    createdAt: new Date(1_700_000_000_000),
  };

  it("encodes both nullable timestamps to ms-epoch and back", () => {
    const row = StorageShare.encode(share);
    expect(row.expiresAt).toBe(1_700_000_500_000);
    expect(row.revokedAt).toBe(null);
    expect(StorageShare.parse(row)).toEqual(share);
  });

  it("round-trips a revoked, never-expiring link — the state a presigned URL cannot represent", () => {
    const revoked: StorageShare = { ...share, expiresAt: null, revokedAt: new Date(1_700_000_400_000) };
    expect(StorageShare.parse(StorageShare.encode(revoked))).toEqual(revoked);
  });
});
