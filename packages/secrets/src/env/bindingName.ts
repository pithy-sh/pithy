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
 * **The rule is one sentence.** Every character that is not an ASCII letter or digit becomes `_`, and the
 * result is uppercased. Nothing else: no word boundary is inferred, so `R2ACCESS-KEY` and `R2ACCESS_KEY`
 * are the same binding (and refused together, where a registry is defined), and a camelCase key is not
 * split — `stripeWebhookKey` binds as `STRIPEWEBHOOKKEY`. No key the kit declares is camelCase, and no
 * adopter registry we know of is either; a guessed boundary would be a second rule for the type below to
 * disagree with. A key already in the shape is its own binding, and the rule is idempotent. A key whose
 * binding cannot be bound — one that starts with a digit — is refused where the registry is defined, by
 * {@link isBindingName}.
 *
 * A leaf: nothing here may import anything, for the reason `masterKeyBinding.ts` gives — `registry.ts`
 * needs it, and a browser-validated admin schema reaches `registry.ts`.
 */
export function secretBindingName<const K extends string>(key: K): SecretBindingName<K> {
  return key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase() as SecretBindingName<K>;
}

/** Each character of a string literal, as a union. */
type Characters<S extends string, Found extends string = never> = S extends `${infer C}${infer Rest}`
  ? Characters<Rest, Found | C>
  : Found;
type Letter = Characters<"abcdefghijklmnopqrstuvwxyz">;
type Alphanumeric = Letter | Uppercase<Letter> | Characters<"0123456789">;

/** One character, as the rule maps it. */
type Mapped<C extends string> = C extends Alphanumeric ? C : "_";

/**
 * Every character that is not an ASCII letter or digit, as an underscore. Tail-recursive through `Done`, and
 * eight characters a step, so the checker unrolls it as a short loop rather than a nesting: a key of a few
 * thousand characters still types, where a character a step exhausted the checker at forty-nine.
 */
type Underscored<
  K extends string,
  Done extends string = "",
> = K extends `${infer A}${infer B}${infer C}${infer D}${infer E}${infer F}${infer G}${infer H}${infer Rest}`
  ? Underscored<
      Rest,
      `${Done}${Mapped<A>}${Mapped<B>}${Mapped<C>}${Mapped<D>}${Mapped<E>}${Mapped<F>}${Mapped<G>}${Mapped<H>}`
    >
  : K extends `${infer A}${infer Rest}`
    ? Underscored<Rest, `${Done}${Mapped<A>}`>
    : Done;

/**
 * {@link secretBindingName}'s answer, as a type — the same rule, so a prebuilt host's env schema can key a
 * binding by the derived name and still know which name it is, rather than spelling `EMAIL_LINK_SIGNING_KEY`
 * by hand. Exact for every literal key; a key that is only a `string` is a `string`.
 */
export type SecretBindingName<K extends string> = string extends K ? string : Uppercase<Underscored<K>>;

/** Whether `name` is something a Worker can bind: SCREAMING_SNAKE_CASE, not starting with a digit. */
export function isBindingName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}
