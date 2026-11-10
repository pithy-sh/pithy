// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import type { TestBinding } from "@pithy-sh/core/src/capability/testBinding";
import { type ScannedConfig, scanConfig } from "../capabilities/configImports";
import { writeFileAtomic } from "./atomic";
import { readOptionalFile } from "./readOptionalFile";
import { STARTER_TEST_BINDINGS } from "./workersTestConfig";

/**
 * A Worker's declaration of what `*.workers.test.ts` gets from `cloudflare:test`: a `Cloudflare.Env` interface
 * matching the bindings the project-root `vitest.workers.config.ts` states. Relative to the Worker's directory.
 */
export const WORKERS_TEST_ENV = join("src", "cloudflare-test.d.ts");

/** The type each binding a Workers test config can state has on `env`. A `value` binding is a secret's string. */
const ENV_TYPE: Record<Exclude<TestBinding["kind"], "unbound">, string> = {
  d1: "D1Database",
  kv: "KVNamespace",
  r2: "R2Bucket",
  ratelimit: "RateLimit",
  value: "string",
};

/** The body of `interface Env { … }`: the index of its opening brace and of the brace that closes it. */
function envInterface(scanned: ScannedConfig): { open: number; close: number } | null {
  const match = /\binterface\s+Env\s*\{/.exec(scanned.code);
  if (match === null || scanned.inLiteral[match.index]) return null;
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = open; index < scanned.code.length; index += 1) {
    if (scanned.inLiteral[index]) continue;
    const char = scanned.code[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { open, close: index };
    }
  }
  return null;
}

/** The member line declaring `name` directly in the interface body, as a match over the scanned code. */
function memberLine(scanned: ScannedConfig, body: { open: number; close: number }, name: string) {
  const pattern = new RegExp(`^[ \\t]*${name}\\??\\s*:[^;\\n]*;?[ \\t]*\\n`, "gm");
  pattern.lastIndex = body.open + 1;
  for (let match = pattern.exec(scanned.code); match !== null; match = pattern.exec(scanned.code)) {
    if (match.index >= body.close) return null;
    if (!scanned.inLiteral[match.index]) return match;
  }
  return null;
}

/**
 * Add a member to the Worker's `Cloudflare.Env` for each stated binding it does not declare yet, before the closing
 * brace and at the indent of the members above it. A declaration with no `interface Env` is left alone.
 */
export function withEnvBindings(original: string, bindings: readonly TestBinding[]): string {
  let source = original;
  for (const binding of bindings) {
    if (binding.kind === "unbound") continue;
    const scanned = scanConfig(source);
    const body = envInterface(scanned);
    if (body === null) return source;
    if (memberLine(scanned, body, binding.name) !== null) continue;
    const closeLine = source.lastIndexOf("\n", body.close) + 1;
    const braceIndent = /^[ \t]*/.exec(source.slice(closeLine))?.[0] ?? "";
    const lastMember = source.lastIndexOf("\n", closeLine - 2) + 1;
    const memberIndent =
      lastMember > body.open ? (/^[ \t]*/.exec(source.slice(lastMember))?.[0] ?? "") : `${braceIndent}  `;
    const at = closeLine > body.open ? closeLine : body.close;
    const line = `${memberIndent}${binding.name}: ${ENV_TYPE[binding.kind]};\n`;
    source = `${source.slice(0, at)}${at === body.close ? `\n${line}${braceIndent}` : line}${source.slice(at)}`;
  }
  return source;
}

/** Take the member declaring each stated binding out of the Worker's `Cloudflare.Env`, keeping the starter's own. */
export function withoutEnvBindings(original: string, bindings: readonly TestBinding[]): string {
  let source = original;
  for (const binding of bindings) {
    if (binding.kind === "unbound" || STARTER_TEST_BINDINGS.includes(binding.name)) continue;
    const scanned = scanConfig(source);
    const body = envInterface(scanned);
    if (body === null) return source;
    const line = memberLine(scanned, body, binding.name);
    if (line === null) continue;
    source = `${source.slice(0, line.index)}${source.slice(line.index + line[0].length)}`;
  }
  return source;
}

/** Declare test bindings on a Worker's `Cloudflare.Env`. A Worker with no declaration file is left alone. */
export async function writeEnvBindings(workerDir: string, bindings: readonly TestBinding[]): Promise<void> {
  const path = join(workerDir, WORKERS_TEST_ENV);
  const original = await readOptionalFile(path);
  if (original === null) return;
  const source = withEnvBindings(original, bindings);
  if (source !== original) await writeFileAtomic(path, source);
}

/** Take test bindings off a Worker's `Cloudflare.Env`. A Worker with no declaration file is left alone. */
export async function removeEnvBindings(workerDir: string, bindings: readonly TestBinding[]): Promise<void> {
  const path = join(workerDir, WORKERS_TEST_ENV);
  const original = await readOptionalFile(path);
  if (original === null) return;
  const source = withoutEnvBindings(original, bindings);
  if (source !== original) await writeFileAtomic(path, source);
}
