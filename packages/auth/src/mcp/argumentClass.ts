// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ToolArguments } from "./dispatch";

/**
 * What a tool call's arguments leave in its audit row (`docs/AGENT-ACCESS.md` §9).
 *
 * A tool's arguments may carry a customer's own data, and an audit trail that copied them would be a second place
 * that data lives. So the row keeps the route's path parameters verbatim, because they are the resource ids the
 * route already records, and of the query and the body only the top-level key names, sorted, with each value's
 * JSON type. No value, no length, no nested key.
 */

/** A value's JSON type, with an array told apart from an object. */
export type JsonType = "string" | "number" | "boolean" | "null" | "array" | "object";

/** One top-level key and the JSON type of its value. */
export interface KeyClass {
  /** The key's name, cut to {@link MAX_RECORDED_TEXT}. */
  readonly key: string;
  readonly type: JsonType;
  /** Set when the name was longer than {@link MAX_RECORDED_TEXT} and was cut. */
  readonly truncated?: true;
}

/** A query or body as the row records it: its type, and for an object its keys. */
export interface ValueClass {
  readonly type: JsonType;
  readonly keys?: readonly KeyClass[];
  /** How many keys past {@link MAX_CLASSED_KEYS} were counted rather than named. */
  readonly omitted?: number;
}

/** A call's arguments, classed. */
export interface ArgumentClass {
  /** Each path parameter's value, cut to {@link MAX_RECORDED_TEXT}. */
  readonly path?: Readonly<Record<string, string>>;
  /** The path parameters whose values were cut. */
  readonly truncatedPath?: readonly string[];
  readonly query?: ValueClass;
  readonly body?: ValueClass;
}

/** The most keys one query or body names, so a row stays bounded whatever an agent sends. */
export const MAX_CLASSED_KEYS = 64;

/**
 * The longest key name or path value a row records. With {@link MAX_CLASSED_KEYS}, it bounds the whole class, so an
 * agent cannot pad its arguments until the row is too large to write.
 */
export const MAX_RECORDED_TEXT = 128;

/** A value's JSON type. */
export function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

/** The parameters a Hono path declares, in order. A trailing wildcard is the `path` argument `toolUrl` fills it from. */
export function pathParamNames(path: string): string[] {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g)].map((match) => match[1] ?? "");
  return path.endsWith("*") ? [...names, "path"] : names;
}

function classed(value: unknown): ValueClass {
  const type = jsonType(value);
  if (type !== "object") return { type };
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => ({ key, type: jsonType(entry) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const keys = entries
    .slice(0, MAX_CLASSED_KEYS)
    .map((entry) =>
      entry.key.length > MAX_RECORDED_TEXT
        ? { ...entry, key: entry.key.slice(0, MAX_RECORDED_TEXT), truncated: true as const }
        : entry,
    );
  const omitted = entries.length - keys.length;
  return omitted > 0 ? { type, keys, omitted } : { type, keys };
}

/** The class of a call's arguments against the route path the tool dispatches to. */
export function argumentClass(routePath: string, args: ToolArguments): ArgumentClass {
  const path: Record<string, string> = {};
  const truncatedPath: string[] = [];
  for (const name of pathParamNames(routePath)) {
    const value = args.path?.[name];
    if (value === undefined || value === null) continue;
    const text = String(value);
    path[name] = text.slice(0, MAX_RECORDED_TEXT);
    if (text.length > MAX_RECORDED_TEXT) truncatedPath.push(name);
  }
  return {
    ...(Object.keys(path).length === 0 ? {} : { path }),
    ...(truncatedPath.length === 0 ? {} : { truncatedPath }),
    ...(args.query === undefined ? {} : { query: classed(args.query) }),
    ...(args.body === undefined ? {} : { body: classed(args.body) }),
  };
}
