import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
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
    requiredBindings: [],
  });
  return Object.assign(capability, { turnstileConfig: resolved });
}

/** Whether a capability is the turnstile capability — carries its resolved config. */
export function isTurnstileCapability(capability: Capability): capability is TurnstileCapability {
  return capability.name === "turnstile" && "turnstileConfig" in capability;
}
