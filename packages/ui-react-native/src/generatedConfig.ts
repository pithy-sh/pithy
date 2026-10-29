// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The config an Expo app reads its Worker from: `src/pithy-config.generated.ts`.
 *
 * A Vite app reads the composed capabilities' projections from `virtual:pithy/*` modules at build time. Metro
 * cannot resolve a virtual module, so `pithy ui add react-native` writes the same projections into a file, and
 * `pithy ui sync` rewrites it from the Worker's composed config. A few fields are the adopter's choice rather than
 * the Worker's — which rail each platform sells through, the app's scheme, its universal-link origin, its Google
 * client ids — and a sync keeps those as they were edited ({@link keepAdopterChoices}).
 *
 * The Worker answers on one origin per environment, so the file carries each one, and the app picks one when it is
 * built: {@link ENVIRONMENT_VARIABLE} names the environment, and Expo inlines it into the bundle.
 *
 * This module owns the file's format: {@link renderGeneratedConfig} writes it and {@link readGeneratedConfig} reads
 * it back, so the scaffold, the sync and the template in this package are one shape. Node only; the CLI imports it.
 */

/** Where the file sits in the app, relative to the app's directory. */
export const GENERATED_CONFIG_PATH = "src/pithy-config.generated.ts";

/** An absolute http(s) origin: a scheme and a host, no path and no trailing slash. */
const ORIGIN = /^https?:\/\/[^/?#@\s]+$/;

/**
 * The variable an app build reads its environment from: `dev`, `staging` or `prod`, `dev` when unset. Expo inlines
 * every `EXPO_PUBLIC_*` variable into the bundle at build time, so a store build made with it set to `prod` calls
 * the production origin and nothing else.
 */
export const ENVIRONMENT_VARIABLE = "EXPO_PUBLIC_PITHY_ENV";

/** The environments an app build can name, `dev` first. */
export const APP_ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

/** Where the Worker answers in each environment. */
export const Origins = z
  .object({
    dev: z
      .string()
      .regex(ORIGIN)
      .describe(
        "The Worker's local origin under `pithy dev`, such as `http://localhost:8787`. On Android a loopback origin is reached through the emulator's `10.0.2.2`. Set your machine's network address here for a device.",
      ),
    staging: z
      .string()
      .regex(ORIGIN)
      .nullable()
      .optional()
      .describe(
        "The Worker's staging origin. Null when Pithy could not find one: set it by hand. Absent when the project does not deploy to staging.",
      ),
    prod: z
      .string()
      .regex(ORIGIN)
      .nullable()
      .optional()
      .describe(
        "The Worker's production origin. Null when Pithy could not find one: set it by hand. Absent when the project does not deploy to prod.",
      ),
  })
  .describe(
    `Where the Worker answers in each environment. A build calls the one \`${ENVIRONMENT_VARIABLE}\` names, \`dev\` when it is unset.`,
  );
export type Origins = z.infer<typeof Origins>;

/** A rail one platform sells through, or `none` for a build that shows plans and sells nothing. */
export const RailChoice = z
  .enum(["apple", "google", "stripe", "lemonSqueezy", "paddle", "none"])
  .describe("A rail one platform sells through, or `none` for a build that shows plans and sells nothing.");
export type RailChoice = z.infer<typeof RailChoice>;

/** The rail each platform sells through. */
export const PlatformRails = z
  .object({
    ios: RailChoice.describe("The rail the iOS app sells through. `apple` by default: StoreKit."),
    android: RailChoice.describe("The rail the Android app sells through. `google` by default: Play Billing."),
    web: RailChoice.describe("The rail the web build sells through. The project's web rail by default."),
  })
  .describe(
    "The rail each platform sells through. A web rail on a phone opens checkout in the system browser and returns through the universal link.",
  );
export type PlatformRails = z.infer<typeof PlatformRails>;

/** The Google OAuth client ids native Google sign-in needs. Public values; never a secret. */
export const GoogleClientIds = z
  .object({
    webClientId: z
      .string()
      .nullable()
      .describe(
        "The web client id. Native Google sign-in asks for its id token with this audience, the one the Worker checks. Null turns native Google sign-in off.",
      ),
    iosClientId: z
      .string()
      .nullable()
      .describe("The iOS client id. iOS needs it, and its reversed form as a URL scheme. Null on an Android-only app."),
  })
  .describe("The Google OAuth client ids native Google sign-in needs. Public values, never a secret.");
export type GoogleClientIds = z.infer<typeof GoogleClientIds>;

/** One capability's client projection, as the Worker composed it: every field kept, `enabled` checked. */
const Projection = (capability: string, environment: AppEnvironment) =>
  z
    .looseObject({
      enabled: z.boolean().describe(`Whether ${capability} is composed into the Worker the app calls.`),
    })
    .describe(
      `${capability}'s client projection for ${environment}, exactly as the Worker composes it: the same value a Vite app built for ${environment} reads from \`virtual:pithy/${capability}\`.`,
    );

/**
 * One capability's client projection in each environment, keyed like {@link Origins}: a sitekey or a catalog can
 * differ between environments, so a build reads the one for the environment it names.
 */
const Projections = (capability: string) =>
  z
    .object({
      dev: Projection(capability, "dev"),
      staging: Projection(capability, "staging")
        .optional()
        .describe(`${capability}'s projection for staging. Absent when the project does not deploy to staging.`),
      prod: Projection(capability, "prod")
        .optional()
        .describe(`${capability}'s projection for prod. Absent when the project does not deploy to prod.`),
    })
    .describe(
      `${capability}'s client projection in each environment. A build reads the one \`${ENVIRONMENT_VARIABLE}\` names, \`dev\` when it is unset.`,
    );

/** The whole file. */
export const GeneratedConfig = z
  .object({
    origins: Origins,
    appScheme: z
      .string()
      .regex(/^[a-z][a-z0-9+.-]*$/)
      .describe(
        "The app's own URL scheme, such as `myapp`. A sign-in returns to a link on it, so `trustedOrigins` names it.",
      ),
    universalLinkOrigin: z
      .string()
      .regex(ORIGIN)
      .refine((origin) => origin.startsWith("https://"), "A universal link is https.")
      .nullable()
      .describe(
        "The https origin whose links open the app, or null for none. A checkout in the system browser returns here, since a store will not return to a custom scheme, and so does a sign-in when it is set.",
      ),
    rails: PlatformRails,
    google: GoogleClientIds,
    workerPaths: z
      .array(z.string().regex(/^\/[^/?#\s]+$/))
      .optional()
      .describe(
        "Every base path the Worker's route table answers under, such as `/auth` or `/organizations`, as Pithy composed it. Under `pithy dev` the web build's proxy sends these to the Worker. Absent when Pithy has not listed them: the proxy then takes the kit's default paths.",
      ),
    auth: Projections("auth"),
    i18n: Projections("i18n"),
    payments: Projections("payments"),
    turnstile: Projections("turnstile"),
    consent: Projections("consent"),
  })
  .describe("The config an Expo app reads its Worker from, written by `pithy ui add react-native`.");
export type GeneratedConfig = z.infer<typeof GeneratedConfig>;

/**
 * The fields a sync keeps as the adopter left them. `origins` is shared: {@link keepAdopterChoices} keeps the ones
 * the adopter set, and everything else is the Worker's, and a sync rewrites it.
 */
export const ADOPTER_CHOICES = [
  "appScheme",
  "universalLinkOrigin",
  "rails",
  "google",
] as const satisfies readonly (keyof GeneratedConfig)[];

/** The line the value starts on, and the line after it. The format is these two lines and an object literal between. */
const OPEN = "const config: GeneratedPithyConfig = ";
const CLOSE = ";\n\nexport default config;\n";

/** The width the scaffolded `biome.jsonc` formats at. */
const LINE_WIDTH = 120;

/** A key Biome prints without quotes: an identifier. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * `value` as an object literal, printed the way the scaffolded Biome prints one: a key in quotes only when it needs
 * them, every object one entry per line, an array on one line when it fits and holds no object, and a trailing comma
 * after the last entry of anything broken across lines. So the file Pithy writes is one `biome check` passes as it is.
 */
function printLiteral(value: unknown, indent: string, prefix: number): string {
  if (typeof value === "string") return printString(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const flat = value.every((item) => item === null || typeof item !== "object" || isEmpty(item));
    if (flat) {
      const line = `[${value.map((item) => printLiteral(item, inner, 0)).join(", ")}]`;
      // The closing `,` or `;` after the array counts toward the width too.
      if (prefix + line.length + 1 <= LINE_WIDTH) return line;
    }
    const items = value.map((item) => `${inner}${printLiteral(item, inner, inner.length)},`);
    return `[\n${items.join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([key, entry]) => {
    const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
    return `${inner}${name}: ${printLiteral(entry, inner, inner.length + name.length + 2)},`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/** A string in double quotes, or in single quotes when it holds more double quotes than single, as Biome picks. */
function printString(value: string): string {
  const doubles = value.split('"').length;
  const singles = value.split("'").length;
  if (doubles <= singles) return JSON.stringify(value);
  let body = "";
  for (const char of value) {
    body += char === "'" ? "\\'" : char === '"' ? char : JSON.stringify(char).slice(1, -1);
  }
  return `'${body}'`;
}

function isEmpty(value: object): boolean {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

/**
 * The file's text for `config`, naming the Worker it came from. The value is a plain literal, so it reads back
 * without evaluating anything; the comment above it says which fields are the adopter's and how to change each rail.
 */
export function renderGeneratedConfig(config: GeneratedConfig, worker: string): string {
  return [
    `// Written from apps/${worker}'s composed config. Pithy's \`ui sync --app\` rewrites it when that config`,
    "// changes, and keeps the fields below that are yours.",
    "//",
    "// Yours to edit, and kept by a sync: `appScheme`, `universalLinkOrigin`, `google` and `rails`.",
    "//",
    '// `rails.ios`, `rails.android` and `rails.web` name the rail each platform sells through: "apple", "google",',
    '// "stripe", "lemonSqueezy", "paddle", or "none" to show plans and sell nothing. Change one here, or pass',
    "// `--ios-rail`, `--android-rail` or `--web-rail` to `ui sync --app`. A rail the Worker does not enable is",
    "// refused. A web rail on a phone opens checkout in the system browser.",
    "//",
    "// `origins` holds where the Worker answers in each environment, and a build calls the one",
    `// \`${ENVIRONMENT_VARIABLE}\` names: dev, staging or prod, dev when it is unset. An origin is null when Pithy`,
    "// could not find it: a Worker that answers only on workers.dev, or one that declares no domain. Set",
    "// `origins.staging` or `origins.prod` by hand then, and a sync keeps it until the Worker declares one.",
    "// A dev origin that is not this machine's loopback, such as your network address for a device, is kept too.",
    "//",
    "// `auth`, `i18n`, `payments`, `turnstile` and `consent` hold each capability's projection in each environment",
    "// `origins` names, and a build reads the one for its environment: a sitekey or a catalog can differ between them.",
    "//",
    "// Everything else is the Worker's. Change its pithy.config.ts and run `ui sync --app` again.",
    "// The value stays a plain literal: strings, numbers, true, false, null, arrays and objects. A sync reads it",
    "// back without running it, so it holds no expression, no variable and no import.",
    'import type { GeneratedPithyConfig } from "./pithy-config";',
    "",
    `${OPEN}${printLiteral(config, "", OPEN.length)}${CLOSE}`,
  ].join("\n");
}

/** A literal the reader could not read. */
class Unreadable extends Error {}

/**
 * Read the object literal in `text`: JSON, plus what a formatter or a hand edit leaves in a TypeScript literal, which
 * is a key without quotes, a single-quoted string, a trailing comma and a comment. Anything else, such as an
 * expression, is unreadable: the file is read, never run.
 */
function parseLiteral(text: string): unknown {
  let at = 0;
  const skip = (): void => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at] ?? "")) at += 1;
      if (text.startsWith("//", at)) {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : end + 1;
      } else if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) throw new Unreadable();
        at = end + 2;
      } else return;
    }
  };
  const consume = (char: string): void => {
    skip();
    if (text[at] !== char) throw new Unreadable();
    at += 1;
  };
  const string = (): string => {
    const quote = text[at];
    let end = at + 1;
    let raw = "";
    while (end < text.length && text[end] !== quote) {
      const char = text[end] ?? "";
      if (char === "\n") throw new Unreadable();
      if (char === "\\") {
        const next = text[end + 1] ?? "";
        // A single-quoted string may escape its quote; JSON has no `\'`.
        raw += next === "'" ? "'" : char + next;
        end += 2;
        continue;
      }
      raw += char === '"' ? '\\"' : char;
      end += 1;
    }
    if (end >= text.length) throw new Unreadable();
    at = end + 1;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      throw new Unreadable();
    }
  };
  const value = (): unknown => {
    skip();
    const char = text[at];
    if (char === "{") {
      at += 1;
      const object: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (text[at] === "}") {
          at += 1;
          return object;
        }
        let key: string;
        if (text[at] === '"' || text[at] === "'") key = string();
        else {
          const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(at))?.[0];
          if (name === undefined) throw new Unreadable();
          key = name;
          at += name.length;
        }
        consume(":");
        Object.defineProperty(object, key, { value: value(), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[at] === ",") at += 1;
        else if (text[at] !== "}") throw new Unreadable();
      }
    }
    if (char === "[") {
      at += 1;
      const array: unknown[] = [];
      for (;;) {
        skip();
        if (text[at] === "]") {
          at += 1;
          return array;
        }
        array.push(value());
        skip();
        if (text[at] === ",") at += 1;
        else if (text[at] !== "]") throw new Unreadable();
      }
    }
    if (char === '"' || char === "'") return string();
    const word = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![A-Za-z0-9_$.])/.exec(
      text.slice(at),
    )?.[0];
    if (word === undefined) throw new Unreadable();
    at += word.length;
    return JSON.parse(word) as unknown;
  };
  const parsed = value();
  skip();
  if (at !== text.length) throw new Unreadable();
  return parsed;
}

/**
 * The config a file holds, or `null` when it is not a file {@link renderGeneratedConfig} wrote or its value does not
 * parse. A file the project's formatter has reformatted, or an adopter has edited by hand, still reads.
 */
export function readGeneratedConfig(text: string): GeneratedConfig | null {
  const start = text.indexOf(OPEN);
  const close = /;\s*export default config;\s*$/.exec(text);
  if (start === -1 || close === null || close.index < start) return null;
  let value: unknown;
  try {
    value = parseLiteral(text.slice(start + OPEN.length, close.index));
  } catch {
    return null;
  }
  const parsed = GeneratedConfig.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A host that is this machine: what `pithy dev` writes, and what a sync may move to another port. */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * The origins a sync writes. A deployed environment is the Worker's when the Worker names one, and otherwise the
 * adopter's, as long as the project still deploys there. A loopback dev origin follows the port `pithy dev` pins,
 * and any other dev origin is one the adopter set, for a device on the network, and is kept.
 */
function keepOrigins(previous: Origins, next: Origins): Origins {
  const kept: Origins = { dev: LOOPBACK.test(previous.dev) ? next.dev : previous.dev };
  for (const environment of ["staging", "prod"] as const) {
    if (!(environment in next)) continue;
    kept[environment] = next[environment] ?? previous[environment] ?? null;
  }
  return kept;
}

/** `next`, with the adopter's choices carried over from what was written before. */
export function keepAdopterChoices(previous: GeneratedConfig | null, next: GeneratedConfig): GeneratedConfig {
  if (previous === null) return next;
  const kept: GeneratedConfig = { ...next, origins: keepOrigins(previous.origins, next.origins) };
  for (const key of ADOPTER_CHOICES) Object.assign(kept, { [key]: previous[key] });
  return kept;
}
