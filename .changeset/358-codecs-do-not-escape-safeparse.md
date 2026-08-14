---
"@pithy-sh/core": patch
---

Make every codec report instead of throw, so `safeParse` keeps its promise.

`safeParse` cannot throw. Only `parse` throws. Every boundary reader in this kit and in the dashboard is written on that — `const parsed = X.safeParse(body); return parsed.success ? parsed.data : null;` — and several say *never throws* in their own doc comment. Zod's `safeParse` catches a `ZodError` and nothing else, so an exception raised inside a codec transform walks straight past it and out of the reader.

`JsonDate` and `SQLiteDate` threw an `InternalError` from inside `decode` when `Date` could not read the value. So `z.object({ at: JsonDate }).safeParse({ at: "not a date" })` did not return `{ success: false }`; it threw. Any reader over a shape containing a date was a 500 waiting for the first malformed timestamp a caller sent, and the caller picks the timestamp. The dashboard reads dates from customers' Workers on nearly every pane.

Both now push a Zod issue and return `z.NEVER`: `Not a date.`, client-safe, with the offending value on the issue's `input` where `fromZodError` drops it. The check moved onto the decoded result rather than the string branch, so `8.64e15 + 1` is refused too — it was silently falling through to `z.date()`.

The sweep found two more. `sqliteJson`'s `JSON.parse` throws a `SyntaxError` on a column holding text that is not a document, and its `JSON.stringify` throws a `TypeError` on a `BigInt` or a cycle the inner schema admits; both are issues now. `HttpError`'s encode ends in a `parse` inside `clientError`, which is defence in depth rather than a live bug, and is reported rather than raised for the same reason.

`parse` still throws, as `parse` should — a `ZodError`, which `fromZodError` maps to `validation/invalid_input` like every other failed parse. A malformed timestamp from a customer is now a rejected field rather than an outage.

The gate is `packages/cli/src/ci/codecSafety.test.ts`. It discovers every `z.codec(` under `packages/*/src` from the tree, holds the count to a frozen literal, and drives each one in both directions with inputs it must refuse. A codec added without a driver fails the build; so does a driver with no rejecting input. Fixing two functions would have left the fifth codec somebody writes next month exactly as exposed.
