// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What Better Auth writes against what the kit's tables hold, in both directions (#451, #787).
 *
 * **The first direction is #451's.** A column Better Auth writes and the table lacks fails every insert
 * that names it: 1.7's `jwt` plugin added `alg` and `crv`, `0001_init` had neither, and every sign-in that
 * minted a signing key died on `table pithy_auth_jwks has no column named alg`.
 *
 * **The second direction is #787's, and its absence let the first one's mirror image ship.** A `NOT NULL`
 * column with no default that Better Auth does not write fails every insert into its table, because
 * nothing supplies it. 1.7.3 stopped writing `pithy_auth_accounts.issuer`, `0001_init` still required it,
 * and every email OTP sign-in answered 500. The first direction could not see it: every column Better Auth
 * declared was there. This is the same comparison Better Auth's own initialization check makes
 * (`@better-auth/core`'s `diffSchema`), held here so CI makes it at whatever version is installed.
 *
 * Both halves compare in the database's vocabulary: Better Auth's camelCase names are snake-cased the way
 * the `CamelCasePlugin` does it, and `pragma_table_info` reports the rest.
 */

/** A field of a Better Auth model, as `getSchema` reports it. Only the column name matters here. */
export interface DeclaredField {
  /** The column name, when it differs from the field's key. */
  fieldName?: string;
}

/** A Better Auth model, as `getSchema` reports it. */
export interface DeclaredModel {
  /** Every field the model writes, keyed by field name. */
  fields: Record<string, DeclaredField>;
}

/** One column of a table, as `pragma_table_info` describes it. */
export interface ActualColumn {
  /** The column name, snake_case. */
  name: string;
  /** Whether the column is `NOT NULL`. */
  notNull: boolean;
  /** Whether the column carries a default. */
  hasDefault: boolean;
}

/** camelCase → snake_case, the one transformation `CamelCasePlugin` applies to an identifier. */
export function snake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Every disagreement between what Better Auth writes and what the tables hold, one line each.
 *
 * `actual` maps a snake_case table name to its columns, and a table it does not name is a table that does
 * not exist. A model with no table is reported once, as such, rather than as every column it lacks. The
 * `id` primary key counts as written: Better Auth generates one for every row.
 */
export function schemaDrift(
  declared: Record<string, DeclaredModel>,
  actual: Record<string, readonly ActualColumn[]>,
): string[] {
  const findings: string[] = [];
  for (const [model, spec] of Object.entries(declared)) {
    const table = snake(model);
    const columns = actual[table];
    if (columns === undefined || columns.length === 0) {
      findings.push(`${table}: no such table`);
      continue;
    }
    const written = new Set([
      "id",
      ...Object.entries(spec.fields).map(([field, definition]) => snake(definition.fieldName ?? field)),
    ]);
    const present = new Set(columns.map((column) => column.name));
    for (const column of written) {
      if (!present.has(column)) findings.push(`${table}.${column}: missing`);
    }
    for (const column of columns) {
      if (written.has(column.name) || !column.notNull || column.hasDefault) continue;
      findings.push(`${table}.${column.name}: required, and Better Auth never writes it`);
    }
  }
  return findings;
}
