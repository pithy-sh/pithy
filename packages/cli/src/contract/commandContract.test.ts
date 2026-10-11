// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { defineCommand } from "citty";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ownNamesOnly } from "../dispatch";
import { contractOf, FlagGroup, withContract } from "./commandContract";

const Payload = z.object({ command: z.literal("probe").describe('`"probe"`.') }).describe("A probe.");

describe("withContract", () => {
  test("hands back the same command, carrying its contract", () => {
    const command = defineCommand({ meta: { name: "probe" }, run: () => undefined });
    const contract = {
      output: "document",
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
    expect(() => withContract(command(), { output: "document", ...facts })).toThrow(PithyError);
    expect(() => withContract(command(), { output: "stream", ...facts })).toThrow(PithyError);
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
