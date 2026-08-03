// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ArgsDef, CommandDef } from "citty";
import { describe, expect, test } from "vitest";
import turnstile from "./turnstile";

/** The `provision` subcommand's arg definitions — citty holds them as a plain object here. */
function provisionArgs(): ArgsDef {
  const sub = turnstile.subCommands as Record<string, CommandDef>;
  return (sub.provision?.args ?? {}) as ArgsDef;
}

describe("pithy turnstile provision args", () => {
  test("the domain guard has a non-interactive opt-out, off by default", () => {
    const args = provisionArgs();
    expect(args["allow-shared-domain"]).toMatchObject({ type: "boolean", default: false });
  });

  test("every provision arg is agent-drivable — flags only, nothing required by prompt", () => {
    const args = provisionArgs();
    expect(Object.keys(args).sort()).toEqual(["allow-shared-domain", "json", "worker"]);
    for (const arg of Object.values(args)) expect(arg).not.toMatchObject({ required: true });
  });
});
