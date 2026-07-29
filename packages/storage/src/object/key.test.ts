import { describe, expect, test } from "vitest";
import { deriveObjectKey, isDerivedObjectKey, isValidObjectKey, MAX_OBJECT_KEY_BYTES, OBJECT_KEY_PREFIX } from "./key";

describe("deriveObjectKey", () => {
  test("derives an opaque prefixed key, never anything the client supplied", () => {
    const key = deriveObjectKey();
    expect(key.startsWith(OBJECT_KEY_PREFIX)).toBe(true);
    expect(key.slice(OBJECT_KEY_PREFIX.length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("never repeats — a re-upload cannot overwrite a live object", () => {
    const keys = new Set(Array.from({ length: 1000 }, deriveObjectKey));
    expect(keys.size).toBe(1000);
  });

  test("fits R2's key limit with room to spare", () => {
    expect(isValidObjectKey(deriveObjectKey())).toBe(true);
    expect(deriveObjectKey().length).toBeLessThan(64);
  });
});

describe("isDerivedObjectKey", () => {
  test("tells this capability's objects from a co-tenant's, which is what the sweep needs", () => {
    expect(isDerivedObjectKey(deriveObjectKey())).toBe(true);
    expect(isDerivedObjectKey("media/image/42")).toBe(false);
  });
});

describe("isValidObjectKey", () => {
  test("measures R2's 1,024-byte limit in bytes, not characters", () => {
    expect(isValidObjectKey("a".repeat(MAX_OBJECT_KEY_BYTES))).toBe(true);
    expect(isValidObjectKey("a".repeat(MAX_OBJECT_KEY_BYTES + 1))).toBe(false);
    // Every one of these is 4 bytes in UTF-8, so 257 of them exceed the limit at 257 characters.
    expect(isValidObjectKey("𝄞".repeat(257))).toBe(false);
  });

  test("rejects an empty key", () => {
    expect(isValidObjectKey("")).toBe(false);
  });
});
