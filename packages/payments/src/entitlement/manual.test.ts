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
 * reader failing this gate is asked a question worth being asked.
 *
 * ## What the second version could not see (#332)
 *
 * It checked the census against the code in **one direction**. A writer's account was re-derived from the
 * declaration's text on every run, so removing a guard failed — but `writes: false` was a bare claim nothing
 * ever checked. An `insertInto(PAYMENTS_ENTITLEMENTS_TABLE)` added inside `keysToDerive`, which the census
 * calls a reader, left the suite at eleven passed. Same class as the two before it: a hand-maintained
 * statement about the code, believed rather than derived.
 *
 * So **every mention is classified from its own text**, and the census's `writes` is compared against what
 * that classification says. {@link FORMS} names the forms a mention may take and whether each one changes
 * rows, and the comparison runs in both directions: a reader that writes fails, and a writer that no longer
 * writes fails too, so a permission cannot outlive the write it permitted.
 *
 * **The form list is positive, which is why it is not the verb vocabulary #328 threw out.** That list decided
 * what the gate *looked at*, so a verb missing from it was a site nobody examined — absolution by default.
 * This one decides what a mention already found is *allowed to be*: a mention matching no form is not a read,
 * it is a failure naming the line. `d1.prepare("insert into pithy_payments_entitlements …")` and a Kysely verb
 * nobody listed both land there. Nothing is permitted by omission.
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

/** The table constant, whitespace-tolerant, as a fragment of the form patterns below. */
const CONSTANT = `\\s*${TABLE_CONSTANT}\\s*`;

/**
 * Every form a mention of this table may take, and whether that form changes rows.
 *
 * **Positive, and exhaustive by refusal.** A mention matching none of these is not assumed harmless — it is
 * reported, with its line, as a form nobody has classified. That inversion is what separates this from the
 * verb list #328 removed: that list chose which mentions to *examine*, so a verb outside it was invisible;
 * this one judges a mention already found, so a verb outside it is a failure.
 *
 * Each pattern anchors on the table's own name, so a form cannot be satisfied by something elsewhere in the
 * declaration — the account regexes are declaration-wide by necessity, and this deliberately is not.
 */
const FORMS: readonly { name: string; writes: boolean; pattern: RegExp }[] = [
  {
    name: "an import or re-export specifier",
    writes: false,
    pattern: /\b(?:import|export)\s*(?:type\s+)?\{[^{}]*\}\s*from\s*"[^"]*"/g,
  },
  {
    name: "the table constant's own declaration",
    writes: false,
    pattern: new RegExp(`\\bconst${CONSTANT}=\\s*"[^"]*"`, "g"),
  },
  {
    name: "a key in a table map or in its type",
    writes: false,
    pattern: new RegExp(`\\[${CONSTANT}\\]\\s*\\??\\s*:`, "g"),
  },
  { name: "a select", writes: false, pattern: new RegExp(`\\.selectFrom\\(${CONSTANT}\\)`, "g") },
  {
    // A quoted string handed to `.describe`, never a template: prose about the table, which executes nothing.
    // A SQL string is not this — it is a mention in no form at all, which is the failure.
    name: "documentation text",
    writes: false,
    pattern: /\.describe\(\s*"[^"]*"\s*\)/g,
  },
  {
    name: "a Kysely mutation",
    writes: true,
    pattern: new RegExp(`\\.(?:insertInto|updateTable|replaceInto|deleteFrom)\\(${CONSTANT}\\)`, "g"),
  },
  {
    name: "a seed group",
    writes: true,
    pattern: new RegExp(`\\bd1SeedGroup\\(\\s*"[^"]*"\\s*,${CONSTANT},`, "g"),
  },
];

/** Every offset in `text` where the table is named, under either spelling, in order. */
function mentionsIn(text: string): number[] {
  const offsets: number[] = [];
  for (const spelling of [TABLE_CONSTANT, TABLE_PHYSICAL]) {
    for (let at = text.indexOf(spelling); at !== -1; at = text.indexOf(spelling, at + 1)) offsets.push(at);
  }
  return offsets.sort((left, right) => left - right);
}

/** What a declaration's own text says it does to rows, and every mention that says nothing recognisable. */
interface Derived {
  /** True when some mention sits in a form that changes rows. Compared against the census, never taken from it. */
  writes: boolean;
  /** Mentions in no named form. Neither a read nor a write — a question, and the gate asks it. */
  unnamed: string[];
  /** The names of the forms matched, so a form list cannot quietly accumulate permissions nothing uses. */
  matched: string[];
}

/** Classify every mention in one site from its own text. */
function derive(site: TableSite): Derived {
  const covered = FORMS.map((form) => ({
    form,
    ranges: [...site.text.matchAll(form.pattern)].flatMap((match) =>
      match.index === undefined ? [] : [[match.index, match.index + match[0].length] as const],
    ),
  }));
  const derived: Derived = { writes: false, unnamed: [], matched: [] };
  for (const offset of mentionsIn(site.text)) {
    const forms = covered.filter(({ ranges }) => ranges.some(([from, to]) => offset >= from && offset < to));
    if (forms.length === 0) {
      derived.unnamed.push(lineAt(site.text, offset));
      continue;
    }
    for (const { form } of forms) {
      if (form.writes) derived.writes = true;
      if (!derived.matched.includes(form.name)) derived.matched.push(form.name);
    }
  }
  return derived;
}

/** The line a mention sits on, trimmed — what a failure quotes so the reader sees the code, not an offset. */
function lineAt(text: string, offset: number): string {
  const from = text.lastIndexOf("\n", offset) + 1;
  const to = text.indexOf("\n", offset);
  return text.slice(from, to === -1 ? text.length : to).trim();
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

  test("what a site does to rows is read off its own text, and the census has to agree", () => {
    // The half #332 was missing. `writes: false` used to be a claim nothing checked, so an insert added to a
    // declaration the census calls a reader passed. Here the text decides and the census is compared to it,
    // in both directions: a reader that writes fails, and a writer that stopped writing fails too.
    const disagreed = sites()
      .map((site) => ({ site, entry: CENSUS.find((candidate) => candidate.address === addressOf(site)) }))
      .filter(({ entry }) => entry !== undefined)
      .map(({ site, entry }) => ({ address: addressOf(site), declared: entry?.writes !== false, ...derive(site) }))
      .filter((row) => row.writes !== row.declared)
      .map(
        (row) =>
          `${row.address} is declared ${row.declared ? "a writer" : "a reader"} and its text ${row.writes ? "changes rows" : "does not"}`,
      );
    expect(
      disagreed,
      `The census disagrees with the code it describes. Fix whichever is wrong — a write inside a declared reader is a comp nothing checked:\n${disagreed.map((line) => `  ${line}`).join("\n")}`,
    ).toEqual([]);
  });

  test("every mention is in a form this gate names, so nothing is permitted by omission", () => {
    // A mention matching no form is the one outcome that must never read as "harmless". Raw SQL and a verb
    // outside the list both land here, and both fail rather than defaulting to a read.
    const unnamed = sites().flatMap((site) => derive(site).unnamed.map((line) => `${addressOf(site)}: ${line}`));
    expect(
      unnamed,
      `These name the table in a form nothing has classified. Say what each one is by adding a form, and say whether it changes rows:\n${unnamed.map((line) => `  ${line}`).join("\n")}`,
    ).toEqual([]);
  });

  test("every form this gate names is one the package really uses", () => {
    // The rot rule the census already has, applied to the form list. A form nothing matches is a permission
    // kept for a shape that left, and the next mention to drift into it is absolved by an accident.
    const used = new Set(sites().flatMap((site) => derive(site).matched));
    expect(FORMS.filter((form) => !used.has(form.name)).map((form) => form.name)).toEqual([]);
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

/**
 * The classification, planted against.
 *
 * The gate above can only be as good as this: if `derive` calls a write a read, the census agrees with it and
 * the whole file passes describing a package that grants comps. Each case here is a source file the gate has
 * never seen, and the two that matter are the two the previous version got wrong — a write inside a shape
 * that reads like a reader, and a write in a form nobody listed.
 */
describe("what a declaration does to rows is derived from it, not believed", () => {
  function derived(text: string): Derived {
    const [site] = tableSites([{ path: "planted.ts", text }]);
    if (site === undefined) throw new Error("nothing was sited — the plant names the table and must be found");
    return derive(site);
  }

  test("a write planted inside a declaration that otherwise reads is derived as a write", () => {
    // #332, exactly: `keysToDerive` is a declared reader, and this is what was added to it. Under the old
    // gate the census's `writes: false` was never re-derived and the suite stayed at eleven passed.
    const planted = derived(`export async function keysToDerive(db: PaymentsDatabase, userId: string) {
  const held = await db.selectFrom(${TABLE_CONSTANT}).select("entitlement").where("manual", "=", 0).execute();
  await db.insertInto(${TABLE_CONSTANT}).values({ userId, entitlement: "comped", manual: 1 }).execute();
  return held;
}`);
    expect(planted.writes).toBe(true);
    expect(planted.unnamed).toEqual([]);
  });

  test("the same declaration without the insert is derived as a read", () => {
    // The other side, because a classifier that answered "writes" to everything would pass the line above
    // and refuse every reader in the census. Both answers have to be real.
    const planted = derived(`export async function keysToDerive(db: PaymentsDatabase, userId: string) {
  return await db.selectFrom(${TABLE_CONSTANT}).select("entitlement").where("manual", "=", 0).execute();
}`);
    expect(planted.writes).toBe(false);
    expect(planted.unnamed).toEqual([]);
  });

  test("raw SQL naming the table is unnamed, not quietly read as a string", () => {
    // The string spelling. A mention inside a quoted literal is documentation only inside `.describe(...)`;
    // anywhere else it is a form nothing has classified, and the gate says so rather than defaulting.
    const planted = derived(`export async function comp(d1: D1Database) {
  await d1.prepare("insert into ${TABLE_PHYSICAL} (user_id, manual) values (?, 1)").bind("ada").run();
}`);
    expect(planted.unnamed).toEqual([
      `await d1.prepare("insert into ${TABLE_PHYSICAL} (user_id, manual) values (?, 1)").bind("ada").run();`,
    ]);
    expect(planted.writes).toBe(false);
  });

  test("a Kysely verb outside the list is unnamed, not absolved by its absence", () => {
    // The failure mode of any list: something not on it. On a list that decides *what to examine* this is
    // invisible; on a list that decides *what a mention may be* it is a failure with the line attached.
    const planted = derived(`export function merge(db: PaymentsDatabase) {
  return db.mergeInto(${TABLE_CONSTANT}).values({ manual: 1 }).execute();
}`);
    expect(planted.unnamed).toEqual([`return db.mergeInto(${TABLE_CONSTANT}).values({ manual: 1 }).execute();`]);
    expect(planted.writes).toBe(false);
  });

  test("prose about the table is documentation and a SQL string beside it is not", () => {
    // `data/entitlement.ts` really does name the physical table inside a `.describe`, so the form exists for
    // a real site. It must not stretch to cover the string spelling anywhere a quote happens to sit.
    const planted = derived(`export const PaymentsEntitlement = z
  .object({})
  .describe("One entitlement a user holds — the row in \`${TABLE_PHYSICAL}\`.");`);
    expect(planted).toEqual({ writes: false, unnamed: [], matched: ["documentation text"] });
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
