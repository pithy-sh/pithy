// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { createGate } from "./testing";
import { interleaved } from "./testWorker.fixture.test";

beforeEach(() => {
  interleaved.runs.clear();
  interleaved.log.length = 0;
});

/** Registers the gates one run of `InterleavedWorkflow` stops at. */
function holdRun(run: string) {
  const gates = { held: createGate({ name: `${run} held` }), release: createGate({ name: `${run} released` }) };
  interleaved.runs.set(run, gates);
  return gates;
}

describe("createGate in a Workflow", () => {
  test("holds two instances of one Workflow mid-run and lets the second finish first", async () => {
    const first = holdRun("first");
    const second = holdRun("second");
    await using firstInstance = await introspectWorkflowInstance(env.INTERLEAVED, "first");
    await using secondInstance = await introspectWorkflowInstance(env.INTERLEAVED, "second");
    try {
      await env.INTERLEAVED.create({ id: "first", params: { run: "first" } });
      await first.held.opened();
      await env.INTERLEAVED.create({ id: "second", params: { run: "second" } });
      await second.held.opened();
      expect(interleaved.log).toEqual(["first:start", "first:held", "second:start", "second:held"]);

      second.release.open();
      await secondInstance.waitForStatus("complete");
      expect(interleaved.log).not.toContain("first:finish");

      first.release.open();
      await firstInstance.waitForStatus("complete");
      expect(interleaved.log.slice(4)).toEqual(["second:finish", "first:finish"]);
    } finally {
      first.release.open();
      second.release.open();
    }
  });
});

/** Registers gates for a run that passes straight through its hold step. */
function passRun(run: string) {
  const gates = holdRun(run);
  gates.release.open();
}

describe("introspectWorkflowInstance and instance ids", () => {
  test("refuses a second create under an id while its introspector is held", async () => {
    passRun("dup");
    await using instance = await introspectWorkflowInstance(env.INTERLEAVED, "dup");
    await env.INTERLEAVED.create({ id: "dup", params: { run: "dup" } });
    await instance.waitForStatus("complete");
    await expect(env.INTERLEAVED.create({ id: "dup", params: { run: "dup" } })).rejects.toThrow(/already exists/);
  });

  test("accepts a second create under an id once its introspector is disposed", async () => {
    passRun("reused");
    {
      await using instance = await introspectWorkflowInstance(env.INTERLEAVED, "reused");
      await env.INTERLEAVED.create({ id: "reused", params: { run: "reused" } });
      await instance.waitForStatus("complete");
    }
    await using again = await introspectWorkflowInstance(env.INTERLEAVED, "reused");
    await env.INTERLEAVED.create({ id: "reused", params: { run: "reused" } });
    await again.waitForStatus("complete");
    expect(interleaved.log.filter((entry) => entry === "reused:finish")).toHaveLength(2);
  });
});
