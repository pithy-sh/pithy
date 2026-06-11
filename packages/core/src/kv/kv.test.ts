import type { KVNamespace } from "@cloudflare/workers-types";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { PithyError } from "../error/pithyError";
import { TypedKv } from "./kv";

// Config validation runs in the constructor, before any KV access, so a dummy
// namespace is enough — these tests never touch a binding.
const namespace = {} as unknown as KVNamespace;

const Value = z.object({ x: z.number().describe("A value field.") }).describe("A KV value.");
const Key = z.object({ id: z.string().describe("The single key segment.") }).describe("A one-segment key.");
const Meta = z.object({ flag: z.boolean().describe("A small flag.") }).describe("List-time metadata.");

// biome-ignore lint/suspicious/noExplicitAny: exercising the JS/cast escape hatch the runtime guards exist for.
type AnyConfig = any;

function construct(config: AnyConfig): () => TypedKv<typeof Value, typeof Key> {
  return () => new TypedKv(namespace, { prefix: "assets", key: Key, value: Value, ...config });
}

describe("TypedKv config validation", () => {
  test("accepts a minimal valid config", () => {
    expect(construct({})).not.toThrow();
  });

  test("rejects an empty prefix", () => {
    expect(construct({ prefix: "" })).toThrow(/prefix must be a non-empty/);
  });

  test("config violations throw a typed PithyError (core/internal)", () => {
    try {
      construct({ prefix: "" })();
      throw new Error("expected construction to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PithyError);
      expect((err as PithyError).payload.code).toBe("core/internal");
    }
  });

  test("rejects an empty separator", () => {
    expect(construct({ separator: "" })).toThrow(/separator must be a non-empty/);
  });

  test("rejects a prefix that contains the separator", () => {
    expect(construct({ prefix: "a:b" })).toThrow(/must not contain the separator/);
  });

  test("rejects a key with no segments", () => {
    expect(construct({ key: z.object({}).describe("Empty key.") })).toThrow(/at least one segment/);
  });

  test("rejects deriveMetadata without a metadata schema", () => {
    expect(construct({ deriveMetadata: () => ({ flag: true }) })).toThrow(/deriveMetadata requires a metadata schema/);
  });

  test("accepts deriveMetadata when a metadata schema is present", () => {
    expect(construct({ metadata: Meta, deriveMetadata: () => ({ flag: true }) })).not.toThrow();
  });

  test("rejects a non-positive default TTL", () => {
    expect(construct({ ttlSeconds: 0 })).toThrow(/ttlSeconds must be positive/);
    expect(construct({ ttlSeconds: -5 })).toThrow(/ttlSeconds must be positive/);
  });
});
