// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { getSchema } from "better-auth/db";
import { describe, expect, test } from "vitest";
import { authSchemaOptions } from "./kitSchema";
import { KIT_SCHEMA_FIELDS } from "./pluginTables";

describe("KIT_SCHEMA_FIELDS", () => {
  test("is every table and column the kit's own plugins give the schema", () => {
    const live = Object.fromEntries(
      Object.entries(getSchema(authSchemaOptions([]))).map(([model, spec]) => [model, Object.keys(spec.fields)]),
    );
    expect(KIT_SCHEMA_FIELDS).toEqual(live);
  });
});
