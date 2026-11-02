// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BINDING_PERMISSIONS } from "@pithy-sh/cloudflare/src/tokens/bindingPermissions";
import { BindingType, isProvisionedBinding } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { provisionableBindings } from "../feature/bindings";

/** Every binding kind the schema admits, read off the schema itself. */
const KINDS: readonly BindingType[] = BindingType.options.map((option) => option.value);

/** A capability declaring one binding of `type` — only the fields provisioning reads. */
function binding(type: BindingType): Capability {
  return { name: "app", requiredBindings: [{ type, name: "X" }] } as unknown as Capability;
}

describe("every kind a provision command creates carries its permission onto ci-system", () => {
  test("pithy provision creates something for at least one kind, so the sweep below is not vacuous", () => {
    expect(KINDS.filter((type) => provisionableBindings([binding(type)]).length > 0).length).toBeGreaterThan(0);
  });

  test.each(KINDS)("%s: provisioned, so it has an entry", (type) => {
    const created = provisionableBindings([binding(type)]).length > 0 || isProvisionedBinding(type);
    if (!created) return;
    expect(
      BINDING_PERMISSIONS[type] ?? [],
      `${type} is created by a provision command and has no permission`,
    ).not.toEqual([]);
  });
});
