// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { CamelCasePlugin } from "kysely";
import { z } from "zod";
import { type SecretBackend, SecretValueType } from "../registry";

/**
 * Declared secret tables — a secret that belongs to somebody, with an owner Pithy can see.
 *
 * A keyspace (`../keyspace`) stores one member per opaque key, so an adopter with a two-part owner — a
 * user inside an organization — encodes the owner into the key and Pithy sees a name. That answers
 * *fetch this secret* and nothing else: *what does this organization hold* is a `LIKE` scan, one of the
 * two axes has no prefix any scan could match, and offboarding a tenant is a sweep the adopter writes
 * against our table — the one operation that most needs to be exactly right.
 *
 * A declared table gives the owner typed columns instead. `defineSecretTable({ name, keys, secrets })`
 * names the table, its owner keys and the secret names a row may carry; `pithy migrate` writes the
 * migration that creates `pithy_secrets_<name>_secrets` beside the system table, in the same secrets D1,
 * and `secretsStore(env, registry).table(T)` reads and writes it. **The value path is the system table's,
 * byte for byte**: the same master key, the same AES-256-GCM envelope, the same `{ currentVersion,
 * versions }` value envelope and the same at-rest rotation, which finds the table through
 * `pithy_secrets_tables` (`../data/secretTables`).
 *
 * **What is bound into the ciphertext is the row's identity** — the table, the owner and the secret name
 * ({@link secretTableContext}) — so a ciphertext lifted into another owner's row does not open, exactly as
 * a system secret's stored name is bound (`../crypto/envelope`).
 */

/** Longest declared table name. Short enough that `pithy_secrets_<name>_secrets` stays legible in a listing. */
const MAX_TABLE_NAME = 32;

/** Longest owner key value. Generous for a uuid or a prefixed id; bounded so a row's context stays bounded. */
const MAX_KEY_VALUE = 256;

/** A declared table's name: camelCase. {@link roundTrips} is the rest of the rule. */
const TABLE_NAME = /^[a-z][a-zA-Z0-9]*$/;

/** An owner key's name: a camelCase column identifier. */
const KEY_NAME = /^[a-z][a-zA-Z0-9]*$/;

/** A secret name: the same alphabet a registry name reads in, minus every separator. */
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The columns every declared table carries — the system table's row, minus nothing. */
export const SECRET_TABLE_BASE_COLUMNS = [
  "id",
  "name",
  "encryptedValue",
  "iv",
  "keyVersion",
  "valueType",
  "createdAt",
  "updatedAt",
] as const;

/** A declared table's owner keys: column name → the Zod schema a key value must satisfy. */
export type SecretTableKeys = Record<string, z.ZodType<string>>;

/** The fields every declared secret carries, whatever its value type. */
interface SecretTableSecretBase {
  /**
   * Whether a future value-rotator may manage this secret. Forward-looking metadata, exactly as it is on a
   * registry entry — and the gate on {@link SecretTableAccessor.rotate}, which appends a version.
   */
  rotatable: boolean;
  /** How often this secret is expected to be rotated, in days. Metadata, as on a registry entry. */
  rotateEveryDays?: number;
  /**
   * Where the value lives. Only `d1`, and stated only to be refused otherwise: a Secrets Store binding is
   * declared in `wrangler.jsonc` at build time, and a per-owner name does not exist then.
   */
  backend?: SecretBackend;
}

/** One declared secret name: its value type, and for `json` the schema a value is validated against. */
export type SecretTableSecret = SecretTableSecretBase &
  ({ valueType: "text"; schema?: undefined } | { valueType: "json"; schema: z.ZodType });

/** A declared table's secrets: secret name → its declaration. */
export type SecretTableSecrets = Record<string, SecretTableSecret>;

/** What an adopter writes. */
export interface SecretTableDeclaration<
  N extends string = string,
  K extends SecretTableKeys = SecretTableKeys,
  S extends SecretTableSecrets = SecretTableSecrets,
> {
  /** The table's name: `customer` generates `pithy_secrets_customer_secrets`. Stable forever once migrated. */
  name: N;
  /** The owner: every key column a row is addressed by, each with the schema its value must satisfy. */
  keys: K;
  /** Every secret name a row may carry. */
  secrets: S;
}

/** A validated declaration, with the names everything downstream derives once. */
export interface SecretTable<
  N extends string = string,
  K extends SecretTableKeys = SecretTableKeys,
  S extends SecretTableSecrets = SecretTableSecrets,
> extends SecretTableDeclaration<N, K, S> {
  /** The brand a CLI and a sweep recognize a declaration by. */
  readonly kind: "pithy-secret-table";
  /** The camelCase identifier Kysely queries through `CamelCasePlugin`: `pithySecretsCustomerSecrets`. */
  readonly identifier: string;
  /** The SQL name that identifier becomes: `pithy_secrets_customer_secrets`. */
  readonly sqlName: string;
  /** The owner key columns, in declaration order. */
  readonly keyNames: readonly (keyof K & string)[];
  /** The secret names, in declaration order. */
  readonly secretNames: readonly (keyof S & string)[];
}

/**
 * Any declared table, structurally. An interface of its own rather than `SecretTable<string, …>`: the
 * declaration's key map appears both as a value and under `keyof`, which makes the generic invariant, and a
 * table declared with `userId` would then not be "any table".
 */
export interface AnySecretTable {
  readonly kind: "pithy-secret-table";
  readonly name: string;
  readonly keys: SecretTableKeys;
  readonly secrets: SecretTableSecrets;
  readonly identifier: string;
  readonly sqlName: string;
  readonly keyNames: readonly string[];
  readonly secretNames: readonly string[];
}

/** A whole owner: every declared key. What `get`, `put`, `rotate` and `delete` take. */
export type SecretTableOwner<T extends AnySecretTable> = { -readonly [P in keyof T["keys"]]: z.output<T["keys"][P]> };

/** Any subset of the declared keys: what `list` and `deleteWhere` take, for an owner-wide question. */
export type SecretTableOwnerPredicate<T extends AnySecretTable> = Partial<SecretTableOwner<T>>;

/** A secret name the table declares. */
export type SecretTableSecretName<T extends AnySecretTable> = keyof T["secrets"] & string;

/** The value one declared secret holds: a string for `text`, the schema's output for `json`. */
export type SecretTableValue<
  T extends AnySecretTable,
  Name extends SecretTableSecretName<T>,
> = T["secrets"][Name] extends {
  valueType: "json";
  schema: infer Z extends z.ZodType;
}
  ? z.output<Z>
  : string;

/**
 * `CamelCasePlugin`'s own two conversions, as the kit installs it (`createDatabase`, default options). Exposed
 * through a subclass because the plugin keeps them `protected` — and borrowed rather than re-implemented,
 * because a second copy of the rule is how a migration and a lookup come to name two different tables.
 */
class Conversions extends CamelCasePlugin {
  toSnake(identifier: string): string {
    return this.snakeCase(identifier);
  }
  toCamel(column: string): string {
    return this.camelCase(column);
  }
}

const conversions = new Conversions();

/** `camelCase` → `snake_case`, exactly as `CamelCasePlugin` converts an identifier — it is the plugin's. */
export function snakeCase(identifier: string): string {
  return conversions.toSnake(identifier);
}

/**
 * Whether an identifier comes back from `snake_case` as itself. The plugin folds a run of capitals into one
 * word — `customerAPI` writes `customer_api` and reads back `customerApi` — so a name that does not round-trip
 * is a table a registry lookup cannot find, or a key column a row read comes back without.
 */
function roundTrips(identifier: string): boolean {
  return conversions.toCamel(snakeCase(identifier)) === identifier;
}

/** The camelCase table identifier for a declared name: `customer` → `pithySecretsCustomerSecrets`. */
export function secretTableIdentifier(name: string): string {
  return `pithySecrets${name.charAt(0).toUpperCase()}${name.slice(1)}Secrets`;
}

/** Whether a string is a legal declared table name. Exported so a registry row is held to the same rule. */
export function isSecretTableName(name: string): boolean {
  return TABLE_NAME.test(name) && name.length <= MAX_TABLE_NAME && roundTrips(secretTableIdentifier(name));
}

/** Whether a string is a legal owner key column name. Exported so a registry row is held to the same rule. */
export function isSecretTableKeyName(name: string): boolean {
  return KEY_NAME.test(name) && roundTrips(name) && !(SECRET_TABLE_BASE_COLUMNS as readonly string[]).includes(name);
}

/** The author error every refusal here raises — a declaration is code, so its mistake is ours to name. */
function refuse(table: string, reason: string): InternalError {
  return new InternalError({ message: `secret table "${table}": ${reason}` });
}

/**
 * Declare a secrets table. Validated here, where the author is, so a declaration that could not be
 * migrated, stored or rotated fails at define time and names itself — never at a read.
 *
 * The `const` type parameters keep the literal names, which is what makes `.table(T)` accept only declared
 * secret names and only declared key fields.
 */
export function defineSecretTable<
  const N extends string,
  const K extends SecretTableKeys,
  const S extends SecretTableSecrets,
>(declaration: SecretTableDeclaration<N, K, S>): SecretTable<N, K, S> {
  const { name, keys, secrets } = declaration;
  if (typeof name !== "string" || !isSecretTableName(name)) {
    throw refuse(
      String(name),
      `the name must be camelCase, start with a lower-case word, never put two capitals together, and be at most ${MAX_TABLE_NAME} characters — "customerApi", not "customerAPI".`,
    );
  }

  const keyNames = Object.keys(keys) as (keyof K & string)[];
  if (keyNames.length === 0) throw refuse(name, "declare at least one key — the owner is the point of a table.");
  for (const key of keyNames) {
    if ((SECRET_TABLE_BASE_COLUMNS as readonly string[]).includes(key)) {
      throw refuse(name, `key "${key}" is a base column every table already carries. Rename the key.`);
    }
    if (!KEY_NAME.test(key)) throw refuse(name, `key "${key}" must be a camelCase column name.`);
    if (!roundTrips(key)) {
      throw refuse(name, `key "${key}" must never put two capitals together — "userId", not "userID".`);
    }
    if (!(keys[key] instanceof z.ZodType)) throw refuse(name, `key "${key}" must declare a Zod schema.`);
  }

  const secretNames = Object.keys(secrets) as (keyof S & string)[];
  if (secretNames.length === 0) throw refuse(name, "declare at least one secret name.");
  for (const secret of secretNames) {
    if (!SECRET_NAME.test(secret)) {
      throw refuse(name, `secret "${secret}" must start with a letter and use letters, digits, dash or underscore.`);
    }
    const entry = secrets[secret] as SecretTableSecret;
    if (entry.backend !== undefined && entry.backend !== "d1") {
      throw refuse(
        name,
        `secret "${secret}" cannot use the ${String(entry.backend)} backend — a Secrets Store binding is declared at build time, and a per-owner name does not exist then. Declared tables are d1 only.`,
      );
    }
    if (!SecretValueType.safeParse(entry.valueType).success) {
      throw refuse(name, `secret "${secret}" has an invalid valueType (${String(entry.valueType)}).`);
    }
    if (entry.valueType === "json" && !(entry.schema instanceof z.ZodType)) {
      throw refuse(name, `json secret "${secret}" must declare a Zod schema.`);
    }
    if (typeof entry.rotatable !== "boolean") {
      throw refuse(name, `secret "${secret}" must declare rotatable as a boolean.`);
    }
    if (
      entry.rotateEveryDays !== undefined &&
      (!Number.isInteger(entry.rotateEveryDays) || entry.rotateEveryDays < 1)
    ) {
      throw refuse(name, `secret "${secret}" must declare rotateEveryDays as a whole number of days, at least 1.`);
    }
  }

  const identifier = secretTableIdentifier(name);
  return {
    ...declaration,
    kind: "pithy-secret-table",
    identifier,
    sqlName: snakeCase(identifier),
    keyNames,
    secretNames,
  };
}

/** Whether a value is a declared table — the brand, never a structural guess. */
export function isSecretTable(value: unknown): value is AnySecretTable {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "pithy-secret-table";
}

/**
 * Validate one key value against its declared schema, refusing in words that name the key and never the
 * value: `detail` reaches logs verbatim, and an owner key identifies a customer.
 */
function ownerValue(table: AnySecretTable, key: string, value: unknown, creating: boolean): string {
  const schema = table.keys[key];
  if (!schema) {
    throw new ValidationError({
      message: `Secret table '${table.name}' has no key of that name.`,
      detail: `secret table '${table.name}': key '${key}' is not declared`,
    });
  }
  // Addressing a row, the empty string is a legal key value as itself: it is what every row holds in a key added
  // after the row was written, so it reaches those rows. Creating one, it is not: a new row's owner is whatever
  // the declared schema allows, and nothing else — or `deleteWhere` on that key could never reach it.
  if (value === "" && !creating) return "";
  const parsed = schema.safeParse(value);
  if (!parsed.success || typeof parsed.data !== "string") {
    throw new ValidationError({
      message: `Secret table '${table.name}' was handed an invalid owner.`,
      detail: `secret table '${table.name}': key '${key}' failed its declared schema`,
    });
  }
  if (parsed.data.length > MAX_KEY_VALUE) {
    throw new ValidationError({
      message: `Secret table '${table.name}' was handed an invalid owner.`,
      detail: `secret table '${table.name}': key '${key}' is longer than ${MAX_KEY_VALUE} characters`,
    });
  }
  return parsed.data;
}

/** Refuse a key the table does not declare, before anything is composed from it. */
function refuseUndeclared(table: AnySecretTable, given: Record<string, unknown>): void {
  for (const key of Object.keys(given)) {
    if (!(key in table.keys)) {
      throw new ValidationError({
        message: `Secret table '${table.name}' has no key of that name.`,
        detail: `secret table '${table.name}': key '${key}' is not declared`,
      });
    }
  }
}

/** Refuse an owner or predicate with no key set — it would address every owner, or no owner at all. */
function requireSomeKey(table: AnySecretTable, owner: Record<string, string>): void {
  if (Object.values(owner).some((value) => value !== "")) return;
  throw new ValidationError({
    message: `Secret table '${table.name}' needs at least one key to match on.`,
    action: "Name the owner — an organization, a user — rather than every owner at once.",
    detail: `secret table '${table.name}': no key is set, which matches every row and is refused`,
  });
}

/**
 * A whole owner, validated: every declared key present and each satisfying its schema, at least one of them
 * set. The only way an owner reaches a query or a bound context, so there is one place an owner is proven legal.
 *
 * Addressing a row, a key may be `""` beside a set one — what a row written before that key was added holds
 * there. With `creating`, for a write that may insert, every key is held to its schema, `""` included: the
 * exemption exists for rows an alter left behind, and a new row is not one.
 */
export function secretTableOwner(
  table: AnySecretTable,
  given: Record<string, unknown>,
  options: { creating?: boolean } = {},
): Record<string, string> {
  refuseUndeclared(table, given);
  const owner: Record<string, string> = {};
  for (const key of table.keyNames) {
    if (given[key] === undefined) {
      throw new ValidationError({
        message: `Secret table '${table.name}' needs the whole owner.`,
        detail: `secret table '${table.name}': key '${key}' is missing`,
      });
    }
    owner[key] = ownerValue(table, key, given[key], options.creating === true);
  }
  requireSomeKey(table, owner);
  return owner;
}

/**
 * An owner-wide predicate, validated: any non-empty subset of the declared keys. `{}` is refused — it would
 * mean every owner at once, and `deleteWhere({})` is the one call that must never be a typo away.
 */
export function secretTablePredicate(table: AnySecretTable, given: Record<string, unknown>): Record<string, string> {
  refuseUndeclared(table, given);
  const predicate: Record<string, string> = {};
  for (const key of table.keyNames) {
    if (given[key] === undefined) continue;
    predicate[key] = ownerValue(table, key, given[key], false);
  }
  requireSomeKey(table, predicate);
  return predicate;
}

/**
 * The authenticated data one row's ciphertext is bound to: the table, the owner and the secret name.
 *
 * **JSON, so composition cannot collide.** A delimiter-joined string would let a key value containing the
 * delimiter forge a neighbor's context; an encoded array has one reading. **Sorted by key name**, so the
 * context is the owner's and not the declaration's ordering. **An empty key is left out**, which is what lets
 * a key column added later — every existing row holds `''` there — leave each stored row's context, and so
 * its ciphertext, exactly as it was.
 *
 * Versioned, so a later change to what is bound is a deliberate, visible break.
 */
export function secretTableContext(table: string, owner: Readonly<Record<string, string>>, secret: string): string {
  const pairs = Object.entries(owner)
    .filter(([, value]) => value !== "")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(["pithy-secret-table/v1", table, pairs, secret]);
}

/**
 * The Zod row schema for a declared table — the system table's row plus one text column per key. It is the
 * table's whole definition, as every table in the kit is, and what `c.var.db.secrets` is typed by.
 */
export function secretTableRow(table: AnySecretTable) {
  const keyColumns: Record<string, z.ZodString> = {};
  for (const key of table.keyNames) {
    const described = table.keys[key]?.description;
    keyColumns[key] = z
      .string()
      .describe(described ? `Owner key: ${described}` : `Owner key '${key}', declared by the table.`);
  }
  return z
    .object({
      id: z.number().int().describe("Surrogate primary key, autoincremented by SQLite."),
      name: z.string().describe("The secret name this row holds — one the table declares."),
      encryptedValue: z.string().describe("Base64-encoded AES-256-GCM ciphertext of the version→value map."),
      iv: z.string().describe("Base64-encoded initialization vector; unique per encryption operation."),
      keyVersion: z
        .number()
        .int()
        .describe("Master-key version that produced this ciphertext; the at-rest rotation moves it."),
      valueType: SecretValueType.describe("How the decrypted plaintext is interpreted: `text` or `json`."),
      createdAt: SQLiteDate.describe("When the secret was first written. Ms-epoch in SQLite, a `Date` in app code."),
      updatedAt: SQLiteDate.describe("When the secret was last written. Ms-epoch in SQLite, a `Date` in app code."),
      ...keyColumns,
    })
    .describe(`One encrypted secret row in the declared table \`${table.sqlName}\`, addressed by its owner keys.`);
}
