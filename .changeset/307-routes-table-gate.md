---
"@pithy-sh/payments": patch
---

The payments Routes table lists every route the capability registers, and a test holds it there.

It was missing the four management reads, and then the catalog read, so the one table a person reads to find out whether this capability can answer their question said the answer was no. A management client discovers routes from the manifest; nobody chooses a capability from a manifest.

The gap had already cost something once. The fifth management read deliberately withheld its row, because one row in a table missing four peers reads as completeness — so the table was wrong about five routes, and the next person would have faced the same choice.

So the fix is the gate rather than the paragraph: `routeContract.test.ts` parses the table and compares it against the real registrations **in both directions**. A route with no row is the omission that happened; a row with no route is a table describing a surface that was removed, which is the same lie told the other way round. Every control-plane row now names the scope its guard demands, and a scope with no row named against it fails too.
