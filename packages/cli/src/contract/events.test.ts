// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { progressRecord } from "../terminal/progress";
import { eventsOption, eventsRecord } from "./events";

/** One `--events` record, as a schema a command publishes beside its payload (#697). */
describe("eventsRecord", () => {
  const Record = eventsRecord("deploy", {
    start: { binding: z.string().describe("The binding.") },
    settled: { worker: z.object({ name: z.string().describe("Its name.") }).describe("The row.") },
  });

  test("accepts exactly what progressRecord writes for either phase, with or without the extras", () => {
    for (const record of [
      progressRecord("deploy", { phase: "start", what: "api" }),
      progressRecord("deploy", { phase: "start", what: "api", data: { binding: "DB" } }),
      progressRecord("deploy", { phase: "settled", line: "api: deployed." }),
      progressRecord("deploy", { phase: "settled", line: "api: deployed.", data: { worker: { name: "api" } } }),
    ]) {
      expect(Record.parse(record)).toEqual(record);
    }
  });

  test("a record whose producer handed a key named like the framing still parses as its own phase", () => {
    const record = progressRecord("deploy", {
      phase: "settled",
      line: "api: deployed.",
      data: { event: "start", command: "provision", worker: { name: "api" } },
    });
    expect(Record.parse(record)).toMatchObject({ command: "deploy", event: "settled", line: "api: deployed." });
  });

  test("refuses another command's record, an unknown phase, and a settle with no line", () => {
    expect(Record.safeParse({ command: "provision", event: "start", what: "api" }).success).toBe(false);
    expect(Record.safeParse({ command: "deploy", event: "finished", what: "api" }).success).toBe(false);
    expect(Record.safeParse({ command: "deploy", event: "settled" }).success).toBe(false);
  });

  test("every field says what it is", () => {
    const schema = z.toJSONSchema(Record, { io: "input" }) as { anyOf: { properties: Record<string, unknown> }[] };
    for (const branch of schema.anyOf) {
      for (const property of Object.values(branch.properties)) {
        expect(property).toHaveProperty("description");
      }
    }
  });
});

describe("eventsOption", () => {
  test("names the command to stream under when --events was passed beside --json, and nothing otherwise", () => {
    expect(eventsOption("deploy", { json: true, events: true })).toEqual({ events: "deploy" });
    expect(eventsOption("deploy", { json: true, events: false })).toEqual({});
  });

  /**
   * **The parse decides, not the tokens.** `--json --no-json --events` reaches the run with `json` false, and
   * a stream installed then would mix records into the prose a person reads.
   */
  test("streams nothing when --json was turned back off, whatever --events says", () => {
    expect(eventsOption("deploy", { json: false, events: true })).toEqual({});
  });
});
