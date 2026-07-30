import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { validationHook } from "../../http/validation";
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
 */
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
