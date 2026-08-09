# Engineering conventions

Rules that outlived the change that produced them. Each one is here because the same defect was written
more than once, by more than one person, after somebody had already worked out the answer and left it in
a comment in one file where nobody else read it.

`docs/CLI.md` says what a refusal looks like. This says what it is allowed to claim.

## Refusals

### A `catch` may not name a remedy it cannot know

**If a `catch` block can be reached by more than one underlying failure, its `action` may not name a
single specific remedy.** Classify the cause and answer each one, or hedge.

Hedging is not "list every remedy". It is either saying less — a sentence that admits what is not known —
or naming the possibilities *with the test that tells them apart*, so the reader can pick. What is banned
is one remedy asserted over failures it cannot address.

A wrong action is worse than no action, because it is followed. An adopter reads the second line, does
what it says, nothing changes, and the thing that would have told them — the resolver's specifier, the
parser's position, the errno — was captured into `detail` and discarded one frame up.

Someone worked this out and wrote it down in `packages/cli/src/capabilities/manifests.ts`:

> A manifest that is there and will not open is **not** "not installed": telling an adopter to run
> `pithy add auth` when the file is unreadable sends them to the command that just declined to run.

That was one file. It did not spread. #207 fixed one instance of the same defect in the config loader,
and the survey it asked for found twenty more — fourteen of them the identical line in seven files. Hence
a rule, rather than a twenty-first patch.

#### The shape to look for

- Several `import()` calls in one `try`, with an `action` naming one package.
- A read and a parse in one `try`, with an `action` that asserts the file is missing.
- A file-read `catch` whose `action` says *check permissions* — `EACCES` is one errno; `EISDIR`, `ELOOP`
  and `EIO` are the others, and `chmod` answers none of them.
- A `fetch` `catch` whose `action` names the URL — DNS, TLS, a refused port, a dead network and this
  process's own timeout all land there, and only one of them is about the URL.
- One error-building helper shared by several call sites with the `action` baked into the helper. If the
  helper takes `message` and `detail` per site but not `action`, the `action` is a constant across
  failures that are not.

#### How to classify

The three worked examples, in order of how much they had to say:

| Where | Function | Splits |
| --- | --- | --- |
| `packages/cli/src/project/config.ts` | `classifyConfigLoadFailure` | unresolved-import / parse-error / threw-on-load / unknown |
| `packages/cli/src/capabilities/loadFailure.ts` | `classifyCapabilityLoadFailure` | not-installed / dependency-unresolved / broken / unknown |
| `packages/vite/src/workerConfig.ts` | `classifyWorkerConfigFailure` | as the first, restated because `@pithy-sh/vite` must not depend on the CLI |

Rules that hold for all of them:

1. **Duck-type the cause. Never `instanceof`.** The `bin` ships on **Bun**, whose `ResolveMessage` and
   `BuildMessage` are their own classes and are **not** `instanceof Error`. Vitest runs on **Node**, so
   `Error`-shaped fixtures hide this completely: #207's first implementation gated on `instanceof Error`,
   passed all 32 tests, and dropped the parser's sentence on the only runtime adopters use. Read
   `message`, `name`, `code`, `specifier` and `position` as properties off an `unknown`.
2. **Export the classifier and test it directly.** The runtime the suite reaches is not the runtime that
   ships. A classifier tested as a pure function against both runtimes' real error shapes is tested for
   both; one reachable only through an integration path is tested for neither.
3. **Verify on Bun, not only under vitest.** Run the real code against a real broken fixture on Bun
   before claiming a classifier works. This is not ceremony — doing it for #217 found two defects that
   every passing Node fixture had hidden:

   - **Bun does not always throw `BuildMessage` from `import()`.** One diagnostic arrives bare; **two or
     more arrive wrapped in an `AggregateError`** whose `errors` array holds them, whose own `message` is
     `2 errors building "<absolute path>"`, and whose `Object.keys` is empty. A stray brace cascades, so
     the wrapped case is the common one. Classify the wrapper and a syntax error reads as "it threw",
     losing the parser's sentence and position — the exact loss #207 existed to prevent. Unwrap first.
     `classifyConfigLoadFailure` still has this gap: a `pithy.config.ts` with one syntax error gets
     `parse-error` and the position, and the same file with two gets `threw-on-load` and nothing.
   - **Bun does not use node's network errnos.** A dead host, a bogus TLD and a refused port all arrive
     as one `code: "ConnectionRefused"` on a plain `Error`; node wraps in `TypeError: fetch failed` and
     puts `ENOTFOUND` or `ECONNREFUSED` on the `cause`. Bun cannot tell DNS from a refused port, so the
     code must not claim to either: its branch names both. TLS codes are the one place the two agree.

   A classifier that reads a cause is only as good as the runtime it was checked against. Check both.
4. **The unknown branch gets no remedy.** Not a guess, not the most likely one. A sentence that admits it
   does not know, and a `detail` that carries everything.
5. **`action` carries no absolute path, no source line, no stack.** A specifier is the adopter's own
   import and may travel; the referrer path is our frame and may not. Decide by content, not provenance —
   see `safeReason`.

#### Or do not classify

Classifying is not always the answer. Two cheaper ones:

- **Use a primitive that already decided.** `readOptionalFile` separates "absent" from "there and would
  not open" and hedges correctly on the second; `requireRecord` separates "parsed" from "parsed to
  something that is not a document". A call site that uses both has three failures with three sentences
  and wrote none of the logic.
- **Split the `try`.** Two `try` blocks around a read and a parse cost one line and remove the ambiguity
  entirely. Most of the six non-loader sites in #217 were fixed this way.

#### Where the shared code lives

A classification used by two call sites may stay at both. **Three is this repository's count** for
hoisting a rule out of its call sites — the same threshold `readOptionalFile.ts` states for itself. When
a third appears, the home is beside the primitive that owns the decision, not in a `utils` file.
