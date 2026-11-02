// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingType } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { PermissionKey } from "./permissions";

/**
 * **What a binding of each kind needs the `ci-system` token to carry**, so that provisioning, deploying and
 * tearing down the resource behind it succeed under that token and under a signed-in session.
 *
 * Read off the binding rather than declared by a capability, because the adopter's own app binds resources
 * too and has no `ciPermissions` anyone would think to write. A kind a provision command creates with no
 * entry here fails `cli/src/provision/bindingPermissions.test.ts`.
 *
 * - `d1`, `secret` and `workflow` name what the `ci-system` base already carries.
 * - `kv`, `r2` and `vectorize` take write alone. Provisioning lists before it creates, and a write scope
 *   covers its read, as `OAUTH_SCOPES` records.
 * - `queue` and `artifacts` are reached by the API only, to create or reap; a Worker uses its binding.
 */
export const BINDING_PERMISSIONS: Readonly<Partial<Record<BindingType, readonly PermissionKey[]>>> = {
  d1: ["d1:read", "d1:write"],
  kv: ["kv:write"],
  r2: ["r2:write"],
  vectorize: ["vectorize:write"],
  queue: ["queues:write"],
  artifacts: ["artifacts:write"],
  secret: ["secrets:read", "secrets:write"],
  workflow: ["workers:write"],
};

/**
 * The permission keys every binding the capabilities declare needs, each once, in first-seen order. The
 * adopter's own app is a capability here like any other, so a bucket it declares counts.
 */
export function bindingPermissions(capabilities: readonly Capability[]): PermissionKey[] {
  const keys: PermissionKey[] = [];
  for (const capability of capabilities) {
    for (const binding of capability.requiredBindings) {
      for (const key of BINDING_PERMISSIONS[binding.type] ?? []) {
        if (!keys.includes(key)) keys.push(key);
      }
    }
  }
  return keys;
}
