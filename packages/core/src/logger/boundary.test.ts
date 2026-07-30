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
  for (const [path, source] of Object.entries(errorSources)) {
    test(`${path} does not import the logger`, () => {
      expect(source).not.toMatch(/["'](?:\.\.?\/)*logger\//);
    });
  }
});
