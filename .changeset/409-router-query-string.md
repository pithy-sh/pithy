---
"@pithy-sh/ui-react": minor
"@pithy-sh/cli": patch
---

The scaffolded SPA router reads and writes the query string.

`usePath()` had no counterpart for `window.location.search`, and there was no `replace`. A screen whose state belongs in the address bar but not in the route had nowhere to put it, so it stayed in `useState` where history could not see it and the back button left the application. `pithy-sh/dashboard` is exactly that shape — a rail, an index and a record on one screen, where which kind and which row are navigation but neither is a route, because the rail is composed from a customer's manifest and `/users/usr_9f2c` would be a pattern for a set that may not exist on the next connection.

Four exports, all against the `popstate` subscription that was already there. `useSearch()` returns `window.location.search` verbatim — the leading `?`, or `""`. `useSearchParam(name)` returns one decoded value, or `null`. `replace(to)` swaps the current entry rather than pushing one. `updateSearch(patch, options?)` sets a key for a string, clears it for `null`, and leaves everything else alone.

**Both readers hand back primitives, and that is the decision.** A `URLSearchParams` is a new object every render, so every `useMemo`, `useEffect` and `useCallback` downstream of one re-runs forever.

**`updateSearch` exists because the hand-rolled version has a trap that every call site meets separately.** Writing one parameter means reading the query, parsing it, setting a key, serializing it, and joining it back onto the path — and the join is where it goes wrong. `window.location.search` is `""` and never `"?"`, so a writer that appends a bare `?` after clearing its last parameter produces a URL that never equals the current one: every repeat call pushes another entry, and Back then walks through them one at a time without the page ever changing. Carrying the hash across is the other half nobody remembers. Both are handled once, here.

`replace` is for a correction the reader did not make — a selection clamped back to nothing, a kind that left the manifest. Pushing one of those puts a state nobody chose into the back stack, and Back then lands on it and it is corrected again, forever. A place the reader *chose* to go is a push, which is why `<Link>` has no `replace`.

`routes/pithy/otp.tsx` reads its prefilled address through `useSearchParam` now. It was the one template screen touching `window.location` directly, and it happened to work only because nothing navigates within that screen — a property of today's screens rather than of the router.
