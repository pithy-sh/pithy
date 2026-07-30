// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { validationHook } from "../../http/validation";
import type { AdminRoute } from "../discovery/adminRoute";
import { ANY_VERIFIED_CALLER, KEYS_ROTATE_SCOPE, MANIFEST_READ_SCOPE } from "../scope/scope";
import { requireControlPlane } from "./guard";
import {
  type ControlPlaneHandlerDeps,
  expireKeyHandler,
  listKeysHandler,
  manifestHandler,
  pingHandler,
  registerKeyHandler,
} from "./handlers";
import { ExpireKeyParams, ExpireKeyRequest, RegisterKeyRequest } from "./schemas";

/**
 * The seam's own routes, distinct from the admin routes capabilities contribute.
 *
 *   GET  /control-plane/ping                  → connectivity and key proof   (any verified caller)
 *   GET  /control-plane/manifest              → what this Worker composes    (manifest:read)
 *   GET  /control-plane/keys                  → the registration state       (keys:rotate)
 *   POST /control-plane/keys                  → register a key               (keys:rotate)
 *   POST /control-plane/keys/:keyId/expire    → retire a superseded key      (keys:rotate)
 *
 * Every one is `control-plane` and default-denied — with no connection registered they all answer 403,
 * and that is the shipped state of a Worker nobody has connected.
 *
 * **Guards precede validators on every line.** A validator first would turn a 401 into a 400 and tell a
 * caller with no credential which request shapes were well-formed. On these routes that is a live
 * oracle over key registration, which is the last thing that should be probeable.
 *
 * The three key routes share one scope. Reading which keys are live, registering the next one, and
 * retiring the last are one lifecycle, and an adopter deciding whether a management client may touch
 * their keys is making one decision, not three.
 *
 * The table is declared twice on purpose — once as descriptors a client can read, once as the
 * registrations themselves — and `routeContract.test.ts` proves the two agree.
 */

/**
 * The seam's own routes, described for `GET /control-plane/manifest`.
 *
 * Derived from the same `basePath` the routes below mount on, so the two cannot disagree — and the
 * seam holds itself to the rule it imposes on every capability: `controlPlaneRouteDescriptors` is
 * checked against the mounted router by `missingAdminRoutes` in `routeContract.test.ts`.
 *
 * `ping` carries a null scope. It requires a verified caller and no authorization, and saying so is
 * how a client knows it can always prove a key — including on a connection granted nothing at all.
 */
export function controlPlaneRouteDescriptors(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/ping`,
      scope: null,
      summary: "Prove connectivity and which key answered. Always available to a verified caller.",
    },
    {
      method: "GET",
      path: `${basePath}/manifest`,
      scope: MANIFEST_READ_SCOPE,
      summary: "What this Worker composes, and how to call each capability's admin surface.",
    },
    {
      method: "GET",
      path: `${basePath}/keys`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "The registered keys, their validity windows, and their ages.",
    },
    {
      method: "POST",
      path: `${basePath}/keys`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "Register a successor public key. Signed with the key it replaces; appends only.",
    },
    {
      method: "POST",
      path: `${basePath}/keys/:keyId/expire`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "Retire a superseded key. Must be signed with the successor it names as proven.",
    },
  ];
}

export function registerControlPlaneRoutes(
  app: Hono<PithyHonoEnv>,
  basePath: string,
  deps: ControlPlaneHandlerDeps,
): void {
  app.get(`${basePath}/ping`, requireControlPlane(ANY_VERIFIED_CALLER), pingHandler(deps));

  app.get(`${basePath}/manifest`, requireControlPlane(MANIFEST_READ_SCOPE), manifestHandler(deps));

  app.get(`${basePath}/keys`, requireControlPlane(KEYS_ROTATE_SCOPE), listKeysHandler(deps));

  app.post(
    `${basePath}/keys`,
    requireControlPlane(KEYS_ROTATE_SCOPE),
    zValidator("json", RegisterKeyRequest, validationHook),
    (c) => registerKeyHandler(deps)(c, c.req.valid("json")),
  );

  app.post(
    `${basePath}/keys/:keyId/expire`,
    requireControlPlane(KEYS_ROTATE_SCOPE),
    zValidator("param", ExpireKeyParams, validationHook),
    zValidator("json", ExpireKeyRequest, validationHook),
    (c) => expireKeyHandler(deps)(c, c.req.valid("param"), c.req.valid("json")),
  );
}
