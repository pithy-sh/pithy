// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { sha256Base64Url, timingSafeEqual } from "@pithy-sh/core/src/controlPlane/token/digest";
import { parseCompactJws, verifyEd25519 } from "@pithy-sh/core/src/controlPlane/token/jws";

/**
 * The other three errors #315 reported, kept where they can be reproduced.
 *
 * `client.ts` does not cover these, and finding that out is the reason this file exists. Once the
 * scope constants moved into their own modules, the browser program stopped reaching
 * `capability.ts`, `digest.ts` and `jws.ts` **at all** — so reverting either core fix left the scope
 * gate green. A gate that passes whether or not the thing it is supposed to prove is true is worth
 * less than no gate, because it is read as proof.
 *
 * So the token primitives get their own DOM-only program. `tsconfig.probe.json` compiles it with the
 * DOM lib and `types: []`, which is where the stricter `BufferSource` lives —
 * `ArrayBufferView<ArrayBuffer> | ArrayBuffer`, admitting no view onto a `SharedArrayBuffer`.
 * `@cloudflare/workers-types` spells it loosely enough that a Worker program never saw the mismatch;
 * this program does, exactly as the adopter's did.
 *
 * `capability.ts` is here for the first two errors, which are a different fault with the same cause:
 * it named `ForwardableEmailMessage` and `ExecutionContext` off the global scope, so the names
 * resolved only for a consumer that had already loaded the Workers types. Importing them by name is
 * what makes the dependency real, and `@pithy-sh/core` declaring `@cloudflare/workers-types` as a
 * dependency rather than a devDependency is what makes it satisfiable.
 *
 * **Verified by planting, all four.** Dropping the defensive copy in `sha256Base64Url` reproduces
 * `digest.ts: error TS2345 … not assignable to parameter of type 'BufferSource'`; dropping the one in
 * `verifyEd25519` reproduces the same at `jws.ts`; removing the import below reproduces
 * `capability.ts: error TS2304: Cannot find name 'ForwardableEmailMessage'` and the same for
 * `ExecutionContext`. Those are the four errors the issue quotes, in the order it quotes them.
 *
 * Nothing here is a browser's business to call — a private key is not in a browser and neither is a
 * token to verify. Compiling them is the point, not calling them.
 */
export type CapabilityProbe = [Capability, PithyHonoEnv];
export const probe = [sha256Base64Url, timingSafeEqual, parseCompactJws, verifyEd25519];
