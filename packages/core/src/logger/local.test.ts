import { describe, expect, test } from "vitest";
import { InternalError } from "../error/pithyError";
import { createLocalLogger } from "./local";
import type { LogRecord } from "./record";

/** Capture the lines a local logger writes. */
function lines(options: Partial<Parameters<typeof createLocalLogger>[0]> = {}) {
  const out: string[] = [];
  const log = createLocalLogger({ write: (line) => out.push(line), now: () => 1, ...options });
  return { out, log };
}

describe("createLocalLogger — human format", () => {
  test("renders LEVEL, name, msg, and fields as key=value", () => {
    const { out, log } = lines();
    log.child("cli").info("scaffolding", { app: "acme", count: 3 });
    expect(out[0]).toBe("INFO (cli) scaffolding app=acme count=3");
  });

  test("renders a carried error's code and detail", () => {
    const { out, log } = lines();
    log.error("write failed", { error: new InternalError({ message: "boom", detail: "SQLITE_BUSY" }) });
    expect(out[0]).toBe("ERROR write failed core/internal SQLITE_BUSY");
  });

  test("applies injected palette colors", () => {
    const { out, log } = lines({ palette: { error: (t) => `<${t}>`, dim: (t) => `[${t}]` } });
    log.error("nope", { k: "v" });
    expect(out[0]).toBe("<ERROR> nope [k=v]");
  });
});

describe("createLocalLogger — json stream", () => {
  test("emits one JSON line per record for agents/CI", () => {
    const { out, log } = lines({ json: true });
    log.info("hi", { a: 1 });
    const parsed = JSON.parse(out[0] ?? "") as LogRecord;
    expect(parsed).toEqual({ level: "info", msg: "hi", time: 1, fields: { a: 1 } });
  });
});

describe("createLocalLogger — level", () => {
  test("defaults to debug (verbose local diagnostics)", () => {
    const { out, log } = lines();
    log.debug("seen");
    expect(out).toHaveLength(1);
  });
});
