// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { CommandDef } from "citty";
import { z } from "zod";
import { withSchemaVersion } from "../terminal/schemaVersion";

/**
 * **What a command promises a caller, declared beside the command (#697).**
 *
 * citty's `args` say what a command parses. They cannot say what it writes, whether it changes anything,
 * whether running it twice is safe, or which flags only make sense together — and an agent driving the CLI
 * needs every one of those before it runs anything. So each leaf command carries a contract, and
 * `pithy schema` publishes the two halves as one document: the parser's facts read off `args`, and these.
 *
 * **Attached to the command object, not kept in a list beside the tree.** A list of command paths is a
 * second copy of the tree, and it drifts the way the help groups would have (`main.ts`). The contract
 * rides on a symbol-keyed property instead: object spread copies own symbol keys, so it survives
 * `ownNamesOnly`'s `{ ...cmd, subCommands }` copy on the way to citty, where a `WeakMap` keyed on the
 * original object would not. It is not a field of `meta` or of an arg, because citty owns those shapes
 * and TypeScript's excess-property check would refuse an unknown key in either.
 *
 * **One payload schema per command is the registry `schemaVersion` hangs on.** The version belongs to the
 * payload it describes, so it is a field of this contract, `pithy schema` publishes it from here like
 * everything else, and the command's `run` is wrapped so every line it formats is stamped with it
 * (`terminal/schemaVersion.ts`). `payloadShapes.generated.json` holds each payload's keys at its version,
 * and `payloadShapes.test.ts` fails a key removed or retyped without a bump.
 */

/** How a command answers `--json`. */
export const JsonOutput = z
  .enum(["document", "stream", "none"])
  .describe(
    "How the command answers `--json`: `document` is one JSON line on stdout, `stream` is one JSON record per line for as long as it runs, `none` is no `--json` output at all.",
  );
export type JsonOutput = z.infer<typeof JsonOutput>;

/**
 * A rule over several flags that citty cannot express, published so a caller can build a valid call
 * without trial and error. Each kind is enforced by the command's own validator, and `contract.test.ts`
 * holds every declared group to a refusal.
 */
export const FlagGroup = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("exactlyOne").describe("Exactly one of `flags` must be passed."),
        flags: z.array(z.string().describe("A flag, as typed.")).min(2).describe("The flags in the group."),
        rule: z.string().describe("The rule in a sentence."),
      })
      .describe("Exactly one of these flags is required."),
    z
      .object({
        kind: z.literal("atMostOne").describe("No more than one of `flags` may be passed."),
        flags: z.array(z.string().describe("A flag, as typed.")).min(2).describe("The flags in the group."),
        rule: z.string().describe("The rule in a sentence."),
      })
      .describe("These flags exclude one another."),
    z
      .object({
        kind: z.literal("allOrNone").describe("Pass every one of `flags`, or none of them."),
        flags: z.array(z.string().describe("A flag, as typed.")).min(2).describe("The flags in the group."),
        rule: z.string().describe("The rule in a sentence."),
      })
      .describe("These flags only work together."),
    z
      .object({
        kind: z.literal("requires").describe("`flag` needs `needs` alongside it."),
        flag: z.string().describe("The flag that carries the requirement, as typed."),
        needs: z.array(z.string().describe("A flag, as typed.")).min(1).describe("The flags it needs."),
        any: z
          .boolean()
          .describe("`true` when any one of `needs` is enough; `false` when every one of them is required."),
        rule: z.string().describe("The rule in a sentence."),
      })
      .describe("One flag that is refused unless another is passed with it."),
  ])
  .describe("A rule over several flags, enforced before the command does anything.");
export type FlagGroup = z.infer<typeof FlagGroup>;

/**
 * What citty's arg definition cannot carry about one argument: its fixed set of values, and whether it
 * repeats. Keyed by the arg's declared name, so a positional takes an `enum` the same way a flag does.
 */
export interface FlagFacts {
  /** Every value it takes, when the set is fixed. Checked in the command's own code, not by citty. */
  readonly enum?: readonly string[];
  /** The flag may be passed more than once, and every occurrence counts. */
  readonly repeatable?: boolean;
  /**
   * A positional that takes every remaining word, not one: `pithy schema token mint`. Only the last
   * positional can, because citty hands every word past it to `args._`. `--help` marks it `[NAME…]`
   * (`help/commandUsage.ts`), and `payloadCoverage.test.ts` holds it to the last positional.
   */
  readonly variadic?: boolean;
}

/** One command's promise to its caller. */
export interface CommandContract {
  /** How the command answers `--json`. */
  readonly output: JsonOutput;
  /**
   * The `--json` payload: the one document, or — for a stream — any one record of it. Plain Zod, no
   * codec and no transform, so its JSON Schema is exact and parsing real output hands back what went in.
   * Absent only when `output` is `none`.
   */
  readonly payload?: z.ZodType;
  /**
   * The version of `payload`'s shape: an integer from `1`, bumped only when a key is removed or retyped.
   * Every line the command writes carries it as `schemaVersion`. Present exactly when `payload` is.
   */
  readonly schemaVersion?: number;
  /**
   * One `--events` progress record, for a command that streams its progress before the payload closes the
   * stream (`deploy`, `provision`). At the same `schemaVersion` as the payload.
   */
  readonly events?: z.ZodType;
  /**
   * Whether a successful run can change anything: a file, a Cloudflare resource, a database, a store.
   *
   * **It describes the default run** — the command with its required arguments and no optional flag. A
   * flag that makes a read write (`doctor --disable-notifier`) or a write read (`--dry-run`, `ui sync
   * --check`) says so in its own description; a contract that counted every flag would publish `true` for
   * nearly everything and tell a caller nothing. The CLI's own bookkeeping under its config directory — the
   * update-notifier cache any command may refresh — is not a change to anything the caller owns.
   */
  readonly mutates: boolean;
  /**
   * Whether running it again with the same arguments, after it succeeded, succeeds and changes nothing
   * further. A second run that is refused is not idempotent, however clean the refusal: a caller retrying a
   * step reads `true` as "safe to run again". The default run, as `mutates` is. `contract/idempotent.test.ts`
   * re-runs every command it can drive offline and holds this to what the second run did.
   */
  readonly idempotent: boolean;
  /** Whether it can reach the network: Cloudflare, npm, the browser flow. */
  readonly needsNetwork: boolean;
  /** Per-flag facts, keyed by the arg name as declared. `contract.test.ts` holds every key to a real arg. */
  readonly flags?: Readonly<Record<string, FlagFacts>>;
  /** Rules over several flags. */
  readonly flagGroups?: readonly FlagGroup[];
}

/** Where a command keeps its contract. `Symbol.for`, so a second copy of this module still finds it. */
const CONTRACT: unique symbol = Symbol.for("pithy.commandContract") as never;

type Contracted = { [CONTRACT]?: CommandContract };

/** The one shape a contract can be wrong in, as the sentence that says how — or `undefined` when it is right. */
function contractFault(contract: CommandContract): string | undefined {
  if ((contract.output === "none") !== (contract.payload === undefined)) {
    return contract.output === "none"
      ? "A command with no --json output declares no payload."
      : "A command with --json output declares its payload.";
  }
  if ((contract.payload === undefined) !== (contract.schemaVersion === undefined)) {
    return contract.payload === undefined
      ? "A command with no payload declares no schemaVersion."
      : "A command with a payload declares its schemaVersion.";
  }
  if (contract.schemaVersion !== undefined && !(Number.isInteger(contract.schemaVersion) && contract.schemaVersion > 0))
    return "A schemaVersion is an integer from 1.";
  if (contract.events !== undefined && contract.payload === undefined)
    return "A command declares progress records only beside the payload that closes them.";
  return undefined;
}

/**
 * Attach `contract` to `command` and hand the same command back, so a definition stays one expression:
 * `const mint = withContract(defineCommand({ … }), { output: "document", schemaVersion: 1, payload: TokenMintPayload, … })`.
 *
 * A contract claiming a payload it does not have, a payload under `output: "none"`, or a payload with no
 * version, is a bug in the declaration, and it fails here, when the module loads, rather than in whoever
 * reads it later.
 *
 * **And the command's `run` is wrapped to run at its version**, so every line it formats carries
 * `schemaVersion` with no call site writing it (`terminal/schemaVersion.ts`).
 */
export function withContract<C extends object>(command: C, contract: CommandContract): C {
  const fault = contractFault(contract);
  if (fault !== undefined) throw new InternalError({ message: fault });
  const { schemaVersion } = contract;
  const runnable = command as { run?: (context: never) => unknown };
  const run = runnable.run;
  if (schemaVersion !== undefined && typeof run === "function") {
    runnable.run = (context: never) => withSchemaVersion(schemaVersion, () => run(context));
  }
  Object.defineProperty(command, CONTRACT, { value: contract, enumerable: true });
  return command;
}

/** The contract attached to `command`, or `undefined` when it has none — a group, or a missing declaration. */
export function contractOf(command: CommandDef | object): CommandContract | undefined {
  return (command as Contracted)[CONTRACT];
}

/** The key every published payload and record gains: the version its command declares. */
function versionKey(schemaVersion: number) {
  return z
    .literal(schemaVersion)
    .describe(
      "The version of this payload's shape. It changes only when a key is removed or retyped; an added key leaves it.",
    );
}

/**
 * `schema` with `schemaVersion` added to every object it can be: the object itself, or each member of a union
 * of them. The rebuilt schema is a new instance, so the description is carried across by hand.
 */
function versioned(schema: z.ZodType, schemaVersion: number): z.ZodType {
  const description = schema.description ?? "";
  if (schema instanceof z.ZodObject)
    return schema.extend({ schemaVersion: versionKey(schemaVersion) }).describe(description);
  if (schema instanceof z.ZodUnion) {
    const options = schema.options.map((option) => versioned(option as z.ZodType, schemaVersion));
    return z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]).describe(description);
  }
  throw new InternalError({
    message: "A payload is an object, or a union of objects, so it can carry its schemaVersion.",
  });
}

/** Versioned schemas, built once per contract. A contract is frozen at load, so the cache cannot go stale. */
const PUBLISHED = new WeakMap<CommandContract, { payload?: z.ZodType; events?: z.ZodType }>();

/** Both versioned halves of `contract`, built on first ask. */
function published(contract: CommandContract): { payload?: z.ZodType; events?: z.ZodType } {
  const cached = PUBLISHED.get(contract);
  if (cached !== undefined) return cached;
  const { payload, events, schemaVersion } = contract;
  const built =
    schemaVersion === undefined
      ? {}
      : {
          ...(payload !== undefined ? { payload: versioned(payload, schemaVersion) } : {}),
          ...(events !== undefined ? { events: versioned(events, schemaVersion) } : {}),
        };
  PUBLISHED.set(contract, built);
  return built;
}

/**
 * The payload as a line actually carries it: the declared schema with `schemaVersion` as a literal on every
 * object. What `pithy schema` publishes and what the tests parse real output against. `undefined` for a
 * command with no `--json` output.
 */
export function publishedPayload(contract: CommandContract): z.ZodType | undefined {
  return published(contract).payload;
}

/** One `--events` record as the stream carries it, versioned the same way. `undefined` without `--events`. */
export function publishedEvents(contract: CommandContract): z.ZodType | undefined {
  return published(contract).events;
}
