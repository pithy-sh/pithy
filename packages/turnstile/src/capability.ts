// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { ClientProjection } from "@pithy-sh/core/src/capability/client";
import { TurnstileConfig, type TurnstileConfigInput } from "./config/config";
import { turnstileSecretsRegistry } from "./secret/registry";

/** The turnstile capability, with its resolved config attached for inspection (e.g. by `@pithy-sh/auth`). */
export interface TurnstileCapability extends Capability {
  turnstileConfig: TurnstileConfig;
}

/**
 * The turnstile capability. It is **stateless** — no tables, no migrations, no routes, no global
 * middleware, and **no bindings of its own**. Its widget secret is read through `@pithy-sh/secrets`
 * (CLAUDE.md §secrets) — whatever bindings that read needs are contributed by the `secrets` capability,
 * which this one depends on; turnstile contributes only its validated config. A humanity check stacks
 * per-route via the `turnstile()` middleware (`@pithy-sh/turnstile/src/http/middleware`), never as a
 * blanket middleware or an identity strategy.
 *
 * `@pithy-sh/auth` reads `turnstileConfig.protect` to decide which of its routes (magic-link, OTP) get a
 * gate and at which widget mode; this package never imports auth.
 */
export function turnstile(config: TurnstileConfigInput = {}): TurnstileCapability {
  const resolved = TurnstileConfig.parse(config);
  const capability = defineCapability({
    name: "turnstile",
    config: TurnstileConfig,
    // The widget secret is read through @pithy-sh/secrets, so the secrets capability must be composed;
    // createBackend fails fast if it isn't (rather than 500-ing each gated request).
    dependsOn: ["secrets"],
    // The slice of secrets turnstile reads — aggregated into the shared per-invocation accessor at startup.
    secretRegistry: turnstileSecretsRegistry,
    /**
     * The client-safe projection — exactly what renders the login widget: the mode `protect.login`
     * names, that widget's **public** sitekey for the environment being built, and where the front end
     * must put the response token so the middleware finds it.
     *
     * The widget *secret* is never here: it lives in the secrets store (`turnstileSecretsRegistry`) and
     * is read only inside the Worker, so a sitekey is the whole of what a browser sees — which is what
     * it is for. Every unrenderable shape projects `{ enabled: false }` (no `login` gate, the named
     * widget unconfigured, or no sitekey for this environment) so a screen branches instead of
     * mounting a widget that cannot solve.
     */
    client: ({ environment }): ClientProjection => {
      const mode = resolved.protect.login;
      if (!mode) return { enabled: false };
      const widget = resolved.widgets[mode];
      if (!widget) return { enabled: false };
      // Indexed as a record: `environment` is any adopter name, not just the three documented keys.
      const sitekeys: Record<string, string | undefined> = widget.sitekeys;
      const sitekey = sitekeys[environment];
      if (!sitekey) return { enabled: false };
      return {
        enabled: true,
        mode,
        sitekey,
        // Shaped like the config it comes from (`token.field` / `token.header`), so a screen reads the
        // same two names the middleware does. `header` is null rather than absent: `undefined` is not
        // JSON, and the projection is inlined into a bundle with JSON.stringify.
        token: { field: resolved.token.field, header: resolved.token.header ?? null },
      };
    },
    requiredBindings: [],
  });
  return Object.assign(capability, { turnstileConfig: resolved });
}

/** Whether a capability is the turnstile capability — carries its resolved config. */
export function isTurnstileCapability(capability: Capability): capability is TurnstileCapability {
  return capability.name === "turnstile" && "turnstileConfig" in capability;
}
