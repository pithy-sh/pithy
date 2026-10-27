// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { blankComments } from "../text/comments";

// `import.meta.glob` is a vite/vitest feature; declare it so the typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true; query: "?raw"; import: "default" }): Record<string, string>;
  }
}

/**
 * **The room's platform discipline, held on its source.** What a room may not do is easier to state about
 * the code than to observe at runtime — a hibernation cannot be forced from a test, and a write that never
 * happens in one run may happen in another — so it is asserted here, on every line of the module.
 *
 * - The Hibernation API only: `ctx.acceptWebSocket`, never a socket's own `accept()`, which pins the object
 *   in memory and loses every participant the first time it is evicted.
 * - No Durable Object storage, no D1, no KV: the room holds nothing but who is here.
 * - `cloudflare:workers` is named by this module and no other in core, so nothing `pithy.config.ts` loads in
 *   Node reaches it; the routes name the class as a type at most.
 */
const sources = import.meta.glob(["./**/*.ts", "../**/*.ts", "!./**/*.test.ts", "!../**/*.test.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
});

const ROOM = blankComments(sources["./durableObject.ts"] ?? "");

describe("the presence room", () => {
  test("is read, and the sweep below is over core rather than over nothing", () => {
    expect(ROOM).toContain("class PresenceRoom");
    // Near-exact: core held 197 non-test modules when this was written, and the floor is 95% of that.
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(187);
  });

  test("accepts sockets through the Hibernation API only", () => {
    expect(ROOM).toContain("this.ctx.acceptWebSocket(");
    expect(ROOM).not.toMatch(/\b(?:server|client|ws|socket)\.accept\(/);
  });

  test("writes nothing to Durable Object storage, D1 or KV", () => {
    expect(ROOM).not.toMatch(/\bstorage\b/);
    expect(ROOM).not.toMatch(/\.prepare\(|\.put\(|\.batch\(|\bDB\b/);
  });

  test("keeps every participant on its socket, never in a field", () => {
    expect(ROOM).toContain("serializeAttachment(");
    expect(ROOM).not.toMatch(/private\s+\w+\s*(?::[^=;]*)?=\s*new\s+(?:Map|Set)\b/);
  });

  test("is the only module in core that names cloudflare:workers", () => {
    const naming = Object.entries(sources)
      .filter(([, source]) => /from\s+["']cloudflare:workers["']/.test(blankComments(source)))
      .map(([path]) => path);
    expect(naming).toEqual(["./durableObject.ts"]);
  });
});
