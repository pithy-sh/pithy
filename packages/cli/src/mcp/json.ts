// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parse } from "comment-json";
import { formatJsonc } from "../project/jsonc";
import { DOCS_MCP_NAME, type McpClient } from "./clients";
import {
  type DocumentWriter,
  type MergeResult,
  type ReadResult,
  type Refused,
  type RemoveResult,
  urlKeyOf,
} from "./document";

/**
 * The writer for the seven clients that keep their servers in JSON or JSONC.
 *
 * **One writer, because the difference between the two formats is not a difference in the operation.**
 * `json` and `jsonc` name what the tool tolerates, not what it stores: VS Code and Zed document comments
 * in their settings and the other five do not, but all seven hold a map of name to server under a root
 * key. So the format column picks a parser that reads both and the operation is written once. What does
 * differ between rows — the root key, the entry, whether the address is `url` or `httpUrl` or an
 * argument — is read off the registry and never branched on here.
 *
 * **Parsed with `comment-json`, printed by `project/jsonc.ts`, and never by `comment-json`'s own
 * `stringify`.** The parser is what keeps a VS Code comment alive across a read-modify-write; the
 * printer is what keeps the result reviewable. `stringify` puts every array element on its own line,
 * Biome collapses a short one, and the difference turns a two-key insertion into a whole-file reformat
 * (#249) — in a file somebody else wrote, where an edit nobody can review is the same as an edit nobody
 * consented to. `formatJsonc` takes the previous bytes as its oracle for exactly that reason, so an
 * object the adopter had expanded stays expanded and only the lines we added are new. The repository
 * gate for this is `ci/jsoncWriters.test.ts`.
 *
 * **Every container is mutated in place.** `comment-json` hangs an adopter's comments off the very
 * object they sit inside, as symbol-keyed properties, so `root[key] = { ...previous, pithy: entry }`
 * reads as a harmless spread and silently deletes their notes. Nothing here replaces a container that is
 * already there, and a removal takes the entry's own comment symbols with it rather than leaving a note
 * attached to a member that no longer exists.
 *
 * **A document that does not read cleanly is refused rather than repaired.** `~/.claude.json` is Claude
 * Code's entire session state and a Cursor `mcp.json` sits beside whatever else its owner put there; a
 * writer that guessed at a root key holding a string would hand back bytes that lose all of it. The
 * reasons name what could not be read and never quote the file, because these documents hold other
 * servers' credentials and a parser's own message tends to echo the line it stopped on.
 */

/** A JSON object, as far as this module needs to know one: not an array, not `null`. */
type JsonObject = Record<string, unknown>;

/** The comment positions `comment-json` keys per property. A removed member owns all five. */
const COMMENT_PREFIXES: readonly string[] = ["before", "after-prop", "after-colon", "after-value", "after"];

/**
 * True for a plain JSON object. An array is a container too, but never one of ours.
 *
 * The prototype is checked rather than `typeof` alone because `comment-json` boxes a document whose root
 * is a primitive: `parse('"anything"')` hands back a `String` object, which `typeof` calls `"object"` and
 * which carries a numbered key per character. A writer that accepted it would add a root key to a boxed
 * string and print a document nothing can read.
 */
function isObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Whether two parsed JSON values say the same thing.
 *
 * Structural rather than `JSON.stringify` on both sides, because key order is a property of the file and
 * not of the entry: an adopter whose `url` sits above their `type` has the entry we would write, and
 * reporting that as `updated` would rewrite their file on every run and call it a correction.
 */
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJson(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => key in right && sameJson(left[key], right[key]));
  }
  return left === right;
}

/** Drop the comments `comment-json` filed against one property, so a removal leaves no orphaned note. */
function forgetComments(host: JsonObject, key: string): void {
  for (const prefix of COMMENT_PREFIXES) Reflect.deleteProperty(host, Symbol.for(`${prefix}:${key}`));
}

/** A document that was read: its root, the servers under the root key, and our entry among them. */
interface Opened {
  readonly state: "open";
  /** The parsed document, to be mutated in place and handed to the printer. */
  readonly root: JsonObject;
  /** The map of name to server, or `null` when the file has no root key yet. */
  readonly servers: JsonObject | null;
  /** The `pithy` entry as the file has it, or `null` when the file does not mention us. */
  readonly entry: JsonObject | null;
}

/** A blank file says nothing; treating it as a document would refuse a file a tool created and never filled. */
function saysNothing(document: string): boolean {
  return document.trim().length === 0;
}

/**
 * Read the document far enough to act on it, or say why it cannot be acted on.
 *
 * The three refusals are the three ways the file can disagree with the shape every client documents. Each
 * one is a place where a writer that pressed on would delete something: a top level that is not an object
 * has no room for a root key, a root key holding anything else is not a server map, and a `pithy` member
 * that is not an object is something an adopter put there on purpose under a name we would overwrite.
 */
function open(document: string, client: McpClient): Opened | Refused {
  let parsed: unknown;
  try {
    parsed = parse(document) as unknown;
  } catch {
    return { state: "refused", reason: "The file is not valid JSON, so nothing was written." };
  }
  if (!isObject(parsed)) {
    return { state: "refused", reason: "The top level of the file is not a JSON object." };
  }
  const servers = parsed[client.rootKey];
  if (servers !== undefined && !isObject(servers)) {
    return { state: "refused", reason: `The \`${client.rootKey}\` key in the file is not an object.` };
  }
  const entry = servers === undefined ? undefined : servers[DOCS_MCP_NAME];
  if (entry !== undefined && !isObject(entry)) {
    return {
      state: "refused",
      reason: `The \`${DOCS_MCP_NAME}\` entry under \`${client.rootKey}\` is not an object, so it was left alone.`,
    };
  }
  return { state: "open", root: parsed, servers: servers ?? null, entry: entry ?? null };
}

/** The smallest document that declares the entry — the root key, us, and nothing else. */
function snippet(client: McpClient): string {
  return formatJsonc({ [client.rootKey]: { [DOCS_MCP_NAME]: client.entry } }, null);
}

/**
 * Set the entry, and change nothing else.
 *
 * The entry is ours end to end: a key the registry no longer declares is dropped rather than carried, so
 * a row that stops sending `type` stops sending it everywhere on the next run. That is also what makes
 * `unchanged` mean something — the comparison is against the whole entry, so there is no leftover field
 * that would report a file as correct while it still carries what we used to write.
 */
function merge(document: string | null, client: McpClient, preamble?: string | null): MergeResult {
  if (document === null || saysNothing(document)) {
    return { state: "merged", outcome: "added", document: (preamble ?? "") + snippet(client) };
  }
  const opened = open(document, client);
  if (opened.state === "refused") return opened;

  // The input bytes, not a re-rendering of them. A run that changes nothing must not touch the file.
  if (opened.entry !== null && sameJson(opened.entry, client.entry)) {
    return { state: "merged", outcome: "unchanged", document };
  }

  const outcome = opened.entry === null ? "added" : "updated";
  const servers = opened.servers ?? {};
  if (opened.servers === null) opened.root[client.rootKey] = servers;
  const entry = opened.entry ?? {};
  if (opened.entry === null) servers[DOCS_MCP_NAME] = entry;
  for (const key of Object.keys(entry)) if (!(key in client.entry)) delete entry[key];
  // Cloned, so nothing in the tree the printer walks aliases the registry's own row.
  for (const [key, value] of Object.entries(client.entry)) entry[key] = structuredClone(value);

  return { state: "merged", outcome, document: formatJsonc(opened.root, document) };
}

/**
 * Take the entry out.
 *
 * The root key stays, empty if it has to. It is the adopter's key — every one of these tools writes it
 * itself — and a disconnect that deleted it would be removing something `connect` did not add.
 */
function remove(document: string, client: McpClient): RemoveResult {
  if (saysNothing(document)) return { state: "merged", outcome: "absent", document };
  const opened = open(document, client);
  if (opened.state === "refused") return opened;
  if (opened.servers === null || opened.entry === null) {
    return { state: "merged", outcome: "absent", document };
  }
  delete opened.servers[DOCS_MCP_NAME];
  forgetComments(opened.servers, DOCS_MCP_NAME);
  return { state: "merged", outcome: "removed", document: formatJsonc(opened.root, document) };
}

/**
 * Report what the document says about us, changing nothing.
 *
 * The address is read under the key the registry says this client spells it with, so Gemini's `httpUrl`
 * is found and Claude Desktop — whose address is an argument to `npx` rather than a field — answers with
 * no URL instead of a guess. A value that is not a string is no address either: `status` says the entry
 * is there and not current, which is the honest pair of facts.
 */
function read(document: string, client: McpClient): ReadResult {
  if (saysNothing(document)) return { state: "read", entry: null };
  const opened = open(document, client);
  if (opened.state === "refused") return opened;
  if (opened.entry === null) return { state: "read", entry: null };
  const urlKey = urlKeyOf(client);
  const url = urlKey === null ? null : opened.entry[urlKey];
  return {
    state: "read",
    entry: { url: typeof url === "string" ? url : null, current: sameJson(opened.entry, client.entry) },
  };
}

/** The JSON and JSONC writer, as the registry's `format` column selects it. */
export const jsonWriter: DocumentWriter = { merge, remove, read, snippet };
