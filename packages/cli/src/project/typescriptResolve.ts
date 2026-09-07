// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Let an adopter's `pithy.config.ts` import their own modules the way TypeScript is written.
 *
 * ## What broke, and why nothing saw it
 *
 * `pithy.config.ts` is loaded with a plain dynamic `import()`. Until #481 the CLI ran on Bun, whose
 * resolver treats `./src/secret/registry` as `./src/secret/registry.ts` — so an adopter's config could
 * import their own code the way every TypeScript project does. The CLI runs on node now, which strips
 * types from the config itself and then refuses the extensionless specifier inside it:
 *
 * ```
 * Nothing resolves ".../apps/board/src/secret/registry"
 * ```
 *
 * Reported by `pithy-sh/dashboard` against published 0.1.4, bisected across 0.1.2 (works, Bun), 0.1.4
 * (fails, node) and a linked source checkout (works, Bun). Their config has eleven such imports, and
 * adding `.ts` to one only advances the failure to the next.
 *
 * **No gate saw it because a freshly scaffolded config has nothing local to import.** `pithy init`
 * writes a config that names capabilities and no modules of the adopter's own; those appear the moment
 * somebody writes code and wires it in. The same shape as #480 — correct on a project one command old,
 * broken on one with anything in it — and the fix in both cases is a fixture with a second file in it.
 *
 * ## Why a resolve hook rather than a loader
 *
 * The alternative is to transform the config with a bundler before importing it, which means shipping
 * one in the CLI. That is a large runtime dependency for a resolution question, and it runs against
 * #482, which is about the CLI importing *less* at startup. `node:module`'s `registerHooks` is in the
 * runtime already, synchronous, and in-thread.
 *
 * It only ever runs after node's own resolution has failed, so nothing that resolves today changes; it
 * is a fallback, not an override. And it is scoped to relative specifiers under `file:` — a bare
 * specifier is a package and belongs to node's resolver and the `exports` map, which is exactly the
 * mechanism #476 put in place.
 *
 * ## The version floor is already implied
 *
 * `registerHooks` landed in node 22.15, and unflagged type stripping in 22.18. A `.ts` config cannot be
 * imported at all below 22.18, so anywhere this is needed it is available — it adds no floor of its own,
 * which is why there is no version check here.
 */

/** The extensions TypeScript lets an author omit, in the order a TypeScript resolver tries them. */
const CANDIDATES = [".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"] as const;

/** Registered once per process — `registerHooks` is global, and a second registration is a second hop. */
let registered = false;

/**
 * Teach this process to resolve the TypeScript specifiers node does not, for relative imports only.
 *
 * Idempotent: called before every config load, and registers on the first.
 *
 * **`node:module` is imported dynamically, and the export is checked before it is used.** Bun does not
 * provide `registerHooks`, and a static import of a name a runtime does not export is a *parse-time*
 * failure — so writing it at the top of this file did not degrade under Bun, it stopped `pithy` from
 * starting at all there. `bin.test.ts` spawns the CLI under Bun and said so immediately:
 * `SyntaxError: Export named 'registerHooks' not found in module 'node:module'`.
 *
 * Its absence costs nothing. Bun's resolver already treats `./x` as `./x.ts`, which is the whole reason
 * this bug never appeared there and why the CLI needed none of this until it moved to node (#481). So
 * the runtime that needs the hook is exactly the runtime that has it, and a runtime with neither is one
 * where the config would not load for a different reason — which its own error should name, not this.
 */
export async function registerTypeScriptResolution(): Promise<void> {
  if (registered) return;
  registered = true;

  const { registerHooks } = await import("node:module");
  if (typeof registerHooks !== "function") return;

  registerHooks({
    resolve(specifier, context, next) {
      // A bare specifier is a package: node's resolver and the `exports` map own it, and a fallback
      // here would be guessing at somebody else's layout.
      if (!specifier.startsWith(".") || context.parentURL === undefined) return next(specifier, context);

      try {
        return next(specifier, context);
      } catch (cause) {
        // Only after node has genuinely failed. A specifier that resolves keeps resolving exactly as
        // it did, so this cannot change the meaning of a config that already loads.
        const base = new URL(specifier, context.parentURL);
        for (const extension of CANDIDATES) {
          const candidate = new URL(`${base.href}${extension}`);
          if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, format: "module-typescript", shortCircuit: true };
          }
        }
        throw cause;
      }
    },
  });
}
