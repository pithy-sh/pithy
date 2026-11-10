// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { VECTOR_PROVISIONED_VAR as VECTOR_OWN } from "@pithy-sh/vector/src/index/provisioned";
import { parse, stringify } from "comment-json";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "../ci/sourceFiles";
import {
  PER_ENVIRONMENT_VARS,
  removeStanzaVar,
  setStanzaVar,
  stanzaVarsOf,
  VECTOR_PROVISIONED_VAR,
} from "./stanzaVars";

describe("setStanzaVar", () => {
  test("creates the vars block a stanza lacks", () => {
    const stanza: Record<string, unknown> = {};
    expect(setStanzaVar(stanza, "BASE_URL", "https://api.example.com")).toBe(true);
    expect(stanza).toEqual({ vars: { BASE_URL: "https://api.example.com" } });
  });

  test("says nothing changed when the stanza already holds the value", () => {
    const stanza = { vars: { LIMIT: { max: 3 } } };
    expect(setStanzaVar(stanza, "LIMIT", { max: 3 })).toBe(false);
  });

  test("overwrites a different value in place, keeping the block's comments", () => {
    const stanza = parse('{ "vars": {\n  // why\n  "MODE": "live"\n} }') as Record<string, unknown>;
    expect(setStanzaVar(stanza, "MODE", "replay")).toBe(true);
    expect(stringify(stanza, null, 2)).toContain("// why");
    expect(stanzaVarsOf(stanza)).toEqual({ MODE: "replay" });
  });
});

describe("removeStanzaVar", () => {
  test("removes a var and says so", () => {
    const stanza = { vars: { A: "1", B: "2" } };
    expect(removeStanzaVar(stanza, "A")).toBe(true);
    expect(stanza).toEqual({ vars: { B: "2" } });
  });

  test("finds no var by a name every object answers to", () => {
    const stanza = { vars: { A: "1" } };
    expect(removeStanzaVar(stanza, "toString")).toBe(false);
  });

  test("leaves a stanza without the var alone", () => {
    const stanza: Record<string, unknown> = {};
    expect(removeStanzaVar(stanza, "A")).toBe(false);
    expect(stanza).toEqual({});
  });
});

describe("PER_ENVIRONMENT_VARS", () => {
  test("names the var pithy vector provision writes by the name the vector package reads", () => {
    expect(VECTOR_PROVISIONED_VAR).toBe(VECTOR_OWN);
    expect(PER_ENVIRONMENT_VARS.has(VECTOR_OWN)).toBe(true);
  });

  test("gives ENVIRONMENT each stanza's own name, and leaves BASE_URL to the command that writes it", () => {
    expect(PER_ENVIRONMENT_VARS.get("ENVIRONMENT")?.("staging")).toBe("staging");
    expect(PER_ENVIRONMENT_VARS.get("BASE_URL")).toBeNull();
  });
});

describe("stanzaVarsOf", () => {
  test("is null for a stanza with no vars object", () => {
    expect(stanzaVarsOf({})).toBeNull();
    expect(stanzaVarsOf({ vars: null })).toBeNull();
    expect(stanzaVarsOf({ vars: ["A"] })).toBeNull();
  });
});

/**
 * **Every var the CLI writes into a `wrangler.jsonc` goes through `project/stanzaVars.ts`.** A write to a stanza's
 * `vars` anywhere else fails here: an assignment to `.vars` or `["vars"]`, to a key under it, a `delete` of the
 * block or of one key, an `Object.assign` into it, the same through a local holding a stanza's `vars`, an object
 * literal that builds a `vars` block (`vars: { … }`, `vars: { ...stanza.vars, X }`, `vars: structuredClone(…)`),
 * a `"vars": {` block written as `wrangler.jsonc` text, which opens a line of a template, and a text replace of a
 * `"NAME": value` line, a var being an upper-case key where every wrangler key is lower case. A quoted `"vars"` key in
 * code is not looked for: Biome writes an object key unquoted wherever it can be.
 */

const CLI_SRC = join(import.meta.dirname, "..");

const WRITER = "project/stanzaVars.ts";

const DIRECT_WRITES = [
  /\.vars\s*(?:\?\?|\|\|)?=(?!=)/,
  /\[\s*["'`]vars["'`]\s*\]\s*(?:\?\?|\|\|)?=(?!=)/,
  /\.vars(?:\?\.|\.)?(?:\.\w+|\[[^\]]+\])\s*=(?!=)/,
  /\bdelete\s+[\w.?]*(?:\.vars\b|\[\s*["'`]vars["'`]\s*\])/,
  /\bObject\.assign\s*\(\s*[\w.?!]*(?:\.vars\b|\[\s*["'`]vars["'`]\s*\])/,
  /(?<![\w-])vars\s*:\s*(?:\{|\.\.\.|structuredClone\b|Object\.)/,
  /"vars"\s*:\s*\{\s*(?:$|`)/,
  /\.replace(?:All)?\s*\(\s*["'`/]\\?"[A-Z][A-Z0-9_]*\\?"\s*:/,
];

/** The writes to a stanza's `vars` one module's code holds, by the line each is on. */
function varWrites(code: string): string[] {
  const found = new Set<string>();
  const lines = code.split("\n");
  const aliases = new Set<string>();
  for (const line of lines) {
    const alias = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=[^;]*\.vars\b(?!\s*\()/.exec(line);
    if (alias?.[1] !== undefined) aliases.add(alias[1]);
  }
  for (const line of lines) {
    if (DIRECT_WRITES.some((pattern) => pattern.test(line))) found.add(line.trim());
    for (const name of aliases) {
      const through = new RegExp(
        `(?:\\bdelete\\s+${name}\\s*(?:\\.|\\[))|(?:\\b${name}(?:\\.\\w+|\\[[^\\]]+\\])\\s*=(?!=))|(?:\\bObject\\.assign\\s*\\(\\s*${name}\\b)`,
      );
      if (through.test(line)) found.add(line.trim());
    }
  }
  return [...found];
}

describe("varWrites", () => {
  test.each([
    ["stanza.vars ??= {};"],
    ["stanza.vars.BASE_URL = url;"],
    ["stanza.vars[BASE_URL_VAR] = url;"],
    ["if (stanza.vars?.WORKER !== undefined) stanza.vars.WORKER = to;"],
    ["if (stanza.vars) delete stanza.vars[BASE_URL_VAR];"],
    ["const vars = (stanza as Shape).vars;\nfor (const name of names) delete vars[name];"],
    ["const vars = asRecord(seeded.vars);\nif (vars !== null) vars[ENVIRONMENT_VAR] = env;"],
    ["delete stanza.vars;"],
    ['stanza["vars"] = {};'],
    ["Object.assign(stanza.vars, { NEW_VAR: x });"],
    ["const vars = stanza.vars;\nObject.assign(vars, extra);"],
    ["config.env[env] = { ...stanza, vars: { ...stanza.vars, NEW_VAR: x } };"],
    ["vars: { ENVIRONMENT: environment, PROJECT: identity.project, WORKER: identity.worker },"],
    ["return { ...config, vars: structuredClone(config.vars) };"],
    ['`      "vars": {`,'],
    ['  "vars": {'],
    ['.replaceAll(\'"PROJECT": "pithy-app"\', () => stamp)'],
    ['.replace(`"WORKER": "api"`, () => stamp);'],
    ['text.replace(/"BASE_URL":\\s*"[^"]*"/, url);'],
  ])("finds %s", (code) => {
    expect(varWrites(code)).not.toEqual([]);
  });

  test.each([
    ["const current = stamped.vars?.[DEPLOY_STAMP_VAR];"],
    ["if (stanza.vars === undefined) return;"],
    ["setStanzaVar(stanza, BASE_URL_VAR, url);"],
    ["const { vars: _dev, ...carried } = repeated;"],
    ["vars?: Record<string, string>;"],
    ['case "dev-vars": {'],
    ['its dev value belongs in the file, as { "vars": { "KEY": "<value>" } }, chmod 600.`;'],
    ['.replace(\'"name": "pithy-app"\', () => stamp)'],
  ])("leaves a read alone: %s", (code) => {
    expect(varWrites(code)).toEqual([]);
  });
});

describe("var writers", () => {
  const posix = (path: string) => path.split(sep).join("/");
  const modules = sourceFiles(CLI_SRC)
    .map(({ path, text }) => ({ path: posix(relative(CLI_SRC, path)), code: blankComments(text) }))
    .filter(({ path }) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.startsWith("test-utils/"));

  test("no module writes a stanza's vars but the one writer", () => {
    const writes = modules
      .filter(({ path }) => path !== WRITER)
      .flatMap(({ path, code }) => varWrites(code).map((line) => `${path}: ${line}`));
    expect(writes).toEqual([]);
  });
});
