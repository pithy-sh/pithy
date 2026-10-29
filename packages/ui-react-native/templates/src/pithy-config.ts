import type { AuthClientProjection } from "@pithy-sh/auth/src/client/projection";
import type { I18nClientProjection } from "@pithy-sh/i18n/src/client/projection";
import type { PaymentsClientProjection } from "@pithy-sh/payments/src/client/projection";
import type { PaymentsPlatformRails } from "@pithy-sh/payments/src/client/railChoice";
import type { TurnstileClientProjection } from "@pithy-sh/turnstile/src/client/projection";
import { AUTH_DISABLED, I18N_DISABLED, PAYMENTS_DISABLED, TURNSTILE_DISABLED } from "@pithy-sh/ui-core/src/config";
import { Platform } from "react-native";
import generated from "./pithy-config.generated";

/**
 * What `pithy-config.generated.ts` holds: the Worker this app calls, the composed capabilities' projections, and
 * the choices that are yours — the app's scheme, its universal-link origin, its Google client ids, and the rail
 * each platform sells through. `pithy ui sync` rewrites the projections and keeps your choices.
 */
export interface GeneratedPithyConfig {
  /**
   * Where the Worker answers in each environment. A build calls the one `EXPO_PUBLIC_PITHY_ENV` names, `dev` when it
   * is unset. `null` is an origin Pithy could not find; set it by hand. An environment the project does not deploy
   * to is absent.
   */
  readonly origins: {
    readonly dev: string;
    readonly staging?: string | null;
    readonly prod?: string | null;
  };
  /** The app's own URL scheme. A sign-in returns to a link on it. */
  readonly appScheme: string;
  /**
   * The https origin whose links open the app, or `null` for none. A checkout in the system browser returns here,
   * and so does a sign-in when it is set; with none, a sign-in returns on the app's scheme.
   */
  readonly universalLinkOrigin: string | null;
  /** The rail each platform sells through. */
  readonly rails: PaymentsPlatformRails;
  /** The Google OAuth client ids native Google sign-in needs. Null turns it off. */
  readonly google: { readonly webClientId: string | null; readonly iosClientId: string | null };
  readonly auth: AuthClientProjection;
  readonly i18n: I18nClientProjection;
  readonly payments: PaymentsClientProjection;
  readonly turnstile: TurnstileClientProjection;
}

const config: GeneratedPithyConfig = generated;

/**
 * The composed capabilities' client-safe config, narrowed once for the whole app.
 *
 * Each projection is a union on `enabled`: a capability the Worker does not compose projects `{ enabled: false }`
 * and nothing else. Narrowing here, once, to the projection or `@pithy-sh/ui-core`'s defaults lets a screen read a
 * field without a guard. The defaults keep the screens compiling when a capability is removed after the scaffold.
 */
export const authConfig = config.auth.enabled ? config.auth : AUTH_DISABLED;

/** Turnstile's projection, narrowed the same way. `enabled` is false unless a login widget resolved. */
export const turnstileConfig = config.turnstile.enabled ? config.turnstile : TURNSTILE_DISABLED;

/**
 * Payments' projection, narrowed the same way. Only the client-safe half of the catalog is here; every store
 * credential stays in the Worker's secrets store.
 */
export const paymentsConfig = config.payments.enabled ? config.payments : PAYMENTS_DISABLED;

/** The i18n projection, narrowed the same way. Locale metadata only; catalogs load per locale. */
export const i18nConfig = config.i18n.enabled ? config.i18n : I18N_DISABLED;

/** The i18n projection as the Worker composed it, for the hook that negotiates from it. */
export const i18nProjection: I18nClientProjection = config.i18n;

/** The environments a build can name. */
export type AppEnvironment = "dev" | "staging" | "prod";

/** Expo inlines `EXPO_PUBLIC_*` variables into the bundle when it builds, so this is read once, at build time. */
declare const process: { readonly env: { readonly EXPO_PUBLIC_PITHY_ENV?: string } };

/** The environment a build names in `EXPO_PUBLIC_PITHY_ENV`: `dev` when it names none. */
export function appEnvironment(named: string | undefined): AppEnvironment {
  if (named === undefined || named === "") return "dev";
  if (named === "dev" || named === "staging" || named === "prod") return named;
  throw new Error(`EXPO_PUBLIC_PITHY_ENV is "${named}". Build with dev, staging or prod.`);
}

/** A host that is this machine. */
const LOOPBACK = /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * The origin a build calls. An Android emulator is a machine of its own, and reaches this one's loopback at
 * `10.0.2.2`. A device on your network reaches neither: set `origins.dev` to this machine's network address.
 * The web build calls relative paths from the Worker's own origin, so it needs none: `""` when none is set.
 */
export function originFor(
  origins: GeneratedPithyConfig["origins"],
  environment: AppEnvironment,
  platform: string,
): string {
  const found = origins[environment];
  if (found === undefined || found === null) {
    if (platform === "web") return "";
    throw new Error(
      `No origin for ${environment}. Set origins.${environment} in src/pithy-config.generated.ts to the Worker's address there.`,
    );
  }
  // A phone sends its bearer credential to this origin, so a deployed one is https.
  if (platform !== "web" && environment !== "dev" && !found.startsWith("https://")) {
    throw new Error(
      `origins.${environment} is ${found}. Set it to the Worker's https address in src/pithy-config.generated.ts.`,
    );
  }
  if (platform !== "android") return found;
  return found.replace(LOOPBACK, (_match, scheme: string, _host: string, port = "") => `${scheme}10.0.2.2${port}`);
}

/** The environment this build calls. */
export const environment: AppEnvironment = appEnvironment(process.env.EXPO_PUBLIC_PITHY_ENV);

/** The Worker's absolute origin in that environment. Every request on a phone goes here. */
export const origin: string = originFor(config.origins, environment, Platform.OS);

/** The app's own URL scheme. */
export const appScheme: string = config.appScheme;

/** The https origin whose links open the app, or `null` when the app claims none. */
export const universalLinkOrigin: string | null = config.universalLinkOrigin;

/** The rail each platform sells through. */
export const platformRails: PaymentsPlatformRails = config.rails;

/** The Google OAuth client ids native Google sign-in needs. */
export const googleClientIds: GeneratedPithyConfig["google"] = config.google;
