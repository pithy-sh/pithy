---
"@pithy-sh/payments": patch
---

Gate three parts of the Paddle rail that shipped with no test that could fail.

**The portal's owner filter.** `/payments/portal` reads the caller's own subscription ids and sends them to Paddle, which answers an authenticated cancel link per id — a bearer credential against that subscription. The route was green with the owner predicate deleted: the suite declared a Paddle portal fixture, wired it into the transport, and never set it, so nothing reached the route on that rail at all. Five cases now do, including two buyers on one deployment and a buyer who is a Paddle customer with no subscription of their own. Deleting the predicate, and replacing it with one that matches every user, each fail two of them.

**The sweep/map agreement.** The test claiming "every swept type is a type the map projects, and every projecting type is swept" built its candidate list out of the swept list, so nineteen of its twenty-eight checks were tautologies and neither claimed direction was asserted. The candidates are now Paddle's own published catalogue, transcribed from the API reference and independent of `events.ts`, and the two directions are separate tests: a set equality against what the map actually projects, and a per-type assertion that everything the sweep fetches projects. A type added to one and not the other fails, both ways round.

**The reconcile pass's sweep step.** The `sweep-paddle` step, the `--rail` narrowing that skips it, `report.swept`, and the retention-gap warning had one line of test between them. Ten cases now cover which rails sweep and which do not, that the step runs before the first page, that the report says "did not look" and "looked and found nothing" differently, and that a ninety-day gap reaches the trail as a warning naming the run.

Test-only. No behaviour changed.
