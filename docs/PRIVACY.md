# Privacy classes

A field declares its own privacy class, in its schema, and the declaration drives everything downstream: the compiler refuses the value on a log line, an audit record and an error detail; `redact` gives you the masked view instead; and your control plane reports which schemas and fields hold what, derived from the code that is running. This page states the rule once. [`pithy privacy`](commands/privacy.md) is the command, and [`docs/CONTROL-PLANE.md`](CONTROL-PLANE.md) §12 is the route.

## Mark a field

```ts
import { phi, pii } from "@pithy-sh/core/src/privacy/classes";
import { z } from "zod";

export const Patient = z
  .object({
    id: z.string().describe("The patient's stable id."),
    email: pii(z.string().describe("The address reminders are sent to.")),
    diagnosis: phi(z.string().describe("The recorded condition.")),
  })
  .describe("A patient.");
export type Patient = z.output<typeof Patient>;
```

A marker does two things in one call. It attaches `.meta({ privacy: "pii" })`, which `redact`, `classifyPrivacy` and the inventory read. And it applies Zod's `.brand()` under the key `privacy:pii`, which changes the inferred type, which is what stops the log call from compiling. The `.describe()` survives in either order: `pii(z.string().describe("…"))` and `pii(z.string()).describe("…")` are the same field.

**The brand is on the field, not the object**, so extracting the field does not launder it. `user.email` is as refused as `user`. The key is namespaced so that a brand of your own — a `UserId`, or a `.brand<"pii">()` that means something else — is never read as a privacy class.

**Nothing at runtime changes.** `.brand()` returns the same schema object and `.meta()` a clone that parses exactly as its source, so `Patient.parse(row)` returns the data it did before the marker and no column is added. The input side stays unbranded: `z.input` — the SQLite row, the Kysely table type, a KV write — is what it was. The one thing a brand costs is that a value of the app type must come from a parse, so a `.default()` takes a parsed value, or goes inside the marker: `pii(z.string().default("guest"))`.

**A marker composes with every codec.** `pii(SQLiteDate)`, `phi(SQLiteBoolean)` and a marked field inside `sqliteJson(Profile)` each encode to the row shape, insert through Kysely unchanged and parse back to the unmarked schema's data — proved against a real D1 in `packages/core/src/privacy/codecs.workers.test.ts`. `redact` reads a JSON column field by field; see [the contract](#the-contract).

A marker is read through `.optional()`, `.nullable()`, `.default()` and the other wrappers that are the same field.

**A marker over another marker adds its class.** `pii(secret(z.string()))` and `secret(pii(z.string()))` are one field carrying both classes: masked `[secret]`, listed `pii` and `secret`, and refused by the compiler as either. The same marker twice is one class.

## The classes

| Class | What it is | Masks to |
|---|---|---|
| `secret` | A credential or a bearer artifact: a session id, a magic-link token, a receipt, a key. The harm is impersonation, not exposure. | `[secret]` |
| `pii` | Personal data under GDPR or CCPA: an email address, a name, a phone number, a postal address. | `[pii]` |
| `phi` | Protected Health Information under HIPAA: a diagnosis, a treatment, a result. | `[phi]` |
| `pci` | Cardholder data under PCI-DSS: a primary account number. | First six and last four, `424242******4242` |

**The set is open.** `definePrivacyClass({ name: "genetic", mask })` registers a class of your own and returns its marker, usable exactly like the four. A name is a lowercase identifier, and a duplicate — a built-in's name included — is refused at registration, because two modules each believing they own `genetic` would disagree about its mask. `mask` is optional and defaults to the `[name]` placeholder.

`pci` is for your own schemas. Every payment rail Pithy ships is hosted, so no card number reaches your Worker through the kit.

**`secret` is not `@pithy-sh/secrets`.** That package decides where a credential your Worker *reads* is stored. `secret()` says what a field in a *data shape* is — a receipt, a token, a key hash — values that live in rows and that no secrets registry ever holds.

## What the compiler refuses, exactly

The logger's message, fields and child names, `c.var.emit`'s `metadata`, and the `message`, `action` and `detail` of every `PithyError` refuse a marked value at compile time.

```ts
log.info("signup", { user });                        // refused: a row with a marked field
log.info("signup", { email: user.email });           // refused: the branded string itself
log.info("signup", { id: user.id });                 // compiles: unmarked
log.info("signup", { user: redact(Patient, user) }); // compiles: { id: "u_1", email: "[pii]", diagnosis: "[phi]" }
log.info(user.email);                                // refused: a marked message
new InternalError({ detail: user.email });           // refused
```

What is checked:

- **A marked value itself**, anywhere a field value goes, and as a log message, a logger's name, or an error's `message`, `action` or `detail`.
- **A marked key.** A record keyed by a marked value, `Record<User["email"], number>`, holds every email it is keyed by, and is refused like the value.
- **A marked value inside an object or an array, down to six levels below the field.** `{ user }`, `{ user: { email } }`, `{ users: [user] }` all fail. The bound is there so the check terminates on a recursive type, not for speed: measured with `tsc --extendedDiagnostics`, the gate costs under 1% of types and instantiations on every package, and moving the bound from one to nine changes either count by less than 0.01%. An `Error`, a `Date`, a function, a promise, a map and a set are not walked.

What is not, and cannot be:

- **A template literal.** `` `signup for ${user.email}` `` is a `string` to TypeScript whatever was interpolated, and no type sees through it. This matters most for `detail`: interpolate the id, or the `redact`ed value.
- **Deeper than six levels.**
- **A cast or an `unknown`.** A value the compiler cannot see is a value it cannot refuse.

**None of it is checked at runtime.** A marker changes no runtime value, so a string that escaped the type is an ordinary string. The schemas `LogFields` and `AuditMetadata` stay permissive on purpose: a record that reaches a sink still parses.

HTTP responses are not gated. Returning a user their own email is correct.

## The masked view

`redact(Schema, value)` returns a copy in which every unmarked field is verbatim and every marked one is its class's mask. It reads the app shape — what `Schema.parse(row)` returns — and never mutates its argument. `null` and `undefined` stay as they are.

### The contract

`redact(schema, value)` promises exact results for a stated set of schema shapes and documents everything else. It does not try to defend against every construction Zod allows, because a schema built to dodge it can be built, and following every such construction costs more than it protects. What it covers, it covers perfectly; what it does not, it masks whole and says so.

**Redacted exactly.** Every marked field is masked with its class placeholder, every unmarked field is kept as `parse` returned it, nothing is dropped, and `Redacted<T>` is the exact type of the result, save two positions it types `unknown` rather than guess: one that nests wrappers and choices deeper than the type can follow, and an intersection with a record on either side, because a record's masked keys rename the other side's keys too.

1. Rows and objects: `z.object`, strict, loose or with a catchall, and `pick`, `omit`, `partial` and `extend` of one.
2. Collections: arrays, tuples including rest elements, records with marked keys or values, `Map` and `Set`.
3. Wrappers: `optional`, `nullable`, `default`, `catch`, `readonly`, `brand`.
4. Choices: unions, discriminated unions and intersections. An option's marks apply where the value has that option's shape: an object option to an object value, an array option to an array value. A field is masked when any option or side that applies marks it, and a key no option names is kept. Where one side of an intersection narrows a field so it can never hold the type the other side marks, `classifyPrivacy` may still list that field: the inventory can list more than `redact` masks, and never less.
5. The kit's database codecs: `SQLiteDate`, `SQLiteBoolean` and `sqliteJson(schema)`. A JSON column's inner fields are redacted field by field.
6. Recursion: `z.lazy(() => Node)` and getters, whether a getter returns one schema or builds a new one each read, such as trees and linked lists. Walked exactly to a fixed recursion depth. Past it the position is masked whole, and `Redacted<T>` types it `unknown` from that same depth: one limit, shared by the runtime and the type, however the recursion is written. A self-referencing `z.lazy` has to be annotated `z.ZodType<T>`, which names no kind, so `Redacted<T>` types it, and every field that holds it, `unknown`. Write the recursion with a getter and the type keeps its shape to the limit. A value cut off at the limit is masked `[truncated]`, which is a safety cutoff rather than a privacy class, so `classifyPrivacy` does not list it.
7. Values copied out of a parsed row into a plain object, array, `Map` or `Set` described by any of the above.

**Outside the contract.** Custom transforms and pipes, `preprocess`, codecs other than the kit's own (one built the way `sqliteJson` is built included), `z.custom`, `any` and `unknown`. `redact` does not look inside these. When anything beneath one is marked, the whole value is masked with the strongest class it carries, and `Redacted<T>` types that position `unknown`. When nothing beneath it is marked, it is kept as it is, including when it is a union option beside a marked one. A recursion beneath it that reaches the item 6 depth limit counts as possibly marked, so that value is masked whole and typed `unknown`: with the strongest class marked anywhere else beneath it, or as `[truncated]` where none is. None of this ever throws or leaks a raw marked value.

**Tested as stated.** An exhaustive matrix over the supported shapes, each nested in each, checks the runtime result and the type. The cases outside the contract are tested for exactly the documented behavior, and the docs carry this list verbatim.

### The edges, exactly

- **The strongest class names a whole mask**: `secret`, then `phi`, then `pci`, then a class of your own, then `pii`. A transform over a `pii` and a `phi` field comes back `[phi]`. A mark on an object, an array or any other container masks it whole, and it carries every class marked inside it as well as its own: `pii(z.object({ token: secret(z.string()) }))` comes back `[secret]` and is listed `pii` and `secret`.
- **A position two classes reach takes the stronger one's placeholder.** Where one option marks `n` as `pci` and another as `pii`, a national ID in `n` comes back `[pci]`, never as a card number's first six and last four. A class's own mask runs only where that class is the only one at the position.
- **A marked option of one shape leaves a value of another alone.** Against `z.union([pii(z.string()), z.array(z.string())])`, a string comes back `[pii]` and `["P-1"]` comes back `["P-1"]`; beside `z.number()`, a number is kept. `Redacted<T>` agrees: that union is `string | string[]`. A mark reached through no option applies to every value. A record's string key is a string whatever its schema says, a number key included, so a key schema that marks any shape but a symbol masks every string key. A symbol key is masked only by a marked symbol option: against `z.record(z.union([pii(z.string()), z.symbol()]), …)`, a symbol key comes back as it went in.
- **A field only one option marks is masked wherever an option of that shape applies.** Against `z.union([z.object({ e: pii(z.email()) }), z.object({ e: z.number() })])`, a `{ e: 5 }` comes back `{ e: "[pii]" }`: both options are objects, so both apply. Against `z.union([z.object({ e: pii(z.string()) }), z.unknown()])`, an array or a string comes back as it is, because no option of that shape marks anything.
- **Nothing the value holds is dropped.** Every key and element comes back, a record's symbol keys included. One no schema at its position names — a key only a transform, a `.catch()` fallback or an `unknown` could have put there — is kept as it is. So is a value of a kind no option names, such as an array beside an object option.
- **A record's or a map's key, and a set's element, is redacted by its schema.** Two that mask alike come back as `[pii]` and `[pii] #2`, so the copy holds as many entries as the value did. Only a masked one is ever numbered: a kept one stays as it is, even one that reads `[pii]`, and a masked one takes the first name no kept one holds. An own `__proto__` key is defined on the copy, so it never becomes the copy's prototype.
- **The one recursion limit is 256 levels of nesting.** Every object, array, tuple, record, map and set a position sits inside counts one. A position deeper than that is masked whole as `[truncated]`, a safety cutoff rather than a privacy class, and `Redacted<T>` types it `unknown` from the same depth: the type reads the same constant the runtime does. Nothing tells one recursion from another, so a `z.lazy`, a getter that returns one schema and a getter that builds a new one each read all end at the same level, and the result is a function of the schema and the value alone. A linked list walks 256 nodes and masks the fields of the next; a tree whose level passes an object and an array walks 128. The walk keeps its own stack, so a deep value never overflows the call stack. A recursion beneath an opaque node or a marked container that reaches the limit ends that path alone. Every other path beneath it is still read, so a class beside the recursion is found whatever the field order, and the value is masked whole with the strongest class found. Only where no class is found is it `[truncated]`. A class known at a position is always its mask, and `classifyPrivacy` lists those classes, never the cutoff. A schema that builds two new ones at every level is searched shallowest first, and a class found is kept. The search opens at most 10,000 schemas and checks that between levels, never inside one: a level begun is read whole however wide, and the level past the budget is still read for its marks, so width alone never stops a search. A lazy that builds a new choice each read, `z.lazy(() => z.union([z.string(), next()]))`, ends at the limit the same way: every lazy nested in another counts one, and the value at its position is `[truncated]`, unless an option beside the chain marks a value of its shape: `z.union([next(), secret(z.number())])` masks a number `[secret]`, in either order. Two cut off in one set or under one record come back `[truncated]` and `[truncated] #2`, as two masked keys do. `hasPrivacy` never sees the cutoff, so a recursion defined once and one built anew answer alike. A union of many lazies, none inside another, counts one, so a choice of any width is walked. The read of a position counts the lazies it resolves the same way, between levels, and pays again for a choice it has met before, so the answer never depends on which schema was read first.
- **A getter is read the way `parse` reads it.** Zod reads an object's getters once, the first time the shape is read, and keeps that answer. `redact` never calls a getter itself: `get addr() { return z.object({ … }) }` is walked like a field written in place.
- **A check is not a node.** `.refine()`, `.superRefine()`, `.check()` and `.overwrite()` leave the schema the kind it was, so a check that writes a marked value into another field is not seen. Move a value with a `.transform()`, which is masked whole over a mark.

**The type is the shape it returns.** A marked position is a `string`. An object maps its fields, an array and a tuple their elements, a record and a map their values, a set its elements, and a brand that is not a privacy class stays on. An opaque position is its own output type, or `unknown` where a mark sits beneath it or may. The type reads every schema beneath it once, to the one recursion limit, so an unmarked schema of any depth keeps its output type. A recursion beneath it, a getter or a lazy that comes round to a schema above it, is `unknown` however it is written: the type cannot tell one defined once, which `redact` reads to its end and keeps, from one built anew each read, which reaches the limit and is masked whole. So is a schema annotated `z.ZodType<T>` beneath it, which the type cannot read inside. Two more positions are `unknown` because TypeScript cannot see their kind: a schema annotated `z.ZodType<T>`, as a self-referencing `z.lazy` must be, and `any`. A schema written with a getter is inferred, and keeps its shape to the recursion limit. Where a union holds a tuple beside an array, the array's elements are typed one by one at the positions the tuple names; where it holds an object beside a record or an open object, the record's keys the object names are typed as that object marks them. The kit's JSON column is known by the type `sqliteJson` returns, so a codec of your own built the same way is `unknown` where a mark sits beneath it, as `redact` masks it whole.

`Redacted<typeof User>` names that type for a value already redacted. It takes the schema, not the value's type, because a value's type cannot tell a plain object from what a transform returns, and `redact` masks that whole over a mark.

**The mask is a placeholder, not a hash.** `[pii]` loses correlation: two lines about one person look unrelated. A keyed hash would keep it, and an email is low-entropy enough to brute-force from an unkeyed one — so it would need a secret salt, and that would pull `@pithy-sh/secrets` into core. Correlation is what the unmarked id beside it is for.

`classifyPrivacy(Schema)` lists every position `redact` masks and its class — `email`, `address.line1`, `devices[].token`, `profile.phone` inside a JSON column, `byEmail.<key>` for a record keyed by a marked value, `tags[]` for a set — and a position masked whole once per class it holds. A recursion defined once is listed once. One built anew at every level is listed level by level to the limit. Past it a value is masked `[truncated]`, which is a safety cutoff rather than a privacy class, so `classifyPrivacy` does not list it. The list walks the schema where `redact` walks a value, so it has a budget: it reads at most 10,000 distinct positions, level by level, shallowest first. A position is read once wherever it sits, so a schema reused in a thousand fields costs one, and every one of those fields is listed. Only a schema that builds two new ones at every level reaches it. That schema is read whole down to the level the budget runs out on, so a shallow branch is listed as `redact` masks it, and each new position left, none of them above that level, is listed as `secret` with `truncated: true`. It is one of two places the list says more than `redact` masks, and it says the strongest class. The other is an intersection whose one side narrows a field so it can never hold the type the other side marks: the field is still listed. The list can say more than `redact` masks, and never less. `hasPrivacy(Schema, "phi")` is the boolean a route or a guard branches on.

## Declare what the project handles

```ts
// pithy.config.ts, at the root
const config = {
  name: "acme",
  privacy: { classes: ["pii", "phi"] },
};
```

Root rather than per Worker, for the reason `seed.productionEnvironments` is: a project's compliance posture is not something one Worker gets to have and another does not. `pithy privacy enable --class pii --class phi` writes it.

**It is a declaration, not an allowlist.** Marking `phi()` in a project that declared only `pii` compiles, deploys, and is reported as observed but not declared. A developer marking more than the project declared is doing the right thing, badly configured. What the declaration does is close `console`, and turn on the reporting that sets declared beside observed.

## The console gate

A structured log goes through the logger, where the brand stops a marked value. A `console.log` goes around it, so once a class is declared, `console` is closed:

1. **The rule.** `pithy privacy enable` writes Biome's `suspicious/noConsole` at `error` into `biome.jsonc`, on each Worker's source in every language Biome lints and not on tests. It catches the call in the editor.
2. **The deploy.** `pithy deploy` refuses a project that declared a class while the rule is off — file named, rule named, fix named. The fix follows the cause: `pithy privacy enable` where the rule was never stated, and your own edit where you turned it down or disabled the linter, because `enable` will not override that. This is the only hard failure the privacy work adds.
3. **The report.** The manifest carries the gate's state, so a project that deleted the rule and shipped around the CLI is visible.

Three states, because Pithy does not own your toolchain:

- **`enforced`** — a Biome config was read and the rule is `error`, allowing no method, for every Worker source file: each `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs` file under `apps/*/src`, tests aside. A `warn` is not enforced: it fails no lint run.
- **`off`** — a Biome config was read and, for some Worker source file, the rule is not `error`: unstated, lowered by an override that covers the file, letting a method through with `options.allow`, or the file left unlinted by a disabled linter, `files.includes` or `linter.includes`. Deploy refuses, and names the file.
- **`unverifiable`** — no Biome config Pithy can read: none at the root, one that does not parse, both `biome.json` and `biome.jsonc`, a nested config in `apps/` or inside a Worker, no Worker source to read the rule for, a glob Pithy will not guess Biome's reading of, or one that `extends` another config. An extended config's overrides still apply on top of yours, so a rule at `error` beside an `extends` is not proof; one stated below `error` is still `off`. Deploy proceeds, says so on every run, and the manifest carries `unverifiable` with the reason.

The gate reads the rule per file, the way Biome does. An override applies only to the files its `includes` covers, so an override at `error` on `scripts/**` closes nothing in a Worker, and an override at `off` on your tests opens nothing. A group set as a string — `"suspicious": "warn"` — sets the rule to that level too, and is read that way.

`unverifiable` is honest, and it is not a hiding place. Deleting `biome.jsonc` to escape a failing gate moves a project from `enforced` to a state the dashboard renders as unverified, on every read. Pithy cannot make a lint rule impossible to turn off — you own `biome.jsonc` — and this page will not pretend otherwise. What it makes impossible to turn off is the visibility. The one state Pithy never reports is a false `enforced`.

A project that declares no class deploys whatever the rule says.

## What the control plane reports

`GET /control-plane/manifest` carries a `privacy` block that needs only `manifest:read`, because it names classes and counts and never a field:

| key | meaning |
|---|---|
| `declared` | The classes the project declared, as attested by the last `pithy deploy`. Empty when it declared none; `null` when no attestation reached this Worker. |
| `observed` | Every class with at least one marked field in this Worker's storage schemas, derived at runtime. |
| `counts` | Marked fields per observed class. |
| `observedNotDeclared` | Classes the code holds that the project never declared — a posture change nobody escalated. |
| `declaredNotObserved` | Classes declared with no marked field behind them — an unfinished migration. |
| `consoleGate` | `enforced`, `unverifiable`, `not_required` (no class declared), or `unattested`. |
| `consoleGateReason` | Why the gate is `unverifiable`. |
| `attestedAt` | When the attestation was written. |
| `sources` | The storage walked: `d1` tables and `kv` stores. Anything not listed was not walked. |

A project that declared nothing gets `declared: []` and walks nothing to say so: `observed`, `counts` and both deltas are `null`, and `sources` is empty.

`GET /control-plane/privacy`, behind `privacy:read`, returns the same posture and the full inventory: every schema holding a marked field, each field's path and class, and whether it is a D1 table or a KV store.

**The inventory is computed at runtime from the composed schemas, not stamped at build.** The schemas are already in the bundle — they are the table definitions — so deriving adds no bytes where a stamped copy would. It walks once per isolate, on the first control-plane read, in single-digit milliseconds for the whole kit. A derivation cannot be skipped, edited out of your repository, or disagree with the code. A developer who unmarks a PHI field cannot suppress the consequence: the field leaves the report on the next deploy.

**It walks D1 tables and KV stores**, the key, value and metadata of each, because that is where persisted data lives and what an auditor asks about. R2 objects, Vectorize metadata, Durable Object storage, email templates and request bodies are not walked, and `sources` says so.

### The one honest limit: declared is an attestation

The declared classes and the gate's verdict reach the Worker as the `PITHY_PRIVACY` var, which `pithy deploy` passes on wrangler's argv. That is the mechanism a Worker already learns its own name by, and it is an **attestation**, dated to the last deploy Pithy performed. The observed inventory is the derivation, and is not editable. An attestation that disagrees with what the running code holds is itself the finding.

**Usually a skipped attestation is absent, not stale.** Without `keep_vars: true`, a raw `wrangler deploy` uploads only the vars its config names, so a Worker shipped around `pithy deploy` reports `unattested` rather than whatever was last true. Under `keep_vars: true` the var survives and describes an older build. The Cloudflare version id cannot pair the two, because it is assigned at upload, after the var is written — so the manifest carries `attestedAt` beside `versionCreatedAt`, the version's own creation time, and a version created long after its attestation is a build the attestation does not describe.

## Find what is not marked

`pithy privacy scan` walks the same storage schemas, with the same walk, and reads each field's name. `email`, `phone`, `ipAddress`, `dateOfBirth`, `ssn`, `diagnosis` and the rest are candidates, each with the class it suggests and the marker to apply. A marked field is covered. It exits 0, edits nothing, and fails no build. Which of your fields are regulated is a question for your jurisdiction, your sector and your counsel — Pithy surfaces candidates and the marking stays yours.

## What this does not do

- **Record who read what.** The access trail §164.312(b) asks for is a later issue; this ships the declaration it will read.
- **Encrypt anything at rest.** A class is a claim about what a field *is*; encryption is a claim about how it rests. Nothing here changes a stored value, which is what makes it safe to adopt everywhere at once.
- **Decide what you must mark.** No gate fires on an unmarked field.
- **Require `@pithy-sh/audit`.** Declaring a class offers it, at a terminal. It never demands it.
- **Mark the kit's own schemas.** This ships the mechanism; each capability adopts it in turn.
- **Erasure, retention, subject-access requests.**
