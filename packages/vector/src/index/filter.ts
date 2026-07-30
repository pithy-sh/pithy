// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";
import { VectorFilterTooLargeError, VectorUnfilterableFieldError } from "../error/errors";
import { byteLength, filterKeyProblem, MAX_FILTER_BYTES } from "./limits";
import { introspectMetadata, type MetadataIndexDescriptor } from "./metadata";

/**
 * The typed metadata filter builder.
 *
 * Filtering an unindexed field is the failure this package exists to prevent, and it is invisible at runtime:
 * Vectorize accepts the filter and returns a short, plausible result set. So the guard is layered. A filter
 * naming a field that is not marked filterable is a **compile-time type error** for a caller who marked the
 * field with {@link filterable}; `vector/unfilterable_field` is the runtime guard behind it, for a caller
 * arriving through an untyped boundary — an HTTP body, a job payload, JavaScript.
 *
 * `.meta({ filterable: true })` is the runtime marker: it drives provisioning and the drift check. The type
 * system cannot see it — `.meta()` returns the same type it was called on — so {@link filterable} sets the
 * same marker *and* brands the field's type. Mark fields with it and the builder types itself. Mark them with
 * a bare `.meta({ filterable: true })` and everything still provisions and still filters; only the
 * compile-time narrowing is lost.
 */

/** A metadata value Vectorize can filter on. Nested objects and arrays are not filterable. */
export type FilterPrimitive = string | number | boolean;

/** The comparison operators Vectorize's metadata filtering accepts. */
export interface FilterComparison<V extends FilterPrimitive> {
  /** Equal to. */
  $eq?: V;
  /** Not equal to. */
  $ne?: V;
  /** In this set. */
  $in?: readonly V[];
  /** Not in this set. */
  $nin?: readonly V[];
  /** Strictly less than. */
  $lt?: V;
  /** Less than or equal to. */
  $lte?: V;
  /** Strictly greater than. */
  $gt?: V;
  /** Greater than or equal to. */
  $gte?: V;
}

const OPERATORS = ["$eq", "$ne", "$in", "$nin", "$lt", "$lte", "$gt", "$gte"] as const;
const SET_OPERATORS: readonly string[] = ["$in", "$nin"];

/** The brand {@link filterable} stamps on a field's type. Type-level only — it never exists at runtime. */
declare const filterableBrand: unique symbol;

/** A metadata field marked filterable: the same schema, carrying a type-level mark the builder can read. */
export type Filterable<T extends z.ZodType> = T & { readonly [filterableBrand]: true };

/**
 * Mark a metadata field filterable. Sets `.meta({ filterable: true })` — the marker provisioning and drift
 * both read — and brands the type so {@link vectorFilter} accepts this field and rejects the others.
 */
export function filterable<T extends z.ZodType>(schema: T): Filterable<T> {
  return schema.meta({ filterable: true }) as Filterable<T>;
}

/** The keys of a metadata schema that were marked with {@link filterable}. */
export type FilterableKeys<S extends z.ZodObject> = {
  [K in keyof S["shape"]]: S["shape"][K] extends { readonly [filterableBrand]: true } ? K : never;
}[keyof S["shape"]];

/** A field's filterable value type, or `never` when it decodes to something Vectorize cannot compare. */
type FilterValueOf<S extends z.ZodObject, K extends keyof S["shape"]> =
  NonNullable<z.output<S["shape"][K]>> extends infer V ? (V extends FilterPrimitive ? V : never) : never;

/**
 * A filter over a metadata schema's filterable fields. A bare value is `$eq` — Vectorize's own shorthand —
 * and an operator object is the long form.
 */
export type VectorFilter<S extends z.ZodObject> = {
  [K in FilterableKeys<S> & string]?: FilterValueOf<S, K> | FilterComparison<FilterValueOf<S, K>>;
};

/** The compiled filter: the plain object handed to Vectorize's `query`. */
export type CompiledFilter = Record<string, unknown>;

function isPrimitive(value: unknown): value is FilterPrimitive {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Whether a value matches the type the property was indexed as. A mismatch never matches anything. */
function matchesIndexType(value: unknown, indexType: MetadataIndexDescriptor["indexType"]): boolean {
  if (value === null) return true;
  return typeof value === indexType;
}

function assertValueType(key: string, operator: string, value: unknown, descriptor: MetadataIndexDescriptor): void {
  if (SET_OPERATORS.includes(operator)) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ValidationError({
        message: `\`${operator}\` needs a non-empty list of values.`,
        action: "Pass an array of values to compare against.",
        detail: `filter key '${key}' operator '${operator}' received ${JSON.stringify(value)}`,
      });
    }
    for (const entry of value) {
      if (!matchesIndexType(entry, descriptor.indexType)) {
        throw new ValidationError({
          message: `\`${key}\` is indexed as ${descriptor.indexType}; compare it against ${descriptor.indexType} values.`,
          action: "Match the filter's value type to the field's type in the index's metadata schema.",
          detail: `filter key '${key}' operator '${operator}' received ${JSON.stringify(entry)}`,
        });
      }
    }
    return;
  }
  if (!matchesIndexType(value, descriptor.indexType)) {
    throw new ValidationError({
      message: `\`${key}\` is indexed as ${descriptor.indexType}; compare it against ${descriptor.indexType} values.`,
      action: "Match the filter's value type to the field's type in the index's metadata schema.",
      detail: `filter key '${key}' operator '${operator}' received ${JSON.stringify(value)}`,
    });
  }
}

/**
 * Validate an untyped filter against the metadata indexes an index actually has, and return the object to
 * hand Vectorize. This is the runtime half of the guard: every key must be indexed, every operator must be one
 * Vectorize knows, every value must match the property's index type, and the compact JSON must stay under
 * 2,048 bytes.
 */
export function compileFilter(descriptors: readonly MetadataIndexDescriptor[], filter: CompiledFilter): CompiledFilter {
  const byName = new Map(descriptors.map((descriptor) => [descriptor.propertyName, descriptor]));
  const compiled: CompiledFilter = {};

  for (const [key, condition] of Object.entries(filter)) {
    if (condition === undefined) continue;

    const keyProblem = filterKeyProblem(key);
    if (keyProblem) {
      throw new ValidationError({
        message: "That filter key is not usable.",
        action: "Filter keys are non-empty, carry no dots, do not start with $, and stay under 512 characters.",
        detail: `filter key ${keyProblem}`,
      });
    }

    const descriptor = byName.get(key);
    if (!descriptor) {
      throw new VectorUnfilterableFieldError({
        detail: `no metadata index for '${key}'; indexed: ${descriptors.map((d) => d.propertyName).join(", ") || "none"}`,
      });
    }

    if (isPrimitive(condition) || condition === null) {
      // Vectorize's shorthand: a bare value means $eq. Expanded here so one compiled shape reaches the wire.
      assertValueType(key, "$eq", condition, descriptor);
      compiled[key] = { $eq: condition };
      continue;
    }

    if (typeof condition !== "object") {
      throw new ValidationError({
        message: `\`${key}\` needs a value or a comparison.`,
        action: "Pass a value, or an object of operators such as { $in: [...] }.",
        detail: `filter key '${key}' received ${typeof condition}`,
      });
    }

    const operators: Record<string, unknown> = {};
    for (const [operator, value] of Object.entries(condition as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (!OPERATORS.includes(operator as (typeof OPERATORS)[number])) {
        throw new ValidationError({
          message: `\`${operator}\` is not a filter operator.`,
          action: `Use one of ${OPERATORS.join(", ")}.`,
          detail: `filter key '${key}' used operator '${operator}'`,
        });
      }
      assertValueType(key, operator, value, descriptor);
      operators[operator] = value;
    }

    if (Object.keys(operators).length === 0) {
      throw new ValidationError({
        message: `\`${key}\` has no comparison.`,
        action: `Give it a value, or one of ${OPERATORS.join(", ")}.`,
        detail: `filter key '${key}' compiled to an empty comparison`,
      });
    }
    compiled[key] = operators;
  }

  assertFilterSize(compiled);
  return compiled;
}

/**
 * Reject a filter whose compact JSON reaches Vectorize's ceiling. Checked here, before the call, because
 * Vectorize's own rejection arrives as an opaque error with no indication which filter was at fault.
 */
export function assertFilterSize(filter: CompiledFilter): void {
  const size = byteLength(JSON.stringify(filter));
  if (size >= MAX_FILTER_BYTES) {
    throw new VectorFilterTooLargeError({
      detail: `filter JSON is ${size} bytes; the limit is under ${MAX_FILTER_BYTES}`,
    });
  }
}

/**
 * Evaluate a compiled filter against one document's metadata, in memory.
 *
 * Vectorize evaluates filters inside the index; this evaluates the same filter against a D1 row. It exists
 * for `pithy vector reprocess --filter`, which selects rows out of the document corpus rather than out of the
 * index. Metadata lives in a JSON column, so no SQL predicate can answer it without hand-written extraction
 * — and re-embedding one document costs orders of magnitude more than reading it, so scanning a page and
 * filtering it here is not the expensive half.
 *
 * The semantics are Vectorize's: an absent property matches only `$ne`/`$nin`, and every named property must
 * match (implicit AND). Pass a filter that {@link compileFilter} produced, so every condition is already in
 * operator form.
 */
export function matchesCompiledFilter(metadata: Record<string, unknown>, filter: CompiledFilter): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    const value = metadata[key];
    const operators = condition as Record<string, unknown>;
    for (const [operator, operand] of Object.entries(operators)) {
      if (!compare(value, operator, operand)) return false;
    }
  }
  return true;
}

/** One operator against one value. An absent value matches only the negative operators, as Vectorize does. */
function compare(value: unknown, operator: string, operand: unknown): boolean {
  switch (operator) {
    case "$eq":
      return value === operand;
    case "$ne":
      return value !== operand;
    case "$in":
      return Array.isArray(operand) && operand.includes(value);
    case "$nin":
      return Array.isArray(operand) && !operand.includes(value);
    case "$lt":
      return ordered(value, operand, (a, b) => a < b);
    case "$lte":
      return ordered(value, operand, (a, b) => a <= b);
    case "$gt":
      return ordered(value, operand, (a, b) => a > b);
    case "$gte":
      return ordered(value, operand, (a, b) => a >= b);
    default:
      return false;
  }
}

/**
 * Apply an ordered comparison, but only between two values of the same primitive type. An absent property,
 * or a type mismatch, matches nothing — the same answer Vectorize gives.
 */
function ordered(
  value: unknown,
  operand: unknown,
  compareTo: (left: number | string, right: number | string) => boolean,
): boolean {
  if (typeof value !== typeof operand) return false;
  if (typeof value !== "number" && typeof value !== "string") return false;
  return compareTo(value, operand as number | string);
}

/**
 * Build a filter against an index's metadata schema. The typed entry point: the compiler rejects a field that
 * was not marked {@link filterable}, and the runtime checks below catch the same mistake arriving untyped.
 */
export function vectorFilter<S extends z.ZodObject>(metadata: S, filter: VectorFilter<S>): CompiledFilter {
  return compileFilter(introspectMetadata(metadata).indexes, filter as CompiledFilter);
}
