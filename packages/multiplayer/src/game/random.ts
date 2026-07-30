// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Server-authoritative randomness for game models — the primitive a house cannot let a client control.
 *
 * A session mints a random **seed** at creation (128 bits of `crypto.getRandomValues`) and stores it. From
 * that seed a **deterministic** stream of draws is derived: given the seed and a cursor, every value is
 * fixed and reproducible. The Durable Object advances the cursor as a model draws and persists it, so the
 * stream never repeats and survives hibernation.
 *
 * Determinism is what makes it **provably fair**. The seed's SHA-256 hash is committed up front (shown to
 * every player before a single die is rolled) and the seed itself is revealed when the session ends. An
 * auditor hashes the revealed seed to check it against the commitment, then replays this exact algorithm to
 * verify every roll — so the house cannot have chosen or re-rolled an outcome. It is also why models must
 * draw randomness only in `init`/`apply` (the transitions the DO persists), never in `resolve`/`redact`.
 */
export interface RandomSource {
  /** The next draw as a float in [0, 1). */
  next(): number;
  /** The next draw as an integer in [minInclusive, maxInclusive] — a die is `int(1, 6)`. */
  int(minInclusive: number, maxInclusive: number): number;
  /** The next draw as a uniformly-chosen element of `items`. */
  pick<T>(items: readonly T[]): T;
}

/** The persisted RNG state: the seed, its committed hash, and how many values have been drawn. */
export const RngState = z
  .object({
    seed: z
      .string()
      .describe(
        "The session's random seed (hex). Secret until the session is terminal, then revealed for verification.",
      ),
    seedHash: z
      .string()
      .describe("SHA-256 of the seed (hex) — the fairness commitment, shown to players before any draw."),
    cursor: z
      .number()
      .int()
      .describe("How many values have been drawn from the stream. Advances as models draw; persisted by the DO."),
  })
  .describe("A session's provably-fair RNG state — seed, its commitment, and the stream position.");
export type RngState = z.infer<typeof RngState>;

/** Derive a 32-bit numeric base from the hex seed (an xmur3-style string hash). */
function seedToBase(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** A counter-based draw: a deterministic float in [0, 1) for a given base and counter (a splitmix32 mix). */
function draw(base: number, counter: number): number {
  let t = (base + Math.imul(counter, 0x9e3779b9)) >>> 0;
  t ^= t >>> 15;
  t = Math.imul(t, 0x2c1b3c6d) >>> 0;
  t ^= t >>> 12;
  t = Math.imul(t, 0x297a2d39) >>> 0;
  t ^= t >>> 15;
  return (t >>> 0) / 4294967296;
}

/** Bytes → lowercase hex. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Mint a fresh RNG state: 128 crypto-random bits of seed, its SHA-256 commitment, cursor at zero. Async
 * because the hash is (`crypto.subtle.digest`); called once, at session creation.
 */
export async function createRngState(): Promise<RngState> {
  const seedBytes = crypto.getRandomValues(new Uint8Array(16));
  const seed = toHex(seedBytes);
  const digest = await crypto.subtle.digest("SHA-256", seedBytes);
  return { seed, seedHash: toHex(new Uint8Array(digest)), cursor: 0 };
}

/**
 * A {@link RandomSource} over an RNG state, plus `spent()` — the cursor after the draws taken, which the DO
 * reads back to persist. The source is a closure over a local cursor; nothing mutates the passed state.
 */
export function randomSource(state: RngState): RandomSource & { spent(): number } {
  const base = seedToBase(state.seed);
  let cursor = state.cursor;
  const next = () => draw(base, cursor++);
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    spent: () => cursor,
  };
}
