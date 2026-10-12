// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CommandDef } from "citty";
import { z } from "zod";
import { contractOf } from "./commandContract";
import { walkTree } from "./describe";

/**
 * **Every payload's keys and their types, at the version they were promised under (#697).**
 *
 * `schemaVersion` is bumped only by a change that breaks a parser: a key removed or retyped. Nothing about a
 * Zod schema says what it used to be, so the shapes are committed (`payloadShapes.generated.json`) and each run
 * compares the tree against them. A key the file holds that is gone or typed differently, under the same
 * version, is a break nobody owned up to. A key the file lacks is only new.
 *
 * **A shape is the JSON Schema flattened to paths**, `$.workers[].name` → `string`, rather than the JSON
 * Schema itself, because the comparison is about keys and types and nothing else: a reworded description is
 * not a break, and a diff of this file reads as the list of keys that changed. Each object member of a union is
 * flattened apart, `$<kind="a">.x`, so a key one member drops is not hidden by another member that keeps it. A fixed set of values is part
 * of a key's type, so a value added to an enum counts as a retype — a parser validating against the published
 * set refuses the new one. A key that stops being certain to appear is marked `?` and counts too.
 */

/** Where the shapes are committed, from the repository root. */
export const PAYLOAD_SHAPES_PATH = "packages/cli/src/contract/payloadShapes.generated.json";

/** One payload's keys, by path, each with its type. */
export type Shape = Record<string, string>;

/** One command's payload, and its `--events` record when it has one, at the version it declares. */
export interface CommandShapes {
  schemaVersion: number;
  payload: Shape;
  events?: Shape;
}

/** Every command that writes `--json`, by the path a caller types. */
export interface PayloadShapes {
  commands: Record<string, CommandShapes>;
}

type JsonSchemaNode = Record<string, unknown>;

const BRANCHES = ["anyOf", "oneOf", "allOf"] as const;

/** The alternatives of a signature, one per `|`. */
function alternatives(signature: string): string[] {
  return signature.split(" | ");
}

/** Several signatures as one: every alternative once, sorted, so the order a union was written in is not a change. */
function merged(signatures: readonly string[]): string {
  return [...new Set(signatures.flatMap(alternatives))].sort().join(" | ");
}

/** What one node is, without its children: a literal, a fixed set, a type, or the union of its branches'. */
function signatureOf(node: JsonSchemaNode): string {
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (Array.isArray(node.enum)) return merged(node.enum.map((value) => JSON.stringify(value)));
  if (typeof node.type === "string") return node.type;
  if (Array.isArray(node.type)) return merged(node.type.map(String));
  for (const keyword of BRANCHES) {
    const branches = node[keyword];
    if (Array.isArray(branches)) return merged(branches.map((branch) => signatureOf(branch as JsonSchemaNode)));
  }
  if (typeof node.$ref === "string") return `ref ${node.$ref}`;
  return "unknown";
}

/** Record `signature` at `path`, merged with whatever another branch of a union already put there. */
function record(shape: Shape, path: string, signature: string): void {
  const existing = shape[path];
  shape[path] = existing === undefined ? signature : merged([existing, signature]);
}

/** Every key beneath `node`, into `shape`. Each object member of a union lands at its own path (`memberLabels`). */
function descend(node: JsonSchemaNode, path: string, shape: Shape): void {
  const properties = (node.properties ?? {}) as Record<string, JsonSchemaNode>;
  const required = Array.isArray(node.required) ? (node.required as string[]) : [];
  for (const [key, property] of Object.entries(properties)) {
    const at = `${path}.${key}`;
    record(shape, at, `${signatureOf(property)}${required.includes(key) ? "" : "?"}`);
    descend(property, at, shape);
  }
  if (node.items !== undefined && typeof node.items === "object") {
    record(shape, `${path}[]`, signatureOf(node.items as JsonSchemaNode));
    descend(node.items as JsonSchemaNode, `${path}[]`, shape);
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties === "object") {
    const values = node.additionalProperties as JsonSchemaNode;
    record(shape, `${path}{}`, signatureOf(values));
    descend(values, `${path}{}`, shape);
  }
  for (const keyword of BRANCHES) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    const labels = keyword === "allOf" ? undefined : memberLabels(branches as JsonSchemaNode[]);
    branches.forEach((branch, index) => {
      const label = labels?.get(index);
      descend(branch as JsonSchemaNode, label === undefined ? path : `${path}<${label}>`, shape);
    });
  }
}

/** The literals an object member is certain to carry, as `key=value`. */
function literalsOf(member: JsonSchemaNode): string[] {
  const properties = member.properties as Record<string, JsonSchemaNode>;
  const required = Array.isArray(member.required) ? (member.required as string[]) : [];
  return Object.entries(properties)
    .filter(([key, property]) => property.const !== undefined && required.includes(key))
    .map(([key, property]) => `${key}=${JSON.stringify(property.const)}`);
}

/**
 * **A name for each object member of a union, so each is its own shape (#697 review).** Merged into the one
 * path, a key one member dropped hid behind a member that kept it. A member is named by the literals it is
 * certain to carry that not every member shares — `kind="a"`, the discriminator a parser switches on — or, when
 * those do not tell every member apart, by its place, `#0`. A union with one object member (a nullable object)
 * is not split at all.
 */
function memberLabels(branches: readonly JsonSchemaNode[]): Map<number, string> | undefined {
  const members = branches.flatMap((branch, index) =>
    typeof branch.properties === "object" ? [{ index, literals: literalsOf(branch) }] : [],
  );
  if (members.length < 2) return undefined;
  const shared = members
    .map((member) => member.literals)
    .reduce((common, literals) => common.filter((literal) => literals.includes(literal)));
  const named = members.map(({ index, literals }) => ({
    index,
    name: literals.filter((literal) => !shared.includes(literal)).join(","),
  }));
  const distinct = new Set(named.map(({ name }) => name));
  const byName = distinct.size === named.length && !distinct.has("");
  return new Map(named.map(({ index, name }) => [index, byName ? name : `#${index}`]));
}

/** One schema, flattened: `$` for the whole, then every key beneath it. */
export function shapeOf(schema: z.ZodType): Shape {
  const root = z.toJSONSchema(schema, { io: "input" }) as JsonSchemaNode;
  const shape: Shape = { $: signatureOf(root) };
  descend(root, "$", shape);
  return shape;
}

/** Every command under `root` that declares a payload, flattened at its declared version. */
export async function payloadShapesOf(root: CommandDef): Promise<PayloadShapes> {
  const commands: Record<string, CommandShapes> = {};
  for (const node of await walkTree(root)) {
    const contract = contractOf(node.cmd);
    if (contract?.payload === undefined || contract.schemaVersion === undefined) continue;
    commands[node.path.join(" ")] = {
      schemaVersion: contract.schemaVersion,
      payload: shapeOf(contract.payload),
      ...(contract.events !== undefined ? { events: shapeOf(contract.events) } : {}),
    };
  }
  return { commands };
}

/** Each key `before` promised that `after` dropped or retyped, as a sentence naming the command. */
function brokenKeys(command: string, before: Shape, after: Shape | undefined): string[] {
  const broken: string[] = [];
  for (const [path, was] of Object.entries(before)) {
    const now = after?.[path];
    if (now === was) continue;
    broken.push(
      now === undefined
        ? `${command}: ${path} was ${was} and is gone. Bump its schemaVersion.`
        : `${command}: ${path} was ${was} and is now ${now}. Bump its schemaVersion.`,
    );
  }
  return broken;
}

/**
 * Every break between the committed shapes and the tree's, as sentences: a key removed or retyped under a
 * version that did not move, or a version that moved down. Empty when the tree keeps every promise.
 *
 * A command that is gone altogether is not reported. Its payload is not a shape that changed; it is a command
 * a caller can no longer run, and that is the command tree's news to tell.
 */
export function breakingChanges(before: PayloadShapes, after: PayloadShapes): string[] {
  const broken: string[] = [];
  for (const [command, was] of Object.entries(before.commands)) {
    const now = after.commands[command];
    if (now === undefined) continue;
    if (now.schemaVersion < was.schemaVersion) {
      broken.push(`${command}: schemaVersion went from ${was.schemaVersion} to ${now.schemaVersion}. It only goes up.`);
      continue;
    }
    if (now.schemaVersion > was.schemaVersion) continue;
    broken.push(...brokenKeys(command, was.payload, now.payload));
    if (was.events !== undefined) broken.push(...brokenKeys(`${command} --events`, was.events, now.events));
  }
  return broken;
}

/** The committed file's text: strict JSON, keys in the order the tree is walked, and a note on who writes it. */
export function renderPayloadShapes(shapes: PayloadShapes): string {
  const document = {
    $generated:
      "Generated by packages/cli/src/contract/writePayloadShapes.ts. Do not edit by hand; run `bun run payload-shapes`. Each command's --json keys at its schemaVersion: removing or retyping one needs a bump (packages/cli/src/contract/payloadShapes.ts).",
    ...shapes,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
