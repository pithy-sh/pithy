// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { forgetComposition, recordComposition } from "@pithy-sh/core/src/capability/composition";
import { afterEach, describe, expect, test } from "vitest";
import { payments } from "../capability";
import { reportPaymentsUsage } from "./usage";

/** A step runner that runs each step inline, as an engine with an empty journal would. */
const inline = { do: <T>(_name: string, fn: () => Promise<T>) => fn(), sleep: async () => {} };

class Terminal extends Error {}

afterEach(() => forgetComposition());

describe("reportPaymentsUsage", () => {
  test("reaches the composed payments capability, and reports nothing where nothing is billed by quantity", async () => {
    recordComposition([payments({ billingSubject: "user" })]);
    expect(await reportPaymentsUsage({}, {}, inline, Terminal)).toBeNull();
  });

  test("outside a composed Worker it raises a wiring fault naming what to export, rather than reporting nothing", async () => {
    await expect(reportPaymentsUsage({}, {}, inline, Terminal)).rejects.toMatchObject({
      payload: { code: "core/internal", action: expect.stringContaining("createBackend") },
    });
  });
});
