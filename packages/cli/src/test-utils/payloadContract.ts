// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type CommandDef, runCommand } from "citty";
import { expect, vi } from "vitest";
import { type CommandContract, contractOf, publishedEvents, publishedPayload } from "../contract/commandContract";
import { walkTree } from "../contract/describe";
import { main } from "../main";
import { withSchemaVersion } from "../terminal/schemaVersion";

/**
 * **A command's real `--json` output, held to the schema `pithy schema` publishes for it (#697).**
 *
 * `expectConforms("token mint", written)` resolves `token mint` in the real tree, reads its contract,
 * and parses every line it wrote against the published payload — the declared schema with its
 * `schemaVersion`, the same Zod value whose JSON Schema `pithy schema token mint --json` prints. So a line
 * written without the version, or at another one, fails here too. A key the command writes that a declared object does not name
 * is dropped by the parse and fails the comparison below, and a key the schema requires that the command
 * did not write fails the parse. **Not inside an open subtree**: a `z.looseObject` passes keys it does not
 * name, so there only the keys it names are checked. Those subtrees are a known gap, listed and held to
 * shrinking by `OPEN_SUBTREES` in `contract/payloadCoverage.test.ts`.
 *
 * **The path is a literal at every call site, and that is load-bearing.** `contract/payloadCoverage.test.ts`
 * scans the test sources for `expectConforms("<path>"` and fails on any command with `--json` output that
 * no test holds to its schema. A path built at runtime would be a command the scan cannot see.
 */

/** The command at `path` in the real tree, resolved. */
export async function commandAt(path: string): Promise<CommandDef> {
  const node = (await walkTree(main)).find((candidate) => candidate.path.join(" ") === path);
  if (node === undefined) throw new Error(`No command \`pithy ${path}\` in the tree.`);
  return node.cmd;
}

/** The contract the command at `path` declares. A test asking for one that is not there is a bug in the test. */
export async function contractAt(path: string): Promise<CommandContract> {
  const contract = contractOf(await commandAt(path));
  if (contract === undefined) throw new Error(`\`pithy ${path}\` declares no contract.`);
  return contract;
}

/** What a command wrote: the text, its chunks, or a function of the command's own that formats it. */
type Written = string | readonly string[];

/**
 * Parse what the command at `path` wrote to stdout against its published payload, line by line.
 *
 * A `document` command must have written exactly one line; a `stream` command at least one, each a record.
 * Each line must parse, and parse to exactly itself — a schema that dropped or rewrote a key would hand
 * back something else, and the JSON Schema published from it would describe a document nobody receives.
 *
 * **A function is run as the command runs it**: at the command's declared `schemaVersion`, which its `run`
 * installs (`withContract`). That is how a test that formats a line through one of the command's own
 * functions, rather than through its `run`, gets the line the run writes rather than one missing its version.
 */
export async function expectConforms(
  path: string,
  written: Written | (() => Written | Promise<Written>),
): Promise<void> {
  const contract = await contractAt(path);
  const payload = publishedPayload(contract);
  if (payload === undefined || contract.schemaVersion === undefined)
    throw new Error(`\`pithy ${path}\` has no --json output to conform.`);
  const output = typeof written === "function" ? await withSchemaVersion(contract.schemaVersion, written) : written;
  const text = typeof output === "string" ? output : output.join("");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (contract.output === "document") expect(lines, `pithy ${path} --json writes one line`).toHaveLength(1);
  else expect(lines.length, `pithy ${path} --json writes at least one record`).toBeGreaterThan(0);
  for (const line of lines) {
    const value: unknown = JSON.parse(line);
    const parsed = payload.safeParse(value);
    expect(parsed.error?.issues, `pithy ${path} --json: ${line}`).toBeUndefined();
    expect(parsed.data).toEqual(value);
  }
}

/**
 * Parse a `--json --events` run of the command at `path`: every line but the last is a progress record its
 * contract publishes, the last is its payload, and every line is compact — the framing `pithy dev`'s stream
 * keeps, whatever `--pretty` or `PITHY_JSON` asked for (#697). Hands back the records, parsed.
 */
export async function expectEventsConform(path: string, written: Written): Promise<unknown[]> {
  const contract = await contractAt(path);
  const events = publishedEvents(contract);
  if (events === undefined) throw new Error(`\`pithy ${path}\` takes no --events.`);
  const text = typeof written === "string" ? written : written.join("");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  expect(lines.length, `pithy ${path} --json --events closes with its document`).toBeGreaterThan(0);
  const records: unknown[] = [];
  for (const line of lines) {
    const value: unknown = JSON.parse(line);
    expect(line, `pithy ${path} --events writes compact lines`).toBe(JSON.stringify(value));
    records.push(value);
  }
  for (const line of lines.slice(0, -1)) {
    const value: unknown = JSON.parse(line);
    const parsed = events.safeParse(value);
    expect(parsed.error?.issues, `pithy ${path} --events: ${line}`).toBeUndefined();
    expect(parsed.data).toEqual(value);
  }
  await expectConforms(path, lines.at(-1) as string);
  return records;
}

/**
 * Run `work` as the command at `path` runs it: at its declared `schemaVersion`. For a test that drives a
 * command's own machinery below its `run` — a session started directly, with timers it fires itself — so
 * the lines that machinery writes are the ones the command writes.
 */
export async function asCommand<T>(path: string, work: () => Promise<T>): Promise<T> {
  const { schemaVersion } = await contractAt(path);
  if (schemaVersion === undefined) throw new Error(`\`pithy ${path}\` has no --json output to version.`);
  return withSchemaVersion(schemaVersion, work);
}

/** Everything written to stdout from here until the spy is restored, as one array of chunks. */
export function captureStdout(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

/**
 * Run the command at `path` as citty would, with `rawArgs` as typed after it, and hand back what it wrote
 * to stdout. The real definition, the real parse, the real body: whatever the test has not stubbed runs.
 */
export async function runCaptured(path: string, rawArgs: readonly string[]): Promise<string[]> {
  const cmd = await commandAt(path);
  const written = captureStdout();
  await runCommand(cmd, { rawArgs: [...rawArgs] });
  return written;
}
