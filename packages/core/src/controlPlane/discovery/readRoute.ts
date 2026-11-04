// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "../../error/pithyError";

/** The parts of an admin route the read rule judges. */
export interface ReadJudgedRoute {
  /** The method the route answers on. */
  readonly method: string;
  /** The kind its scope grants, when it declares one. */
  readonly kind?: string | undefined;
  /** True on a `POST` that reads and carries its input in a body. */
  readonly readInBody?: true | undefined;
}

/**
 * Whether an admin route reads and changes nothing: a `GET`, or a `POST` that declares both `kind: "reads"` and
 * `readInBody: true`, a read whose input must not be in a URL because a URL is written to every request log.
 *
 * The one rule for it. The default dashboard grant (`packages/cli/src/dashboard/grant.ts`) adds a scope only when
 * every route requiring it reads, and a presence room joins only with such a scope. Neither the kind alone nor
 * the path is enough: a write that copied its sibling's kind, or claims the marker under any other kind or
 * method, is a write.
 */
export function readsOnly(route: ReadJudgedRoute): boolean {
  if (route.method === "GET") return true;
  return route.method === "POST" && route.kind === "reads" && route.readInBody === true;
}

/**
 * Refuse a declaration that claims `readInBody` anywhere but on a `POST` declared `kind: "reads"`, where it is
 * written and naming the capability. The type already refuses it; this is for a capability written in
 * JavaScript, or a cast, because the manifest relays the marker to every management client.
 */
export function assertReadInBody(
  capability: string,
  adminRoutes: readonly (ReadJudgedRoute & { readonly path: string; readonly readInBody?: unknown })[],
): void {
  for (const route of adminRoutes) {
    if (route.readInBody === undefined) continue;
    if (route.method === "POST" && route.kind === "reads" && route.readInBody === true) continue;
    throw new InternalError({
      message: `${capability} declares an admin route as a read in a body that is not one.`,
      action: `Declare readInBody: true only on a POST with kind: "reads" in the ${capability} capability, or drop it.`,
      detail: `${route.method} ${route.path} declares readInBody ${JSON.stringify(route.readInBody)} with kind ${String(route.kind)}`,
    });
  }
}
