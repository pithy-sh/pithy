// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as manual from "./manual";

/**
 * The gate #305 asked for: a build failure when a **new unchecked producer** of a held entitlement appears.
 *
 * The defect this closes is the shape four defect classes in this kit have each had three or more producers
 * of — the unresolvable dependency range, the `.dev.vars` file mode, the symlink escape, publishing ignored
 * files. Every one because a rule lived at a *call site* instead of at the thing being called. The catalog
 * check lived in `POST /payments/entitlements/grant`; the function that writes the row had none and was
 * exported. This was that shape caught on the first producer.
 *
 * ## What the first version of this gate could not see (#328)
 *
 * It classified by literal syntax, per file. `/\.(insertInto|updateTable|replaceInto)\(PAYMENTS_ENTITLEMENTS_TABLE\)/`
 * decided which modules the invariant covered, and the account was a whole-file regex. Three escapes were
 * reproduced against it, and each is planted below so the replacement is watched refusing them on every run:
 *
 * 1. **Raw SQL.** `d1.prepare("insert into pithy_payments_entitlements …")` names the table under its other
 *    spelling and no builder method at all. Invisible.
 * 2. **A verb outside the list.** `d1SeedGroup("app", PAYMENTS_ENTITLEMENTS_TABLE, …)` writes rows through
 *    the seed runner and is not a Kysely call. `src/seeds/example.ts` really does this, today, and was never
 *    once examined by the gate whose whole job is to examine writers.
 * 3. **Per-file classification.** A file holding one accounted write and one unaccounted write passed,
 *    because the account was matched anywhere in the file rather than at the write.
 *
 * ## So detection names no verb vocabulary at all
 *
 * A **site** is any mention of the table, under either spelling, in code rather than in a comment, located to
 * the top-level declaration holding it. Nothing can be renamed, re-spelled or re-verbed out of view, because
 * there is nothing to evade: the table is either named or it is not. The census below then says what each
 * site is and why it is allowed to be there, and the gate fails on a site the census does not name **and** on
 * a census entry no site matches — so it cannot rot in either direction.
 *
 * The cost is that reads are sites too, and the census lists them. That is the cheap half of the trade: a new
 * reader failing this gate is asked a question worth being asked, and a reader cannot be mistaken for a writer
 * because each entry states which it is and the writers' accounts are re-checked against their own text.
 *
 * ## The residue, plainly
 *
 * Four things this cannot see. None of them can arrive quietly:
 *
 * - **A table name assembled at runtime** (`"pithy_payments_" + kind`). Nothing here builds one, and the
 *   census makes a first instance conspicuous rather than absorbing it.
 * - **A write from outside this package's `src/`** — an adopter's own handler. No test in this package can
 *   gate that; `grantEntitlement`'s signature is the rule for it, which is the point of the split below.
 * - **A trigger or a view** reaching the table from SQL authored in `migrations/`, where a reviewer is
 *   already reading SQL.
 * - **Which rows a write touches.** An account is a property of the declaration's text, so it says a writer
 *   clears the hold or refuses held rows; it does not prove the predicate is right. That is what
 *   `manual.workers.test.ts` and the projection's own suites are for.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

/** The table, as Kysely names it — the constant every builder call is handed. */
const TABLE_CONSTANT = "PAYMENTS_ENTITLEMENTS_TABLE";

/** The table, as SQLite names it — the spelling any raw statement must use. */
const TABLE_PHYSICAL = "pithy_payments_entitlements";

/** Everything before the first top-level declaration, and anything at file scope. */
const MODULE_SCOPE = "(module)";

/** A source file as this walk reads it. Separated from the filesystem so a case can plant one. */
interface SourceFile {
  path: string;
  text: string;
}

/** One place the entitlements table is named, and the declaration it sits in. */
interface TableSite {
  path: string;
  /**
   * The top-level declaration holding the mention, or `(module)` for imports and re-exports. This is what
   * makes the gate per **site**: two mentions in one file are two sites, and an account matched in one
   * declaration says nothing about the other.
   */
  declaration: string;
  /** Whether that declaration is exported — the property `manual.ts`'s split turns on. */
  exported: boolean;
  /** The declaration's own source, comments removed. What an account is checked against. */
  text: string;
}

/**
 * Every non-test source file in this package, as `{ path, text }`, `path` relative to `src/`.
 *
 * `readdirSync`'s own `recursive` rather than a traversal written here: `packages/cli/src/ci/sourceFiles.ts`
 * is this repository's one walk and refuses the next private copy of itself, but it lives in `@pithy-sh/cli`
 * and a capability package taking a dev dependency on the CLI to read its own `src/` would invert the
 * dependency graph to reach a directory listing. The platform's recursion is the honest third answer: no
 * self-call to get wrong, and it does not descend a symlinked directory either. The question here is one
 * package's own source, which is a still tree — none of the scaffolds and second checkouts that walk exists
 * to tolerate can appear under it.
 */
function sources(): SourceFile[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return { path: relative(SRC, absolute).split(sep).join("/"), text: readFileSync(absolute, "utf8") };
    });
}

/**
 * Strip comments, keeping string and template literals whole.
 *
 * A hunt for a table name through raw text finds every doc comment mentioning it, and a rule nobody can read
 * without exceptions is a rule that grows exceptions. A scanner rather than a regex because `"https://x"`
 * holds `//` and a comment opener can sit inside a string: a regex getting either wrong would swallow the
 * code after it, which is this gate going quiet — the exact failure the file is about.
 */
function withoutComments(source: string): string {
  let out = "";
  let index = 0;
  // The previous meaningful character, which is how a regex literal is told from a division.
  let previous = "";
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      // A comment is whitespace to a tokenizer; joining the halves would fuse two identifiers.
      out += " ";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const literal = readDelimited(source, index, char);
      out += literal;
      index += literal.length;
      previous = char;
      continue;
    }
    if (char === "/" && startsRegex(previous)) {
      const literal = readDelimited(source, index, "/");
      out += literal;
      index += literal.length;
      previous = "/";
      continue;
    }
    out += char;
    if (char.trim() !== "") previous = char;
    index += 1;
  }
  return out;
}

/** Read a `"`, `'`, backtick or `/` delimited literal whole, escapes included. */
function readDelimited(source: string, start: number, delimiter: string): string {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === delimiter) return source.slice(start, index + 1);
    index += 1;
  }
  return source.slice(start);
}

/** After these a `/` opens a regex rather than dividing. */
function startsRegex(previous: string): boolean {
  return previous === "" || "(,=:[!&|?{};+-*%~^<>".includes(previous);
}

/** The head of a top-level declaration: `export const x`, `async function y`, `class Z`. */
const DECLARATION =
  /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|enum|type|interface)\s+([A-Za-z_$][\w$]*)/;

/**
 * Split one file into its top-level declarations, comments already gone.
 *
 * Line-anchored, which is what Biome guarantees for this repository: a top-level declaration starts at column
 * zero and a nested one never does. Formatting that broke the rule would put a nested function into the
 * census as a site of its own — a loud failure, not a hidden one.
 */
function declarationsOf(file: SourceFile): { declaration: string; exported: boolean; text: string }[] {
  const regions = [{ declaration: MODULE_SCOPE, exported: false, lines: [] as string[] }];
  for (const line of withoutComments(file.text).split("\n")) {
    const head = DECLARATION.exec(line);
    if (head) regions.push({ declaration: head[2] as string, exported: head[1] !== undefined, lines: [] });
    (regions[regions.length - 1] as { lines: string[] }).lines.push(line);
  }
  return regions.map((region) => ({ ...region, text: region.lines.join("\n") }));
}

/** Every declaration in `files` that names the entitlements table, under either spelling. */
function tableSites(files: readonly SourceFile[]): TableSite[] {
  const sites: TableSite[] = [];
  for (const file of files) {
    for (const region of declarationsOf(file)) {
      if (!region.text.includes(TABLE_CONSTANT) && !region.text.includes(TABLE_PHYSICAL)) continue;
      sites.push({ path: file.path, declaration: region.declaration, exported: region.exported, text: region.text });
    }
  }
  return sites;
}

/** A site's address, as the census writes it. */
function addressOf(site: { path: string; declaration: string }): string {
  return `${site.path} :: ${site.declaration}`;
}

/**
 * What a declaration that changes rows in this table is allowed to be. Each is a **property of the text**,
 * re-checked on every run, so deleting a guard fails the gate even though the census still names the site.
 */
const ACCOUNTS = {
  /** Creates the row cleared and unheld — nothing it writes grants anything. `manual` is written off. */
  "holds-nothing": /manual:\s*(?:0|false)\b/,
  /** Touches only rows the hold is off on, so a comp is out of its reach whatever it computes. */
  "refuses-held-rows": /"manual",\s*"=",\s*0/,
  /**
   * Consults the grantable set before writing: a key this project does not define is refused.
   *
   * No site carries this today, and that is the design rather than an omission — `grantEntitlement` never
   * names the table, it calls the primitive. It is kept because it is the account a checked write would be
   * declared under, and it is exercised by the planted per-declaration case below.
   */
  "consults-the-catalog": /grantableEntitlements/,
  /** Fixture rows, written unheld by the seed runner — the same property as `holds-nothing`, declared. */
  "seeds-unheld-rows": /manual:\s*(?:0|false)\b/,
  /**
   * The unchecked primitive, legitimate **only** because it is unexported: a caller outside the module
   * cannot reach it, and the two exports that can are gated by their signatures. `exported` is asserted
   * false for this account below, so exporting it fails here rather than in somebody's entitlement table.
   */
  "unexported-primitive": /^/,
} as const;

type Account = keyof typeof ACCOUNTS;

/**
 * Every place this package names `pithy_payments_entitlements`, and what each one is.
 *
 * A **roster of sites, not of callers.** The objection to listing today's callers is that a new one arrives
 * without anybody remembering the list; here a new one *fails the gate*, and the failure carries the address
 * to add and the question to answer with it. Removing a site fails it too, so the census cannot drift into
 * describing a package that no longer exists.
 */
const CENSUS: { address: string; writes: false | Account }[] = [
  // Declarations and re-exports: the table's name, its schema, and the maps Kysely resolves it through.
  { address: "index.ts :: (module)", writes: false },
  { address: "data/entitlement.ts :: PaymentsEntitlement", writes: false },
  { address: "data/tables.ts :: PAYMENTS_ENTITLEMENTS_TABLE", writes: false },
  { address: "data/tables.ts :: paymentsTables", writes: false },
  { address: "data/tables.ts :: PaymentsTables", writes: false },
  { address: "data/tables.ts :: paymentsDatabase", writes: false },
  // Reads. A `selectFrom` cannot bring a row into existence, which is the whole subject here.
  { address: "admin/read.ts :: (module)", writes: false },
  { address: "admin/read.ts :: listEntitlements", writes: false },
  { address: "admin/read.ts :: readEntitlements", writes: false },
  { address: "projection/resolve.ts :: (module)", writes: false },
  { address: "projection/resolve.ts :: resolveEntitlements", writes: false },
  { address: "projection/writer.ts :: (module)", writes: false },
  { address: "projection/writer.ts :: keysToDerive", writes: false },
  { address: "projection/writer.ts :: readEntitlements", writes: false },
  { address: "entitlement/manual.ts :: (module)", writes: false },
  // The four that change rows, and what makes each one's rows legitimate.
  { address: "projection/writer.ts :: ensureEntitlement", writes: "holds-nothing" },
  { address: "projection/writer.ts :: deriveEntitlement", writes: "refuses-held-rows" },
  { address: "entitlement/manual.ts :: writeEntitlement", writes: "unexported-primitive" },
  { address: "seeds/example.ts :: (module)", writes: false },
  { address: "seeds/example.ts :: paymentsExampleSeed", writes: "seeds-unheld-rows" },
];

describe("every place this package names the entitlements table", () => {
  const sites = () => tableSites(sources());

  test("is reading real sources, not an empty tree", () => {
    // Anti-vacuous, and pinned at the real population rather than safely below it: a sweep that lost half
    // the package would still clear a `> 5`, which is how a mass regression passes a green gate.
    expect(sources().length).toBeGreaterThanOrEqual(85);
    // A literal, never `CENSUS.length`: a count derived from the list being checked cannot notice the list
    // and the tree emptying together, which is a set under test computed by the thing under test.
    expect(sites().length).toBe(20);
  });

  test("every site is one the census names, and every census entry is a site that exists", () => {
    const found = sites().map(addressOf);
    const undeclared = found.filter((address) => !CENSUS.some((entry) => entry.address === address));
    expect(
      undeclared,
      `These name \`${TABLE_PHYSICAL}\` and the census does not account for them. Add each one, saying whether it changes rows and — if it does — which property makes the rows it writes legitimate:\n${undeclared.map((address) => `  ${address}`).join("\n")}`,
    ).toEqual([]);

    const stale = CENSUS.map((entry) => entry.address).filter((address) => !found.includes(address));
    expect(
      stale,
      `The census names these and nothing does any more. A permission left behind outlives what it permitted:\n${stale.map((address) => `  ${address}`).join("\n")}`,
    ).toEqual([]);
  });

  test("every declared writer still exhibits the property it is declared under", () => {
    // The account is re-derived from the declaration's own text on every run, so the census is a claim the
    // suite keeps checking rather than a note somebody wrote once.
    const broken = sites()
      .map((site) => ({ site, entry: CENSUS.find((candidate) => candidate.address === addressOf(site)) }))
      .filter(
        ({ site, entry }) =>
          entry?.writes !== undefined && entry.writes !== false && !ACCOUNTS[entry.writes].test(site.text),
      )
      .map(({ site, entry }) => `${addressOf(site)} no longer shows "${entry?.writes}"`);
    expect(broken, `A writer's account has been removed while its write stayed:\n${broken.join("\n")}`).toEqual([]);
  });

  test("the unchecked primitive is unexported, which is the only thing making it legitimate", () => {
    // Its account asserts no property of its text, because it has none: it asks nothing. What makes it safe
    // is that nothing outside its module can call it, and this is where that is checked.
    const primitives = sites().filter(
      (site) => CENSUS.find((entry) => entry.address === addressOf(site))?.writes === "unexported-primitive",
    );
    expect(primitives).toHaveLength(1);
    expect(primitives.map((site) => site.exported)).toEqual([false]);
  });
});

/**
 * The detector, planted against.
 *
 * Every escape reproduced against the previous gate is run through this one, as a source file it has never
 * seen. A gate nobody has watched refuse a hostile input is a gate nobody has watched at all — and the
 * previous version of this file passed all three of these.
 */
describe("the detector refuses what its predecessor could not see", () => {
  /** The address a planted file's write sits at, or `undefined` if nothing was detected there. */
  function detected(text: string): string[] {
    return tableSites([{ path: "planted.ts", text }]).map(addressOf);
  }

  test("sees a raw SQL write that names no builder method at all", () => {
    expect(
      detected(`export async function comp(d1: D1Database) {
  await d1.prepare("insert into ${TABLE_PHYSICAL} (user_id, entitlement, active, manual) values (?, ?, 1, 1)")
    .bind("ada", "pro")
    .run();
}`),
    ).toEqual(["planted.ts :: comp"]);
  });

  test("sees a write through a verb no list of Kysely methods would hold", () => {
    expect(
      detected(`export const seed = d1SeedGroup("app", ${TABLE_CONSTANT}, PaymentsEntitlement, [
  { userId: "ada", entitlement: "pro", active: true, manual: true },
]);`),
    ).toEqual(["planted.ts :: seed"]);
  });

  test("sees the second write in a file whose first write is accounted for", () => {
    // The per-file failure, exactly. The account below is real and covers the first declaration; the second
    // is a comp nothing checked, and a whole-file regex would have absolved it.
    const planted = `export function derived(db: PaymentsDatabase) {
  return db.insertInto(${TABLE_CONSTANT}).values({ manual: 0 }).execute();
}

export function sneaky(db: PaymentsDatabase) {
  return db.insertInto(${TABLE_CONSTANT}).values({ manual: 1, active: 1 }).execute();
}`;
    expect(detected(planted)).toEqual(["planted.ts :: derived", "planted.ts :: sneaky"]);

    // And the two are judged apart: the first shows its account, the second shows nothing.
    const [first, second] = tableSites([{ path: "planted.ts", text: planted }]);
    expect(ACCOUNTS["holds-nothing"].test(first?.text ?? "")).toBe(true);
    expect(ACCOUNTS["holds-nothing"].test(second?.text ?? "")).toBe(false);
    expect(ACCOUNTS["consults-the-catalog"].test(second?.text ?? "")).toBe(false);
  });

  test("a mention in a comment is not a site, and a mention in a string is", () => {
    // The one thing comment stripping must get right in both directions: prose about the table is not a
    // producer, and a SQL string is, however innocent the surrounding code looks.
    expect(detected(`// A row in ${TABLE_PHYSICAL}.\nexport const unrelated = 1;`)).toEqual([]);
    expect(detected(`/* ${TABLE_PHYSICAL} */\nexport const unrelated = 1;`)).toEqual([]);
    expect(detected(`export const sql = "delete from ${TABLE_PHYSICAL}";`)).toEqual(["planted.ts :: sql"]);
  });

  test("a URL and a regex do not make the scanner lose the code after them", () => {
    // The two literals a comment stripper written as a regex gets wrong. Losing the tail of a file is this
    // gate going silent, so it is asserted rather than assumed.
    expect(
      detected(
        `export const docs = "https://pithy.sh/entitlements";\nexport const q = "select 1 from ${TABLE_PHYSICAL}";`,
      ),
    ).toEqual(["planted.ts :: q"]);
    expect(
      detected(`export const trailing = /[\\\\/]$/;\nexport const q = "update ${TABLE_PHYSICAL} set active = 1";`),
    ).toEqual(["planted.ts :: q"]);
  });
});

describe("the manual entitlement module's own surface", () => {
  test("exports nothing that sets the hold without the catalog", () => {
    // `writeEntitlement` takes `active: boolean` and asks nothing. It is the unchecked primitive, and it is
    // unexported on purpose — exporting it, from here or through `src/index.ts`, hands a caller the row write
    // with the rule removed. The list is this module's whole runtime surface, not a roster of known callers:
    // a new export has to be added here, which is where somebody is asked whether it takes a config.
    expect(Object.keys(manual).sort()).toEqual(["grantEntitlement", "revokeEntitlement"]);
  });

  test("the grant takes a config and the revoke does not", () => {
    // The asymmetry in the signatures, which is where it belongs: a grant cannot be called without the thing
    // that decides whether the key means anything, and a revoke cannot be accidentally symmetrized into
    // needing one. `(d1, config, input, options?)` against `(d1, input, options?)` — arity counts the
    // parameters before the first default.
    expect(manual.grantEntitlement.length).toBe(3);
    expect(manual.revokeEntitlement.length).toBe(2);
  });
});
