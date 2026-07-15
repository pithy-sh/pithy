import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { describe, expect, test } from "vitest";
import { createCliLogger } from "./logger";

/** Capture the CLI logger's lines via the injectable sink. */
function lines(options: Parameters<typeof createCliLogger>[0] = {}) {
  const out: string[] = [];
  return { out, log: createCliLogger({ ...options, write: (line) => out.push(line) }) };
}

describe("createCliLogger", () => {
  test("is quiet by default — only warn and above surface as diagnostics", () => {
    const { out, log } = lines();
    log.debug("noise");
    log.info("noise");
    log.warn("heard");
    log.error("heard");
    expect(out).toHaveLength(2);
  });

  test("--debug drops the threshold to debug (verbose)", () => {
    const { out, log } = lines({ debug: true });
    log.debug("seen");
    expect(out).toHaveLength(1);
  });

  test("renders a human, colorized line by default", () => {
    // NO_COLOR/CI may disable color; assert the structure regardless of ANSI.
    const { out, log } = lines({ debug: true });
    log.warn("slow deploy", { worker: "api" });
    expect(out[0]).toContain("WARN");
    expect(out[0]).toContain("slow deploy");
    expect(out[0]).toContain("worker=api");
  });

  test("--json emits one structured record per line for agents/CI", () => {
    const { out, log } = lines({ debug: true, json: true });
    log.info("scaffolded", { app: "acme" });
    const parsed = JSON.parse(out[0] ?? "") as LogRecord;
    expect(parsed).toMatchObject({ level: "info", msg: "scaffolded", fields: { app: "acme" } });
  });
});
