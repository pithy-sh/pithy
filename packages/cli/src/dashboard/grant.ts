// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { type ControlPlaneScope, SEAM_SCOPES } from "@pithy-sh/core/src/controlPlane/scope/scope";

/**
 * What `pithy dashboard connect` grants when nobody narrowed it — derived from the Worker's own
 * declared admin surface, never from a list kept here.
 *
 * ## The problem this fixes
 *
 * `connect` granted `SEAM_SCOPES` and nothing else, so a freshly connected project opened to a
 * dashboard of refusals: every pane that reads a customer's data needs a scope the default did not
 * include. The refusal itself is well built — it names the missing scope and sells nothing — but a
 * successful connect that leaves the product unusable is not a refusal doing its job, it is a default
 * doing damage. `pithy-sh/dashboard`'s own self-connection held `manifest:read` and `keys:rotate`, read
 * `blocked` off the manifest for all six panes, and never made a single call. It looked like a broken
 * product.
 *
 * ## Why the default is derived rather than listed
 *
 * A list of scope names in the CLI is a second copy of a taxonomy that is deliberately federated: a
 * capability declares its own scopes and its own routes, and `GET /control-plane/manifest` reports the
 * union. A hard-coded default would be stale the day a capability lands or moves — and capabilities are
 * still landing. So the default is read from the same declaration the manifest is built from: the
 * composed `Capability.adminRoutes`. The CLI already resolves the Worker's composed set to find the
 * seam's mount point (`resolveTarget.ts`), so this needs no credential, no network call, and no
 * manifest — which matters, because reading the manifest requires the very grant being decided.
 *
 * The consequence worth stating: a capability that adds a read route is granted by default on the next
 * `connect`, with no change here and no coordination. That is the same property the manifest gives a
 * management client, applied to the grant.
 *
 * ## What counts as a read, and why the method decides it
 *
 * **A scope is a read scope only when every route that requires it is a `GET`.** Not "its name ends in
 * `:read`" — a name is a convention and this is an authorization decision. `scopeCovers` matches
 * exactly, with no prefix or wildcard rule, so holding a scope confers *every* route that requires it
 * anywhere in the composed tree; if one of those mutates, the scope is not a read however it is spelled.
 *
 * The seam's own `keys:rotate` is exactly that case and is the reason the rule is stated over routes
 * rather than over scopes: it gates `GET {base}/keys` **and** two `POST`s that register and expire keys.
 * A rule keyed on the listing route alone would have put a credential-lifecycle write into a read
 * default. It does not.
 */

/** One scope an adopter may grant, and what the composed Worker says holding it would allow. */
export interface GrantableScope {
  /** The scope, as a route requires it and as `--scope` names it. */
  scope: ControlPlaneScope;
  /** True when every declared route requiring this scope is a `GET`. */
  read: boolean;
  /** The capability that first declared it — what an adopter recognises the grant by. */
  capability: string;
  /** The first declared route's summary: one line on what holding it lets a client do. */
  summary: string;
  /** How many declared routes this scope opens. */
  routes: number;
}

/** Every admin route the composed set declares, in composition order, paired with its capability. */
function declaredRoutes(capabilities: readonly Capability[]): { capability: string; route: AdminRoute }[] {
  return capabilities.flatMap((capability) =>
    (capability.adminRoutes ?? []).map((route) => ({ capability: capability.name, route })),
  );
}

/**
 * Every scope the composed Worker's admin surface declares, in composition order, classified.
 *
 * A route with a null scope is skipped rather than reported: `ping` needs a verified caller and no
 * authorization, so granting it would change nothing and withholding it would change nothing. It is not
 * grantable, and offering it would be a lie about what a decision does.
 */
export function grantableScopes(capabilities: readonly Capability[]): GrantableScope[] {
  const found = new Map<string, GrantableScope>();
  for (const { capability, route } of declaredRoutes(capabilities)) {
    if (route.scope === null) continue;
    const existing = found.get(route.scope);
    if (existing) {
      // One non-GET anywhere in the tree settles it. The union is what a grant actually confers.
      found.set(route.scope, {
        ...existing,
        read: existing.read && route.method === "GET",
        routes: existing.routes + 1,
      });
      continue;
    }
    found.set(route.scope, {
      scope: route.scope,
      read: route.method === "GET",
      capability,
      summary: route.summary,
      routes: 1,
    });
  }
  return [...found.values()];
}

/**
 * The grant a `connect` makes when the operator named no `--scope`.
 *
 * **The seam's own scopes, plus every read the composed capabilities declare.** The seam's pair is the
 * base rather than a derivation because `keys:rotate` is not a read and would otherwise drop out — and
 * dropping it would break `pithy dashboard rotate` on every new connection, which is a working command
 * regressed to fix a different problem. It was already the default before this change; nothing here
 * widens a write. Everything this function *adds* to that base is provably read-only, and that is the
 * property `grant.test.ts` gates.
 *
 * An adopter who wants less says so: `--scope` narrows to exactly what is passed, and a narrowed grant
 * refuses every call it left out with `controlplane/insufficient_scope`. The scope that was missing is
 * in the refusal's `detail`, which the HTTP codec strips — so what names it to a client is the manifest,
 * where each route carries its own `scope` beside the connection's `grantedScopes`. That is the right
 * place for it: a client greys the operation out before trying, rather than learning from a 403.
 */
export function defaultGrant(capabilities: readonly Capability[]): ControlPlaneScope[] {
  const grant = [...SEAM_SCOPES];
  for (const grantable of grantableScopes(capabilities)) {
    if (grantable.read && !grant.includes(grantable.scope)) grant.push(grantable.scope);
  }
  return grant;
}
