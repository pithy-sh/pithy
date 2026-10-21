// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ConflictError, ValidationError } from "../error/pithyError";

/**
 * **A field declares its own privacy class, and the declaration drives everything downstream** (#132).
 *
 * One marker, several consumers — the shape `@pithy-sh/vector` already uses, where `.meta({ filterable: true
 * })` drives provisioning, the filter type, the drift check and the boot check. Here the marker drives the
 * type gate on the three internal surfaces (the logger, `AuditEvent.metadata`, `PithyError.detail`), the
 * masked view `redact` returns, the classification `classifyPrivacy` derives, and the inventory the control
 * plane reports.
 *
 * ## What a marker does, in one call
 *
 * `pii(schema)` does two things. It attaches `.meta({ privacy: "pii" })`, which is **introspectable** — that is
 * what `redact`, `classifyPrivacy` and the inventory read. And it applies Zod's `.brand()`, which changes the
 * **inferred type** — that is what makes a log call carrying the value fail to compile. The brand lands on the
 * field, not on the object, so extracting the field does not launder it: `user.email` is as branded as `user`.
 *
 * **The brand key is `privacy:<class>`, not the bare class name.** An adopter's own `.brand<"pii">()` for some
 * unrelated purpose must not trip a gate it never opted into, and an adopter's `UserId` brand must not either:
 * the gate reads a brand under the `privacy:` namespace and nothing else, which is the federated-key rule
 * (`auth/invalid_token`, `pithy_auth_users`) applied one more time.
 *
 * **Nothing at runtime changes.** Zod's `.brand()` returns the same schema object — the brand exists only in
 * the type — and `.meta()` returns a clone that parses exactly as its source. `Schema.parse(row)` returns the
 * same data it did before the marker, and no column is added anywhere.
 *
 * ## The set is open
 *
 * Four classes ship named — `secret`, `pii`, `phi`, `pci` — and {@link definePrivacyClass} registers more
 * (`genetic`, `biometric`, whatever a regulator names) without a change to core. A closed union is what #117
 * records the cost of, and a healthcare adopter should not have to wait on us.
 *
 * ## Where `secret` stops and `@pithy-sh/secrets` starts
 *
 * Two different facts, kept apart on purpose. `@pithy-sh/secrets` decides **where a credential the Worker reads
 * is stored** — its registry names a backend, and its reader redacts the value it hands back. `secret()` says
 * **what a field in a data shape is** — a receipt, a magic-link token, a session id, a key hash — values that
 * live in rows and payloads and that no secrets registry ever holds. Merging them would make core depend on a
 * capability (principle 4) and would make a storage decision answer a classification question.
 */

/** The `meta` key a marker writes and every reader reads. */
export const PRIVACY_META_KEY = "privacy";

/** The prefix of every privacy brand, so the gate never reads a brand that means something else. */
export const PRIVACY_BRAND_PREFIX = "privacy:";

/** A class name: a lowercase identifier. It becomes a brand key, a config value and a report column. */
export const PrivacyClassName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "A privacy class name is a lowercase identifier: letters, digits and underscores.")
  .describe(
    "A privacy class name — `secret`, `pii`, `phi`, `pci`, or one an adopter registered with `definePrivacyClass`. A lowercase identifier.",
  );
export type PrivacyClassName = z.output<typeof PrivacyClassName>;

/** The four classes the kit names, in the order every report lists them. */
export const BUILT_IN_PRIVACY_CLASSES = ["secret", "pii", "phi", "pci"] as const;

/** One of the four built-in class names. */
export type BuiltInPrivacyClass = (typeof BUILT_IN_PRIVACY_CLASSES)[number];

/** How a class masks a value: the string that stands in its place on every internal surface. */
export type PrivacyMask = (value: unknown) => string;

/** One registered class: its name, what it means, and how it masks. */
export interface PrivacyClass {
  /** The class name — the `meta` value and the brand's suffix. */
  readonly name: string;
  /** What the class means, in one sentence an auditor reads. */
  readonly description: string;
  /** The masked form of a value of this class. */
  readonly mask: PrivacyMask;
}

/**
 * The brand a marker puts on a schema's output type. Zod's own brand machinery, under the `privacy:` key.
 *
 * `"out"` on purpose: the **input** side stays unbranded, so `z.input` — the SQLite row shape, the Kysely
 * table type, a KV write's pre-parse value — is exactly what it was. A row read from D1 parses into the
 * branded app shape, and `Schema.encode()` hands Kysely the plain row back.
 */
export type Marked<S extends z.ZodType, C extends string> = z.core.$ZodBranded<
  S,
  `${typeof PRIVACY_BRAND_PREFIX}${C}`,
  "out"
>;

/** A marker for one class: wraps a schema and returns it marked. Carries its class name for a reader. */
export interface PrivacyMarker<C extends string> {
  <S extends z.ZodType>(schema: S): Marked<S, C>;
  /** The class this marker applies. */
  readonly className: C;
}

/** The placeholder every class but `pci` masks to: `[pii]`, `[phi]`, `[genetic]`. */
function placeholder(name: string): PrivacyMask {
  return () => `[${name}]`;
}

/** The shortest and longest primary account numbers ISO/IEC 7812 issues. */
const PAN_DIGITS = { min: 13, max: 19 } as const;

/**
 * Mask a primary account number to its first six and last four digits — `424242******4242`.
 *
 * **The one class whose mask is not a placeholder, because the masked form is the useful one.** First-six and
 * last-four is the display PCI-DSS permits, and it is what an operator reading a log needs to match a
 * complaint to a card without holding the card. Spaces and dashes are separators and are dropped; anything
 * that is not 13 to 19 digits once they are is not a card number, and masks to `[pci]` rather than to a
 * partial reveal of something else.
 *
 * Every payment rail Pithy ships is hosted, so no PAN ever reaches an adopter's Worker through the kit. The
 * class is here for the adopter's own schemas.
 */
export function maskPan(value: unknown): string {
  if (typeof value !== "string") return "[pci]";
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || digits.length < PAN_DIGITS.min || digits.length > PAN_DIGITS.max) return "[pci]";
  return `${digits.slice(0, 6)}${"*".repeat(digits.length - 10)}${digits.slice(-4)}`;
}

/** The built-ins, stated once. The descriptions are what `pithy privacy` and the inventory docs read. */
const BUILT_INS: Record<BuiltInPrivacyClass, PrivacyClass> = {
  secret: {
    name: "secret",
    description:
      "A credential or a bearer artifact — a session id, a magic-link token, a receipt, a key. The harm is impersonation, not exposure.",
    mask: placeholder("secret"),
  },
  pii: {
    name: "pii",
    description:
      "Personal data that identifies a person under GDPR or CCPA — an email address, a name, a phone number, a postal address.",
    mask: placeholder("pii"),
  },
  phi: {
    name: "phi",
    description:
      "Protected Health Information under HIPAA — a diagnosis, a treatment, a result, any health record tied to a person.",
    mask: placeholder("phi"),
  },
  pci: {
    name: "pci",
    description:
      "Cardholder data under PCI-DSS — a primary account number. Masks to its first six and last four digits.",
    mask: maskPan,
  },
};

/**
 * Every registered class, by name. Module state, deliberately: a class is declared once, at module load, the
 * way a capability's error codes are — and an isolate holds one registry, so a class registered by the
 * adopter's schema module is known to the logger, the inventory and `redact` in the same isolate.
 */
const registry = new Map<string, PrivacyClass>(Object.entries(BUILT_INS));

/** The class a name refers to, or `undefined` for a name nothing registered. */
export function privacyClass(name: string): PrivacyClass | undefined {
  return registry.get(name);
}

/** Every registered class, built-ins first in their fixed order, then each adopter class in registration order. */
export function privacyClasses(): PrivacyClass[] {
  return [...registry.values()];
}

/** The built-ins from the most harmful disclosure to the least: a credential, then health, then card, then identity. */
const STRENGTH: readonly BuiltInPrivacyClass[] = ["secret", "phi", "pci"];

/**
 * The strongest of `names`, the class a value is masked with when it carries several and is masked whole: `secret`,
 * then `phi`, then `pci`, then an adopter's class, then `pii`. An adopter registers a class because its data is more
 * specific than `pii`, so it ranks above it; adopter classes rank among themselves by name. `undefined` for none.
 */
export function strongestPrivacyClass(names: Iterable<string>): string | undefined {
  const all = [...new Set(names)];
  const builtIn = STRENGTH.find((name) => all.includes(name));
  if (builtIn) return builtIn;
  const adopter = all.filter((name) => name !== "pii").sort()[0];
  return adopter ?? (all.includes("pii") ? "pii" : undefined);
}

/** Mark a schema with a class: the introspectable `meta`, and the type-level brand. */
function marker<const C extends string>(name: C): PrivacyMarker<C> {
  const mark = <S extends z.ZodType>(schema: S): Marked<S, C> =>
    // `.meta()` clones and registers; the clone inherits its parent's metadata (the description included),
    // so `{ privacy }` lands beside whatever the schema already said about itself. `.brand()` returns the
    // same object — the brand is a type and nothing else.
    schema
      .meta({ ...(schema.meta() ?? {}), [PRIVACY_META_KEY]: name })
      .brand<`${typeof PRIVACY_BRAND_PREFIX}${C}`>() as Marked<S, C>;
  return Object.assign(mark, { className: name });
}

/** What {@link definePrivacyClass} takes. */
export interface PrivacyClassSpec<C extends string> {
  /** The class name: a lowercase identifier, unique across the isolate. */
  name: C;
  /** What the class means. Defaults to a sentence naming it as adopter-registered. */
  description?: string;
  /** How a value masks. Defaults to the `[name]` placeholder. */
  mask?: PrivacyMask;
}

/**
 * Register a class of the adopter's own — `genetic`, `biometric`, whatever their regulator names — and get its
 * marker back. Usable exactly like the built-ins: the same `meta`, the same brand, the same gate, the same
 * inventory row.
 *
 * **A duplicate is refused at registration**, a built-in name included. Two modules each believing they own
 * `genetic` would disagree about its mask, and the one that loaded second would win silently.
 */
export function definePrivacyClass<const C extends string>(spec: PrivacyClassSpec<C>): PrivacyMarker<C> {
  const parsed = PrivacyClassName.safeParse(spec.name);
  if (!parsed.success) {
    throw new ValidationError({
      message: `"${spec.name}" is not a privacy class name.`,
      action: "Name the class with a lowercase identifier — letters, digits and underscores, e.g. `genetic`.",
    });
  }
  if (registry.has(spec.name)) {
    throw new ConflictError({
      message: `The privacy class "${spec.name}" is already registered.`,
      action: `Register "${spec.name}" once, in one module, and import its marker everywhere else.`,
    });
  }
  registry.set(spec.name, {
    name: spec.name,
    description: spec.description ?? `An adopter-registered privacy class, "${spec.name}".`,
    mask: spec.mask ?? placeholder(spec.name),
  });
  return marker(spec.name);
}

/** Mark a field as a credential or bearer artifact. See {@link BUILT_INS}. */
export const secret: PrivacyMarker<"secret"> = marker("secret");

/** Mark a field as personal data under GDPR or CCPA. */
export const pii: PrivacyMarker<"pii"> = marker("pii");

/** Mark a field as Protected Health Information under HIPAA. */
export const phi: PrivacyMarker<"phi"> = marker("phi");

/** Mark a field as cardholder data under PCI-DSS. Masks to first six and last four. */
export const pci: PrivacyMarker<"pci"> = marker("pci");
