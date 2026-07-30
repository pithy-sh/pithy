// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ControlPlaneConnection } from "./connection";
import { CONTROL_PLANE_CONNECTIONS_TABLE, controlPlaneTables } from "./tables";

/** camelCase here; `CamelCasePlugin` snake-cases it in the DDL. */
const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("table prefixing (CLAUDE.md §Data layer)", () => {
  it("prefixes every provided table pithy_controlplane_, so it can never clash with an adopter's own", () => {
    for (const name of Object.keys(controlPlaneTables())) {
      expect(toSnake(name)).toMatch(/^pithy_controlplane_/);
    }
  });

  it("names the table the migration creates", () => {
    expect(Object.keys(controlPlaneTables())).toEqual([CONTROL_PLANE_CONNECTIONS_TABLE]);
    expect(toSnake(CONTROL_PLANE_CONNECTIONS_TABLE)).toBe("pithy_controlplane_connections");
  });

  it("maps the table to the schema that defines it — one Zod object is the whole table definition", () => {
    expect(controlPlaneTables()[CONTROL_PLANE_CONNECTIONS_TABLE]).toBe(ControlPlaneConnection);
  });
});
