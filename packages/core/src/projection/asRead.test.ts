// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { PithyError } from "../error/pithyError";
import { type AsRead, asRead, TOLERATED_MEMBER } from "./asRead";

/**
 * The reader's contract primitive, against both obligations it exists to keep apart.
 *
 * Every test here states one of two things: what a reader's view must now accept, and what it must
 * still refuse. The second half is the load-bearing one — a shape that tolerates an unknown enum member
 * by tolerating everything is not a reader's contract, it is `z.unknown()` with a docstring.
 */

/** A producer's projection with an enum on it, standing in for a capability's own response object. */
const Channel = z.enum(["email", "app"]).describe("How it arrived: `email` at an address, or `app` in the app.");

const Row = z
  .object({
    id: z.string().describe("The row's id."),
    channel: Channel.describe("How this conversation arrived."),
    linkedBy: Channel.nullable().describe("How the account was named, or null when nothing did."),
    count: z.number().int().describe("How many messages it holds."),
    at: z.iso.datetime().describe("When it last moved, ISO-8601."),
  })
  .describe("One row, as its producer states it.");

const Page = z
  .object({
    rows: z.array(Row).describe("The page, newest first."),
    nextCursor: z.string().nullable().describe("Where the next page resumes, or null."),
  })
  .describe("A page of rows.");

/** The reader's view of {@link Row}, named so a type-level assertion can be written against it. */
type AsReadRow = AsRead<typeof Row>;

/** One row of the fixture, with `channel` swappable — every other field the shape a producer sends. */
function row(channel: string, linkedBy: string | null = "email"): Record<string, unknown> {
  return { id: "r-1", channel, linkedBy, count: 3, at: "2026-06-10T12:00:00.000Z" };
}

describe("asRead — a reader's contract beside the producer's", () => {
  test("the producer's schema still refuses a member it does not declare", () => {
    expect(Row.safeParse(row("sms")).success).toBe(false);
    expect(Row.safeParse(row("email", "oauth")).success).toBe(false);
    // The producer's own object is untouched by having a reader's view derived from it.
    asRead(Row);
    expect(Row.safeParse(row("sms")).success).toBe(false);
  });

  test("the reader's tolerates it, and hands the token back verbatim so a client can mark it", () => {
    const parsed = asRead(Row).parse(row("sms", "oauth"));
    expect(parsed.channel).toBe("sms");
    expect(parsed.linkedBy).toBe("oauth");
    // Marked, not mapped: the enum is still the authority on what the value means, and it says no.
    expect(Channel.safeParse(parsed.channel).success).toBe(false);
  });

  /**
   * The same obligation at the type level, and it is a separate one.
   *
   * A rewrite that returned the producer's *type* while parsing tolerantly would compile every client
   * into the old narrow union — so `thread.channel` would still be `"email" | "app"`, and the first
   * `switch` over it would be exhaustive over a set the value is no longer drawn from. This assignment
   * does not compile unless the widened field really is a `string`, and `tsc` is a gate here because
   * `tsconfig.json` includes the tests.
   */
  test("the widened field is a string at the type level too, not only at parse time", () => {
    const parsed: z.output<AsReadRow> = asRead(Row).parse(row("sms", "oauth"));
    const stated: z.output<AsReadRow> = {
      id: "r-1",
      channel: "sms",
      linkedBy: "oauth",
      count: 3,
      at: "2026-06-10T12:00:00.000Z",
    };
    expect(parsed.channel).toBe(stated.channel);
  });

  test("a member the enum does declare reads as itself, unchanged", () => {
    expect(asRead(Row).parse(row("email", null))).toEqual(row("email", null));
  });

  test("a malformed response still fails under the reader's shape", () => {
    const Reader = asRead(Page);
    expect(Reader.safeParse("not an object").success).toBe(false);
    expect(Reader.safeParse({ rows: "nope", nextCursor: null }).success).toBe(false);
    expect(Reader.safeParse({ rows: [{ id: "r-1", channel: "sms" }], nextCursor: null }).success).toBe(false);
    expect(Reader.safeParse({ rows: [{ ...row("sms"), count: "three" }], nextCursor: null }).success).toBe(false);
    expect(Reader.safeParse({ rows: [{ ...row("sms"), at: "yesterday" }], nextCursor: null }).success).toBe(false);
    expect(Reader.safeParse({ rows: [row("sms")], nextCursor: 7 }).success).toBe(false);
    // A non-string where the enum was is not "an unknown member". Widened is still typed.
    expect(Reader.safeParse({ rows: [row2({ channel: 7 })], nextCursor: null }).success).toBe(false);
    expect(Reader.safeParse({ rows: [row2({ channel: null })], nextCursor: null }).success).toBe(false);
  });

  test("every field with no enum under it is the identical schema instance", () => {
    const Reader = asRead(Row);
    expect(Reader.shape.id).toBe(Row.shape.id);
    expect(Reader.shape.count).toBe(Row.shape.count);
    expect(Reader.shape.at).toBe(Row.shape.at);
    // And the two that carry one are not.
    expect(Reader.shape.channel).not.toBe(Row.shape.channel);
    expect(Reader.shape.linkedBy).not.toBe(Row.shape.linkedBy);
    // Through an array and a nested object, too.
    expect(asRead(Page).shape.nextCursor).toBe(Page.shape.nextCursor);
  });

  test("an object holding no enum anywhere comes back as itself, not a copy", () => {
    const Plain = z.object({ id: z.string().describe("An id.") }).describe("No enum in here.");
    expect(asRead(Plain)).toBe(Plain);
    expect(asRead(z.object({ plain: Plain }).describe("Nesting."))).toBeDefined();
  });

  test("descriptions survive, and a widened field says what it now permits", () => {
    const Reader = asRead(Row);
    expect(Reader.description).toBe(Row.description);
    expect(Reader.shape.channel.description).toBe(`How this conversation arrived. ${TOLERATED_MEMBER}`);
    // The wrapper keeps its own sentence; the widened member carries the enum's.
    expect(Reader.shape.linkedBy.description).toBe(Row.shape.linkedBy.description);
    const inner = (Reader.shape.linkedBy as z.ZodNullable<z.ZodString>).unwrap();
    expect(inner.description).toBe(`${Channel.description} ${TOLERATED_MEMBER}`);
  });

  test("it reaches an enum through arrays, nested objects and wrappers", () => {
    const Deep = z
      .object({
        rows: z.array(Row).describe("Rows."),
        one: Row.nullable().describe("One row, or null."),
        maybe: z.array(Channel).optional().describe("Some channels."),
      })
      .describe("Deep.");
    const parsed = asRead(Deep).parse({ rows: [row("sms")], one: row("carrier-pigeon"), maybe: ["telex"] });
    expect(parsed.rows[0]?.channel).toBe("sms");
    expect(parsed.one?.channel).toBe("carrier-pigeon");
    expect(parsed.maybe).toEqual(["telex"]);
  });

  /**
   * The kinds it cannot see through, which it refuses rather than passes.
   *
   * A pattern that silently returned a schema it had not rewritten would publish a reader's contract
   * that still refuses an unknown member — the exact failure this exists to end, now with a name that
   * says it was handled. So an unnameable case throws at construction, where a test and a build see it.
   */
  test("it throws on a schema kind it cannot rewrite, rather than passing it through", () => {
    expect(() => asRead(z.object({ u: z.union([Channel, z.string()]).describe("A union.") }).describe("U."))).toThrow(
      PithyError,
    );
    expect(() => asRead(z.object({ r: z.record(z.string(), Channel).describe("A record.") }).describe("R."))).toThrow(
      PithyError,
    );
    expect(() => asRead(z.object({ t: z.tuple([Channel]).describe("A tuple.") }).describe("T."))).toThrow(PithyError);
    expect(() => asRead(z.object({ c: Channel.catch("email").describe("A catch.") }).describe("C."))).toThrow(
      PithyError,
    );
    // A discriminated union is the sharpest one: rewriting its discriminant would destroy the union.
    const Either = z
      .discriminatedUnion("channel", [
        z.object({ channel: z.literal("email").describe("Mail.") }).describe("Mail arm."),
        z.object({ channel: z.literal("app").describe("App.") }).describe("App arm."),
      ])
      .describe("Either.");
    expect(() => asRead(z.object({ sent: Either }).describe("S."))).toThrow(PithyError);
  });

  test("it refuses to rewrite an object whose unknown-key rule it would change", () => {
    const Strict = z.strictObject({ channel: Channel.describe("How it arrived.") }).describe("Closed.");
    expect(() => asRead(Strict)).toThrow(PithyError);
    // A strict object with no enum under it is returned untouched, so it keeps refusing unknown keys.
    const StrictPlain = z.strictObject({ id: z.string().describe("An id.") }).describe("Closed, and enum-free.");
    expect(asRead(StrictPlain)).toBe(StrictPlain);
    expect(asRead(StrictPlain).safeParse({ id: "r-1", extra: true }).success).toBe(false);
  });

  test("the failure names the path and not the value read from a stranger", () => {
    const nested = z.object({ u: z.union([Channel, z.string()]).describe("U.") }).describe("N.");
    let thrown: unknown;
    try {
      asRead(z.object({ nested }).describe("Top."));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).message).not.toContain("email");
    expect((thrown as PithyError).payload.detail).toContain("response.nested.u");
  });
});

/** A row with fields overridden, for the shapes a fixture helper cannot express. */
function row2(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...row("email"), ...overrides };
}
