// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The Worker binding a `cf-secrets-store` secret is read through: its registry key, in
 * SCREAMING_SNAKE_CASE (#603).** `email-link-signing-key` binds as `EMAIL_LINK_SIGNING_KEY`;
 * `CLOUDFLARE_API_TOKEN` binds as itself.
 *
 * A binding is an environment name, and environment names are capitals: `DB`, `SECRETS`,
 * `SECRETS_ENCRYPTION_KEYS`. For as long as every store-backed secret happened to be declared in capitals,
 * the kit read and wrote the registry key verbatim, and nobody could see that the key and the binding were
 * two things. #596 moved `email-link-signing-key` — kebab-case, like every capability secret — into the
 * store, and `pithy secrets provision` wrote `"binding": "email-link-signing-key"` into every adopter's
 * `wrangler.jsonc`.
 *
 * **One function, every side of the name.** The stanza writer, doctor's stanza check, the runtime reader,
 * `.dev.vars` generation and a prebuilt host's env schema all call this. A writer and a reader that each
 * spelled the binding would agree only for as long as both happened to pick the same spelling — which is
 * exactly the state the kit was in, and why the defect was invisible.
 * `cli/src/capabilities/secretBackends.test.ts` holds the committed templates to the shape.
 *
 * **The Secrets Store entry name is not this.** An entry is `<project>-<env>-<key>`, composed from the
 * registry key by `secretEntry`, and it does not change.
 *
 * The rule: a key already in the shape is its own binding. Otherwise a lowercase letter or digit followed
 * by a capital gains an underscore between them, every character that is not a letter or a digit becomes an
 * underscore, and the whole is uppercased. So it is idempotent, and `R2ACCESS_KEY` is not split. A key
 * whose binding cannot be bound — one that starts with a digit — is refused where the registry is defined,
 * by {@link isBindingName}.
 *
 * A leaf: nothing here may import anything, for the reason `masterKeyBinding.ts` gives — `registry.ts`
 * needs it, and a browser-validated admin schema reaches `registry.ts`.
 */
export function secretBindingName<const K extends string>(key: K): SecretBindingName<K> {
  if (isBindingName(key)) return key as SecretBindingName<K>;
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]/g, "_")
    .toUpperCase() as SecretBindingName<K>;
}

/** Each character of a string literal, as a union. */
type Characters<S extends string> = S extends `${infer C}${infer Rest}` ? C | Characters<Rest> : never;
type Letter = Characters<"abcdefghijklmnopqrstuvwxyz">;
type Alphanumeric = Letter | Uppercase<Letter> | Characters<"0123456789">;

/** Every character that is not a letter or a digit, as an underscore. */
type Underscored<K extends string> = K extends `${infer C}${infer Rest}`
  ? `${C extends Alphanumeric ? C : "_"}${Underscored<Rest>}`
  : "";

/**
 * {@link secretBindingName}'s answer, as a type — so a prebuilt host's env schema can key a binding by the
 * derived name and still know which name it is, rather than spelling `EMAIL_LINK_SIGNING_KEY` by hand.
 *
 * Exact for a key in one case, which is every key the kit declares: no camelCase boundary can appear, so
 * the answer is the key underscored and uppercased. A mixed-case key has boundaries a type cannot find
 * cheaply, and is typed `string` rather than typed wrong.
 */
export type SecretBindingName<K extends string> = string extends K
  ? string
  : K extends Uppercase<K>
    ? Underscored<K>
    : K extends Lowercase<K>
      ? Uppercase<Underscored<K>>
      : string;

/** Whether `name` is something a Worker can bind: SCREAMING_SNAKE_CASE, not starting with a digit. */
export function isBindingName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}
