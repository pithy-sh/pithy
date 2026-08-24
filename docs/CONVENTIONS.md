# Engineering conventions

Rules that outlived the change that produced them. Each one is here because the same defect was written more than once, by more than one person, after somebody had already worked out the answer and left it in a comment in one file where nobody else read it.

`docs/CLI.md` says what a refusal looks like. This says what it is allowed to claim.

## Refusals

### A `catch` may not name a remedy it cannot know

**If a `catch` block can be reached by more than one underlying failure, its `action` may not name a single specific remedy.** Classify the cause and answer each one, or hedge.

Hedging is not "list every remedy". It is either saying less — a sentence that admits what is not known — or naming the possibilities *with the test that tells them apart*, so the reader can pick. What is banned is one remedy asserted over failures it cannot address.

A wrong action is worse than no action, because it is followed. An adopter reads the second line, does what it says, nothing changes, and the thing that would have told them — the resolver's specifier, the parser's position, the errno — was captured into `detail` and discarded one frame up.

Someone worked this out and wrote it down in `packages/cli/src/capabilities/manifests.ts`:

> A manifest that is there and will not open is **not** "not installed": telling an adopter to run
> `pithy add auth` when the file is unreadable sends them to the command that just declined to run.

That was one file. It did not spread. #207 fixed one instance of the same defect in the config loader, and the survey it asked for found twenty more — fourteen of them the identical line in seven files. Hence a rule, rather than a twenty-first patch.

#### The shape to look for

- Several `import()` calls in one `try`, with an `action` naming one package.
- A read and a parse in one `try`, with an `action` that asserts the file is missing.
- A file-read `catch` whose `action` says *check permissions* — `EACCES` is one errno; `EISDIR`, `ELOOP` and `EIO` are the others, and `chmod` answers none of them.
- A `fetch` `catch` whose `action` names the URL — DNS, TLS, a refused port, a dead network and this process's own timeout all land there, and only one of them is about the URL.
- One error-building helper shared by several call sites with the `action` baked into the helper. If the helper takes `message` and `detail` per site but not `action`, the `action` is a constant across failures that are not.

#### How to classify

The three worked examples, in order of how much they had to say:

| Where | Function | Splits |
| --- | --- | --- |
| `packages/cli/src/project/config.ts` | `classifyConfigLoadFailure` | unresolved-import / parse-error / threw-on-load / unknown |
| `packages/cli/src/capabilities/loadFailure.ts` | `classifyCapabilityLoadFailure` | not-installed / dependency-unresolved / broken / unknown |
| `packages/vite/src/workerConfig.ts` | `classifyWorkerConfigFailure` | as the first, restated because `@pithy-sh/vite` must not depend on the CLI |

Rules that hold for all of them:

1. **Duck-type the cause. Never `instanceof`.** The `bin` ships on **Bun**, whose `ResolveMessage` and `BuildMessage` are their own classes and are **not** `instanceof Error`. Vitest runs on **Node**, so `Error`-shaped fixtures hide this completely: #207's first implementation gated on `instanceof Error`, passed all 32 tests, and dropped the parser's sentence on the only runtime adopters use. Read `message`, `name`, `code`, `specifier` and `position` as properties off an `unknown`.
2. **Export the classifier and test it directly.** The runtime the suite reaches is not the runtime that ships. A classifier tested as a pure function against both runtimes' real error shapes is tested for both; one reachable only through an integration path is tested for neither.
3. **Verify on Bun, not only under vitest.** Run the real code against a real broken fixture on Bun before claiming a classifier works. This is not ceremony — doing it for #217 found two defects that every passing Node fixture had hidden:

   - **Bun does not always throw `BuildMessage` from `import()`.** One diagnostic arrives bare; **two or more arrive wrapped in an `AggregateError`** whose `errors` array holds them, whose own `message` is `2 errors building "<absolute path>"`, and whose `Object.keys` is empty. A stray brace cascades, so the wrapped case is the common one. Classify the wrapper and a syntax error reads as "it threw", losing the parser's sentence and position — the exact loss #207 existed to prevent. Unwrap first. `classifyConfigLoadFailure` still has this gap: a `pithy.config.ts` with one syntax error gets `parse-error` and the position, and the same file with two gets `threw-on-load` and nothing.
   - **Bun does not use node's network errnos.** A dead host, a bogus TLD and a refused port all arrive as one `code: "ConnectionRefused"` on a plain `Error`; node wraps in `TypeError: fetch failed` and puts `ENOTFOUND` or `ECONNREFUSED` on the `cause`. Bun cannot tell DNS from a refused port, so the code must not claim to either: its branch names both. TLS codes are the one place the two agree.

   A classifier that reads a cause is only as good as the runtime it was checked against. Check both.
4. **The unknown branch gets no remedy.** Not a guess, not the most likely one. A sentence that admits it does not know, and a `detail` that carries everything.
5. **`action` carries no absolute path, no source line, no stack.** A specifier is the adopter's own import and may travel; the referrer path is our frame and may not. Decide by content, not provenance — see `safeReason`.

#### Or do not classify

Classifying is not always the answer. Two cheaper ones:

- **Use a primitive that already decided.** `readOptionalFile` separates "absent" from "there and would not open" and hedges correctly on the second; `requireRecord` separates "parsed" from "parsed to something that is not a document". A call site that uses both has three failures with three sentences and wrote none of the logic.
- **Split the `try`.** Two `try` blocks around a read and a parse cost one line and remove the ambiguity entirely. Most of the six non-loader sites in #217 were fixed this way.

#### Where the shared code lives

A classification used by two call sites may stay at both. **Three is this repository's count** for hoisting a rule out of its call sites — the same threshold `readOptionalFile.ts` states for itself. When a third appears, the home is beside the primitive that owns the decision, not in a `utils` file.

## Seeded files

Everything above is about code we keep. This is about code we give away.

> **Every seeded file whose invariant an adopter can break silently ships with the gate that notices.**

A seeded file is one a Pithy command writes into somebody else's repository — the front-end templates in `@pithy-sh/ui-react` are the whole population today. From the moment it lands it is theirs: they edit it, we never rewrite it, and no release of ours can fix it. So a gate we keep here is a gate that goes silent at exactly the moment the file becomes breakable.

`pithy ui add react --auth --payments` used to seed eighteen files and **no test at all**, while ten gates over those same files sat in `packages/ui-react/src/`, each stated over the pristine template text.

### The three properties a seeded gate must meet

Earned from #383, and they survived #392, #393 and #394 unchanged.

1. **"Silently" is the test.** A file that breaks loudly on edit — a syntax error, a type error, a failing build — needs nothing. The ones that matter fail into a green build and a wrong runtime.
2. **The gate cannot pass against the bug.** Its expectation is a **canary invented in the test file**, plus a second assertion refusing a canary that has drifted onto a real value. Asserting the correct string would pass against the exact drift the gate exists to catch. A gate that instead compares two subjects and writes down no expectation of its own satisfies this differently and equally — but note that comparing a file *to itself* is not that, it is the same defect at a higher altitude.
3. **It is proven able to fail in a scaffolded project**, not only in this repo. Plant the defect in a real `pithy init` output, watch it go red, and put the red in the report. A gate proven here is not evidence about what an adopter gets: the environments differ, and #383 found that the seeded gate had to mock a different module than the kit's own for exactly that reason.

### Two questions before you write one

**Who can break it?** A seeded gate is for an invariant the *adopter* can break. When the party who can break it is the kit, the gate stays in the kit. `client-env.d.ts` is the worked example: ambient types over projections three packages away, where the drift that hurts is a capability dropping a field. Seeding a gate for that would put the alarm in a repository that did not move the contract and cannot fix it, so #392 held it kit-side against the real projections. Then #398 removed the invariant instead — the file is generated from the four declared projections now, so there is one statement of the shape and nothing for a gate to compare. **That is the move to reach for first**: a gate watching two things agree earns its keep only while there have to be two. What is kept, in `@pithy-sh/vite`'s `clientEnvDeclaration.test.ts`, is smaller and different in kind — that the committed artifact is the current emit.

**Can the gate run where it would be seeded?** This is the practical half, and it is a wall you find by trying rather than a judgment you make in advance. A seeded gate must pass under the plain `vitest run` an adopter already has — which is why the seeded gates stub `pithy-config.tsx` rather than `virtual:pithy/*`, and why a gate needing a spawned compiler cannot be one. #391 found the sharper case: the palette invariant lives in CSS text, and **Vitest stubs CSS modules to the empty string**, so `?raw` and a raw glob both answer `""` in a scaffolded project. A seeded gate would have swept an empty set and passed. It is kept in `packages/ui-react/src/palette.test.ts` instead, and the ledger records both the wall and what is lost — it catches the kit shipping a half-set, and cannot catch an adopter's later edit. **A gate that passes over nothing is worse than no gate**, because it is read as coverage. Find this out by planting, not by reasoning: this one passed against its own planted defect first time.

#399 found the wall's other shape, and it is the one to expect from a build file. `vite.config.ts`'s
`persistState` and both tsconfigs' paths are *relative*: `../../` is right from `apps/<worker>/` and wrong anywhere else, and the string reads identically either way. The invariant is not in the text, it is in where the Worker sits — so no test inside that Worker is at the right altitude to check it, and the gate went to the scaffolder's suite, which builds a real project and resolves against it. The same altitude argument covers `tsconfig.client.json`'s `include`, where the failure is `tsc -b` exiting 0 over a program holding no files: proving that needs a spawned compiler, which a seeded `vitest run` has not got. When a seeded file's invariant is a fact about the layout around it, expect to keep the gate.

**Can you remove the invariant instead?** Gating is the second answer. #393 made a screen's path and the router's redirect one statement; #394 made the mount node one the app creates rather than one an id in `index.html` names; #377 and #366 are the same move earlier. Removing the class beats watching it, every time.

**Then seed the gate anyway.** This is the part worth writing down, because both of those issues did it and neither had to. **A removal is itself an invariant** — *the mount node is created, not found*, *the guard reads the screen's declared path* — and it is exactly as silently reversible by the next person to edit the file as the shape it replaced. The seeded gate holds the removal.

### Where the decision is recorded

`packages/ui-react/src/seededGates.test.ts` carries the ledger: every seeded file, and one of three answers — the gate seeded beside it, the gate the kit kept and why it could not travel, or no gate and why none is owed. Adding a path to `TEMPLATE_GROUPS` is red until that line exists, which is the whole mechanism — **it is a forcing function, not a detector.**

Be clear about what it cannot do, so nobody trusts it for more. It cannot tell whether a file *has* an invariant: an invariant is two things agreeing, and no sweep over text decides whether an agreement is meaningful. It cannot tell whether a named gate really gates its subject. It cannot tell whether a decline's reason is true. And it cannot check property 3 at all — proving a gate red in a scaffolded project is an act a person performs. What it does is make the question due at the one moment it can be answered well, and refuse to let the answer rot: a ledger entry for a file that has left the tree, a seeded gate nothing claims, or a gate shipped in a different group from its subject are each red.

Property 2 is the one part that mechanizes. A seeded gate must declare a canary and refuse one having drifted onto a real value, and a kept gate must be a file that exists outside the tree with a reason that says which wall it hit — because a ledger entry pointing at a renamed file rots into a subject that reads as held.

## Shared values

Three things every capability handles, and none of them may be handled twice.

### An address is compared through `normalizeAddress`, and nothing else

`@pithy-sh/core/src/address/address` owns the rule for whether two strings are the same person. Four capabilities ask that question — `auth` matches a sign-in address, `email` suppresses one, `support` links a sender by `From`, `testers` invites one — and `matchmaking` resolves an invitee by one. Five copies of `trim().toLowerCase()` is five chances to drift apart, and drift here does not present as anything about addresses. It presents as "the suppression list did not work", or as one customer with two support threads, or as an invitation nobody can accept.

**What it normalizes**

- Surrounding whitespace.
- Case, in **both** halves. RFC 5321 says the local part is case-sensitive; no provider treats it that way, and treating `Ada@` and `ada@` as two people splits one customer's history in half.

**What it deliberately does not**

- **Subaddressing (`ada+shop@`) and dots.** Gmail collapses both; most providers do not. Folding them would merge two real people on a self-hosted domain. Showing one customer as two is recoverable; showing two customers as one is not.
- **Unicode normalization.** No NFC, no NFKC. NFKC maps distinct codepoints onto ASCII, which is the confusable-domain attack performed by us, on our own comparison.
- **IDN / punycode.** A unicode domain is not converted to `xn--`, or back. A project that accepts one spelling must accept only one, at its boundary.
- **Validation.** `normalizeAddress` is total: every string has a normal form, including the ones that are not addresses. Whether a string *is* an address belongs to the boundary that accepted it — Zod, or `parseAddress` where the input is a mail header. A normalizer that also rejects is a normalizer whose callers stop calling it.

`parseAddress` is the second function: it reads one address out of `Ada Lovelace <ada@example.com>`, bounds it at the RFC 5321 path limit, refuses anything that is not recognizably one address, and returns it normalized. Inbound mail is attacker-controlled, so it returns `undefined` rather than throwing — a malformed `From` is an expected input.

### Versions are ranked through `compareSemver`

`@pithy-sh/core/src/semver/semver` is semver §11.4, once. Ordering a release feed, deciding what sits between installed and latest, sorting a prerelease against the stable it precedes — all of it is the same four rules, and every one of them is a line to get wrong quietly: numeric identifiers compare numerically and alphanumerics lexically, a numeric identifier ranks *below* an alphanumeric one, a longer identifier set wins when every shared identifier is equal, and a stable outranks every prerelease of the same core. A second implementation does not fail; it puts a feed in the wrong order.

A caller that wants less may narrow it. The CLI's update notifier is the standing example: it drops the prerelease so a user on the stable channel is never nagged about an `rc.1`. The narrowing lives at the caller, not in the primitive.

### A language range is matched through `matchLocale`, and nothing else

`@pithy-sh/core/src/i18n/match` owns the rule for which supported locale a reader's tag means, and `../i18n/locale` owns the two questions under it — is this a tag at all (`parseLocale`), and which way does it run (`localeDirection`). Two modules ask the matcher — `@pithy-sh/i18n`'s resolver chain, which is both the server's and the browser's, and the pre-render pass a scaffolded `client.tsx` runs before the first paint — and `@pithy-sh/email` asks the parser, reducing a stored job locale to the catalog somebody actually wrote. Four copies of "take the part before the dash" is four chances to drift, and drift here does not present as anything about locales. It presents as an Argentine reading English, or as a page that says it is Arabic and lays out left to right.

**What it normalizes**

- Case, on both sides. `ES-ar` matches a supported `es-AR`, and the answer comes back spelled the way the project spelled it rather than the way the reader did.
- Truncation, per RFC 4647 §3.4 — `es-AR` finds `es`. A trailing single-character subtag is dropped with the one before it, so `en-a-bbb` truncates to `en` and never to the meaningless `en-a`.
- Maximization, but **third**, after the declared exception map and the walk on the range as written. It is what answers `zh-TW` with `zh-Hant`, by way of `zh-Hant-TW`. Third because `Intl.Locale` throws on input the first two steps handle fine, and maximizing `es` into `es-Latn-ES` only to walk back down to `es` is the same answer, three constructions and one `RangeError` later.

**What it deliberately does not**

- **Historical aliases.** `nb` meaning `no`, `tl` meaning `fil`. No truncation of either reaches the other, because the relationship is historical rather than structural, so no algorithm derives it and guessing would be inventing one. They are declared, per project, in `i18n({ exceptions })`.
- **Collapse the two locales.** Matching answers the *catalog* locale — the words somebody wrote — and the reader's own tag survives beside it as the formatting locale, whole. A matcher that returned one string is the bug where an Argentine reads Spanish and sees `1,234.56`.
- **Supply a default.** `matchLocale` answers `null` when nothing in the supported set is asked for. What to do about that is the chain's decision and the project's configuration, not the matcher's.
- **Validation.** Nothing here rejects: `parseLocale` answers `null` for `*`, `en_US`, an empty string and a token still carrying `;q=0.9`, and `localeDirection` answers `ltr` for all of them — because a document still needs a `dir` and guessing the other way mirrors a page nobody asked to mirror.

Totality is the point of the whole set. Every `Intl` construction on the path is guarded in one place, so an `Accept-Language` header full of malformed fragments falls through to the project default rather than raising a `RangeError` on the request path. A 500 is not a negotiation strategy.

`parseAcceptLanguage` is the second function: it reads a header into q-sorted ranges, bounded and guarded, so the **whole weighted list** is offered to the matcher rather than only its head. A project with no Portuguese, sent `pt-PT;q=1.0, es;q=0.8, en;q=0.5`, is being asked for Spanish.
