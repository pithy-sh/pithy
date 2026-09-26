// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { TurnstileClientProjection } from "./client/projection";
import { TURNSTILE_LOGIN_ACTION, TurnstileConfig, type TurnstileConfigInput } from "./config/config";
import { defaultSitekey } from "./provision/testKeys";
import { turnstileSecretsRegistry } from "./secret/registry";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";

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
    // The package this capability ships in and the version it ships at, both stamped by
    // `scripts/stampVersions.ts` — a Worker cannot read its own package.json. Reported per capability by
    // the control-plane manifest, and reported together: a release feed is keyed by package name, so the
    // version alone leaves a client guessing the key (#626).
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
    config: TurnstileConfig,
    // The widget secret is read through @pithy-sh/secrets, so the secrets capability must be composed;
    // createBackend fails fast if it isn't (rather than 500-ing each gated request).
    dependsOn: ["secrets"],
    // The slice of secrets turnstile reads — aggregated into the shared per-invocation accessor at startup.
    secretRegistry: turnstileSecretsRegistry,
    /**
     * The client-safe projection — exactly what renders the login widget: the mode `protect.login`
     * names, that widget's **public** sitekey for the environment being built, the **action** the widget
     * must solve for, and where the front end must put the response token so the middleware finds it.
     *
     * The widget *secret* is never here: it lives in the secrets store (`turnstileSecretsRegistry`) and
     * is read only inside the Worker, so a sitekey is the whole of what a browser sees — which is what
     * it is for. Every unrenderable shape projects `{ enabled: false }` (no `login` gate, the named
     * widget unconfigured, or no sitekey for this environment) so a screen branches instead of
     * mounting a widget that cannot solve.
     *
     * **A feature build is the one environment with a default** (#656): a branch's config is generated, so
     * an absent key there means "nobody could have stated one" rather than "not provisioned yet", and it
     * resolves the documented always-pass test key instead of rendering nothing and blocking sign-in.
     *
     * **`action` rides here because the boundary was already being crossed** (#377). The label is baked
     * into the token at render and asserted by the route, so it is one contract with two ends, and it
     * was written out at both — where nothing before production could catch them disagreeing. See
     * {@link TURNSTILE_LOGIN_ACTION} for why that is worse than it sounds and which gates hold it.
     *
     * The return type is {@link TurnstileClientProjection} — **declared, not inferred**. `ClientProjection`
     * is `{ enabled: boolean }` plus a JSON catchall, which accepts anything this closure could return.
     * The declared type is what makes a dropped field, and a `mode` widened by a third widget in
     * `TurnstileConfig`, a compile error here rather than a browser's problem.
     */
    client: ({ environment }): TurnstileClientProjection => {
      const mode = resolved.protect[TURNSTILE_LOGIN_ACTION];
      if (!mode) return { enabled: false };
      const widget = resolved.widgets[mode];
      if (!widget) return { enabled: false };
      // Indexed as a record: `environment` is any adopter name, not just the documented keys.
      const sitekeys: Record<string, string | undefined> = widget.sitekeys;
      // A feature build resolves Cloudflare's always-pass test key when the config states none, because a
      // branch's config is generated and nobody owns it — see `defaultSitekey` (#656). Every other
      // environment resolves what it states and nothing else, so `??`: a key stated blank still renders no
      // widget, deliberately, exactly as a blank dev or prod key does.
      const sitekey = sitekeys[environment] ?? defaultSitekey(environment, mode);
      if (!sitekey) return { enabled: false };
      return {
        enabled: true,
        mode,
        sitekey,
        // What the widget solves for, and what the route asserts. One statement, carried across.
        action: TURNSTILE_LOGIN_ACTION,
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
