// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PreconditionFailedError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { PlatformRails, RailChoice } from "@pithy-sh/ui-react-native/src/generatedConfig";
import { capabilityNotComposed } from "../capabilities/notComposed";
import { allCapabilities, type WorkerConfig } from "../project/config";

/**
 * The rail each platform of a React Native app sells through: `apple` on iOS, `google` on Android, a hosted
 * rail on the web, or `none` for a build that shows plans and sells nothing.
 *
 * The rail is the app's choice and the backend's permission. A flag or a prompt picks it, and a rail the
 * backend Worker does not enable is refused by name, before anything is written.
 */

/** The three platforms one Expo project builds. */
export const RAIL_PLATFORMS = ["ios", "android", "web"] as const;

/** One of {@link RAIL_PLATFORMS}. */
export type RailPlatform = (typeof RAIL_PLATFORMS)[number];

/** The rails that sell through a hosted checkout, in the order the web default is picked from. */
const HOSTED_RAILS = ["stripe", "lemonSqueezy", "paddle"] as const;

/** The store each platform runs, or `null` for the web, which runs none. */
const PLATFORM_STORE: Record<RailPlatform, "apple" | "google" | null> = { ios: "apple", android: "google", web: null };

/** Every rail one platform accepts: its own store, any hosted rail, or `none`. */
export function railsFor(platform: RailPlatform): RailChoice[] {
  const store = PLATFORM_STORE[platform];
  return [...(store === null ? [] : [store]), ...HOSTED_RAILS, "none"];
}

/** The flag that sets one platform's rail. */
export function railFlag(platform: RailPlatform): string {
  return `--${platform}-rail`;
}

/** `rails`, as a sentence's list: `a, b or c`. */
function spoken(rails: readonly string[]): string {
  return rails.length < 2 ? rails.join("") : `${rails.slice(0, -1).join(", ")} or ${rails.at(-1)}`;
}

/** Parse one platform's rail flag, refusing a value that platform cannot sell through and naming the ones it can. */
export function parseRail(platform: RailPlatform, raw: string): RailChoice {
  const valid = railsFor(platform);
  const found = valid.find((rail) => rail === raw);
  if (found !== undefined) return found;
  throw new ValidationError({
    message: `"${raw}" is not a rail ${platform} can sell through.`,
    action: `Pass ${railFlag(platform)} ${spoken(valid)}.`,
  });
}

/** What the backend Worker allows: whether it composes payments, and which rails its config turns on. */
export interface BackendRails {
  /** Whether the Worker composes the payments capability at all. */
  composed: boolean;
  /** Each rail the Worker's payments config enables. Every rail is off until named. */
  enabled: Record<Exclude<RailChoice, "none">, boolean>;
}

/** The slice of a payments capability this reads. Structural, so the CLI imports nothing of the package. */
interface PaymentsRailSlice {
  paymentsConfig?: { rails?: Partial<Record<string, boolean>> };
}

/** Which rails a Worker's composed payments config enables. */
export function backendRails(config: WorkerConfig): BackendRails {
  const payments = allCapabilities(config).find((capability) => capability.name === "payments") as
    | PaymentsRailSlice
    | undefined;
  const rails = payments?.paymentsConfig?.rails ?? {};
  return {
    composed: payments !== undefined,
    enabled: {
      apple: rails.apple === true,
      google: rails.google === true,
      stripe: rails.stripe === true,
      lemonSqueezy: rails.lemonSqueezy === true,
      paddle: rails.paddle === true,
    },
  };
}

/** Whether the backend enables `rail`. `none` needs nothing enabled. */
function allowed(backend: BackendRails, rail: RailChoice): boolean {
  return rail === "none" || backend.enabled[rail];
}

/**
 * The rail a platform gets when nobody chose one: its store on iOS and Android, the backend's first hosted
 * rail on the web, and `none` wherever the backend enables no such rail, so a default is never a rail the
 * backend would refuse.
 */
export function defaultRail(platform: RailPlatform, backend: BackendRails): RailChoice {
  const store = PLATFORM_STORE[platform];
  if (store !== null) return backend.enabled[store] ? store : "none";
  return HOSTED_RAILS.find((rail) => backend.enabled[rail]) ?? "none";
}

/** Ask which rail one platform sells through. Attached only when a human can answer. */
export type UiRailPrompt = (request: {
  platform: RailPlatform;
  choices: RailChoice[];
  suggestion: RailChoice;
}) => Promise<RailChoice>;

/** Where a refusal points: the project, and the backend Worker whose config would have to change. */
export interface RailScope {
  projectDir: string;
  workerDir: string;
  /** The backend Worker's `apps/` directory name. */
  worker: string;
}

/** Refuse a rail the backend does not enable, naming the rail and the config key that turns it on. */
function requireEnabled(platform: RailPlatform, rail: RailChoice, backend: BackendRails, scope: RailScope): RailChoice {
  if (allowed(backend, rail)) return rail;
  if (!backend.composed) {
    throw capabilityNotComposed(
      "payments",
      {
        message: `The ${rail} rail needs the payments capability, and ${scope.worker} doesn't compose it.`,
        action: (add) => `Run ${add} and enable rails.${rail}, or pass ${railFlag(platform)} none.`,
      },
      { projectDir: scope.projectDir, workerDir: scope.workerDir },
    );
  }
  throw new PreconditionFailedError({
    message: `The ${rail} rail isn't enabled in ${scope.worker}'s payments config.`,
    action: `Enable rails.${rail} in apps/${scope.worker}/pithy.config.ts, or pass ${railFlag(platform)} none.`,
  });
}

/**
 * The rail every platform sells through. A flag decides outright; without one a kept rail stays, a human is
 * asked, offered only the rails the backend enables, and anyone else gets {@link defaultRail}. A rail the
 * backend does not enable is refused by name.
 */
export async function resolveRails(options: {
  /** The raw flag values, keyed by platform. Undefined means "decide". */
  flags: Partial<Record<RailPlatform, string>>;
  backend: BackendRails;
  scope: RailScope;
  /** Asks a human. Supplied only when one is attached, and only asked when the backend composes payments. */
  prompt?: UiRailPrompt;
  /**
   * The rails already written. An unflagged platform keeps its rail rather than being asked or defaulted, and
   * the kept rail is held to the backend like a flagged one.
   */
  kept?: PlatformRails;
}): Promise<PlatformRails> {
  // Every flag is parsed before any prompt, so a typo costs no answers.
  const flagged: Partial<Record<RailPlatform, RailChoice>> = {};
  for (const platform of RAIL_PLATFORMS) {
    const raw = options.flags[platform];
    if (raw !== undefined) flagged[platform] = parseRail(platform, raw);
  }
  const rails: Partial<Record<RailPlatform, RailChoice>> = {};
  for (const platform of RAIL_PLATFORMS) {
    const chosen = flagged[platform];
    if (chosen !== undefined) {
      rails[platform] = requireEnabled(platform, chosen, options.backend, options.scope);
      continue;
    }
    const kept = options.kept?.[platform];
    if (kept !== undefined) {
      const valid = railsFor(platform);
      if (!valid.includes(kept)) {
        throw new ValidationError({
          message: `rails.${platform} is "${kept}", which is not a rail ${platform} can sell through.`,
          action: `Set it to ${spoken(valid)}, or pass ${railFlag(platform)} with one of them.`,
        });
      }
      rails[platform] = requireEnabled(platform, kept, options.backend, options.scope);
      continue;
    }
    const suggestion = defaultRail(platform, options.backend);
    if (options.prompt === undefined || !options.backend.composed) {
      rails[platform] = suggestion;
      continue;
    }
    const choices = railsFor(platform).filter((rail) => allowed(options.backend, rail));
    const answer = await options.prompt({ platform, choices, suggestion });
    rails[platform] = requireEnabled(platform, answer, options.backend, options.scope);
  }
  return { ios: rails.ios ?? "none", android: rails.android ?? "none", web: rails.web ?? "none" };
}
