// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ownNamesOnly } from "../dispatch";
import { formatJsonLine } from "../terminal/output";
import { contractOf, FlagGroup, publishedEvents, publishedPayload, withContract } from "./commandContract";

const Payload = z.object({ command: z.literal("probe").describe('`"probe"`.') }).describe("A probe.");

describe("withContract", () => {
  test("hands back the same command, carrying its contract", () => {
    const command = defineCommand({ meta: { name: "probe" }, run: () => undefined });
    const contract = {
      output: "document",
      schemaVersion: 1,
      payload: Payload,
      mutates: false,
      idempotent: true,
      needsNetwork: false,
    } as const;
    expect(withContract(command, contract)).toBe(command);
    expect(contractOf(command)).toBe(contract);
  });

  test("a command without one has none", () => {
    expect(contractOf(defineCommand({ meta: { name: "group" } }))).toBeUndefined();
  });

  /**
   * The reason for a symbol-keyed property rather than a side table: `ownNamesOnly` copies every command
   * it wraps, and a `WeakMap` keyed on the original would find nothing on the copy citty is handed.
   */
  test("survives the copy dispatch makes on the way to citty", async () => {
    const leaf = withContract(defineCommand({ meta: { name: "leaf" }, run: () => undefined }), {
      output: "none",
      mutates: true,
      idempotent: false,
      needsNetwork: false,
    });
    const parent = withContract(
      defineCommand({ meta: { name: "parent" }, subCommands: { leaf }, run: () => undefined }),
      {
        output: "none",
        mutates: false,
        idempotent: true,
        needsNetwork: false,
      },
    );
    const wrapped = ownNamesOnly(parent);
    expect(wrapped).not.toBe(parent);
    expect(contractOf(wrapped)).toBe(contractOf(parent));
    expect({ ...leaf }).not.toBe(leaf);
    expect(contractOf({ ...leaf })).toBe(contractOf(leaf));
  });

  test("refuses a payload with no --json output, and --json output with no payload", () => {
    const command = () => defineCommand({ meta: { name: "probe" } });
    const facts = { mutates: false, idempotent: true, needsNetwork: false } as const;
    expect(() => withContract(command(), { output: "none", payload: Payload, ...facts })).toThrow(PithyError);
    expect(() => withContract(command(), { output: "document", schemaVersion: 1, ...facts })).toThrow(PithyError);
    expect(() => withContract(command(), { output: "stream", schemaVersion: 1, ...facts })).toThrow(PithyError);
  });

  /** The version is what a parser keys its expectations on, so every payload has one and nothing else does (#697). */
  test("a payload declares its schemaVersion, a positive integer, and no output declares none", () => {
    const command = () => defineCommand({ meta: { name: "probe" } });
    const facts = { payload: Payload, mutates: false, idempotent: true, needsNetwork: false } as const;
    expect(() => withContract(command(), { output: "document", ...facts })).toThrow(PithyError);
    expect(() => withContract(command(), { output: "document", schemaVersion: 0, ...facts })).toThrow(PithyError);
    expect(() => withContract(command(), { output: "document", schemaVersion: 1.5, ...facts })).toThrow(PithyError);
    expect(() =>
      withContract(command(), {
        output: "none",
        schemaVersion: 1,
        mutates: false,
        idempotent: true,
        needsNetwork: false,
      }),
    ).toThrow(PithyError);
    expect(() => withContract(command(), { output: "document", schemaVersion: 2, ...facts })).not.toThrow();
  });

  test("progress records are declared only beside a payload they close on", () => {
    const facts = { mutates: false, idempotent: true, needsNetwork: false } as const;
    expect(() =>
      withContract(defineCommand({ meta: { name: "probe" } }), { output: "none", events: Payload, ...facts }),
    ).toThrow(PithyError);
  });

  /** The command runs inside its version, so whatever line it formats is stamped with no help from the call site. */
  test("a command's run formats its lines at its own schemaVersion", async () => {
    let line = "";
    const command = withContract(
      defineCommand({
        meta: { name: "probe" },
        run: async () => {
          await Promise.resolve();
          line = formatJsonLine({ command: "probe" });
        },
      }),
      { output: "document", schemaVersion: 3, payload: Payload, mutates: false, idempotent: true, needsNetwork: false },
    );
    await command.run?.({ rawArgs: [], args: { _: [] }, cmd: command } as never);
    expect(line).toBe('{"command":"probe","schemaVersion":3}');
    expect(formatJsonLine({ command: "probe" })).toBe('{"command":"probe"}');
  });
});

describe("publishedPayload", () => {
  const facts = { mutates: false, idempotent: true, needsNetwork: false } as const;
  const contracted = (payload: z.ZodType, schemaVersion = 1) =>
    contractOf(
      withContract(defineCommand({ meta: { name: "probe" } }), {
        output: "document",
        schemaVersion,
        payload,
        ...facts,
      }),
    );

  test("an object gains schemaVersion as a literal, keeps its description, and stays as strict as it was", () => {
    const contract = contracted(Payload, 2);
    if (contract === undefined) throw new Error("no contract");
    const published = publishedPayload(contract);
    expect(published?.description).toBe("A probe.");
    expect(published?.safeParse({ command: "probe", schemaVersion: 2 }).success).toBe(true);
    expect(published?.safeParse({ command: "probe", schemaVersion: 1 }).success).toBe(false);
    expect(published?.safeParse({ command: "probe" }).success).toBe(false);
    // A plain object drops what it does not name, which is what lets `expectConforms` see an undeclared key.
    expect(published?.parse({ command: "probe", schemaVersion: 2, extra: 1 })).toEqual({
      command: "probe",
      schemaVersion: 2,
    });
    const versioned = z.toJSONSchema(published as z.ZodType) as {
      properties: Record<string, { description?: string }>;
    };
    expect(versioned.properties.schemaVersion?.description).toMatch(/version/i);
  });

  test("a loose object stays loose", () => {
    const contract = contracted(z.looseObject({ a: z.string().describe("A.") }).describe("Loose."));
    if (contract === undefined) throw new Error("no contract");
    expect(publishedPayload(contract)?.parse({ a: "x", schemaVersion: 1, b: 2 })).toEqual({
      a: "x",
      schemaVersion: 1,
      b: 2,
    });
  });

  test("every member of a union, nested or not, carries it", () => {
    const one = z.object({ kind: z.literal("one").describe("One.") }).describe("First.");
    const two = z.object({ kind: z.literal("two").describe("Two.") }).describe("Second.");
    const three = z.object({ kind: z.literal("three").describe("Three.") }).describe("Third.");
    const contract = contracted(z.union([one, z.union([two, three]).describe("Inner.")]).describe("Outer."), 4);
    if (contract === undefined) throw new Error("no contract");
    const published = publishedPayload(contract) as z.ZodType;
    expect(published.description).toBe("Outer.");
    for (const kind of ["one", "two", "three"]) {
      expect(published.safeParse({ kind, schemaVersion: 4 }).success).toBe(true);
      expect(published.safeParse({ kind }).success).toBe(false);
    }
  });

  test("a command with no payload publishes none, and its records are versioned the same way", () => {
    const none = contractOf(withContract(defineCommand({ meta: { name: "probe" } }), { output: "none", ...facts }));
    if (none === undefined) throw new Error("no contract");
    expect(publishedPayload(none)).toBeUndefined();
    expect(publishedEvents(none)).toBeUndefined();
    const record = z.object({ event: z.literal("start").describe("Start.") }).describe("A record.");
    const streaming = contractOf(
      withContract(defineCommand({ meta: { name: "probe" } }), {
        output: "document",
        schemaVersion: 5,
        payload: Payload,
        events: record,
        ...facts,
      }),
    );
    if (streaming === undefined) throw new Error("no contract");
    expect(publishedEvents(streaming)?.safeParse({ event: "start", schemaVersion: 5 }).success).toBe(true);
  });

  test("a payload that is neither an object nor a union of them is refused when it is published", () => {
    const contract = contracted(z.array(z.string().describe("S.")).describe("A list."));
    if (contract === undefined) throw new Error("no contract");
    expect(() => publishedPayload(contract)).toThrow(PithyError);
  });
});

describe("FlagGroup", () => {
  test("a group of one flag is not a group", () => {
    expect(FlagGroup.safeParse({ kind: "exactlyOne", flags: ["--env"], rule: "One." }).success).toBe(false);
    expect(FlagGroup.safeParse({ kind: "exactlyOne", flags: ["--env", "--feature"], rule: "One." }).success).toBe(true);
  });

  test("a requirement names what it needs, and whether any one of them is enough", () => {
    expect(
      FlagGroup.parse({
        kind: "requires",
        flag: "--update",
        needs: ["--scope", "--issuer"],
        any: true,
        rule: "Say what.",
      }),
    ).toMatchObject({ any: true });
    expect(FlagGroup.safeParse({ kind: "requires", flag: "--update", needs: [], any: true, rule: "x" }).success).toBe(
      false,
    );
  });
});
