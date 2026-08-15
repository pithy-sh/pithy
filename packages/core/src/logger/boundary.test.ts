// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { HttpError } from "../error/http";
import { InternalError } from "../error/pithyError";
import { createLogger } from "./logger";
import { LogRecord } from "./record";

/**
 * The logger seam's one security rule: it is an **internal** surface. It carries the full `ErrorPayload`
 * including `detail` — the inverse of the HTTP codec, which strips `detail` as the single client
 * boundary. These tests pin both halves of that invariant.
 */

declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true; query: "?raw"; import: "default" }): Record<string, string>;
  }
}

// The client/user-facing error surfaces, imported as raw source so we can assert their dependencies.
const errorSources = import.meta.glob(["../error/http.ts", "../error/terminal.ts", "../error/payload.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
});

/**
 * A module that **does** import the logger, read the same way.
 *
 * The scan below is a `not.toMatch`, and a `not.toMatch` over nothing is the most comfortable green in
 * the repository: an empty glob generates no tests, `passWithNoTests` is on, and a renamed `error/`
 * directory would have retired this gate in silence. So the population is asserted, and the needle is
 * proven findable against a source that really carries it — a negative assertion nobody has watched
 * match is not a gate, it is a sentence about one.
 */
const loggerConsumer = import.meta.glob(["../kv/kv.ts"], { eager: true, query: "?raw", import: "default" });

/** The one pattern both halves below are written against. Named once, so the control tests the gate. */
const IMPORTS_LOGGER = /["'](?:\.\.?\/)*logger\//;

describe("logger boundary — carries detail (internal surface)", () => {
  test("a logged PithyError keeps its detail on the record", () => {
    const records: LogRecord[] = [];
    const log = createLogger({ level: "error", sink: (r) => records.push(r) });
    log.error("write failed", { error: new InternalError({ message: "boom", detail: "SQLITE_BUSY: locked" }) });
    expect(records[0]?.error?.detail).toBe("SQLITE_BUSY: locked");
    // And the record still validates against its schema, detail included.
    expect(() => LogRecord.parse(records[0])).not.toThrow();
  });

  test("the HTTP codec — the inverse surface — strips the same detail", () => {
    const wire = HttpError.encode(new InternalError({ message: "boom", detail: "SQLITE_BUSY: locked" }).payload);
    expect("detail" in wire).toBe(false);
  });
});

/**
 * Static guard: the client-facing error surfaces (`http.ts` the wire encoder, `terminal.ts` the CLI
 * renderer, `payload.ts` the wire shape) must never depend on the logger — so a log record (with
 * `detail`) can't reach a client response or the terminal error line through them. The logger stays on
 * the internal side by construction; if someone wires it into a response surface, this fails.
 */
describe("logger boundary — never wired to a client surface", () => {
  test("the sweep read all three surfaces, and read them as source", () => {
    // Exact, because the glob names three files: the population cannot legitimately be any other
    // number, so a floor would be slack for nothing. The keys are pinned as well as counted — a glob
    // that quietly matched two of three would otherwise pass here and generate two tests below.
    expect(Object.keys(errorSources)).toHaveLength(3);
    expect(Object.keys(errorSources).sort()).toEqual([
      "../error/http.ts",
      "../error/payload.ts",
      "../error/terminal.ts",
    ]);
    for (const source of Object.values(errorSources)) expect(source.length).toBeGreaterThan(200);
  });

  test("the pattern really matches a module that imports the logger", () => {
    // The control. Without it, every assertion below passes on an empty string.
    expect(Object.keys(loggerConsumer)).toHaveLength(1);
    for (const source of Object.values(loggerConsumer)) expect(source).toMatch(IMPORTS_LOGGER);
  });

  for (const [path, source] of Object.entries(errorSources)) {
    test(`${path} does not import the logger`, () => {
      expect(source).not.toMatch(IMPORTS_LOGGER);
    });
  }
});
