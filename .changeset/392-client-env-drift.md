---
"@pithy-sh/cli": patch
"@pithy-sh/vite": patch
"@pithy-sh/ui-react": patch
---

The ambient types for `virtual:pithy/*` are now compiled against the projections they describe.

`templates/client-env.d.ts` is 144 lines of hand-written declarations for four modules, copied into an adopter's Worker by `pithy ui add react`. The producers are each capability's `client:` projection, resolved by `resolveClientProjection` and rendered by `renderVirtualModule`, three packages away. Nothing compared them.

**Because the declaration is the type, the compiler could not notice a drift.** A field a projection stopped emitting still typechecked everywhere in the adopter's app — the declaration said it existed. It was `undefined` at runtime, in production, in a browser, and nothing between here and there went red. The only checks were substring assertions in `@pithy-sh/cli` confirming the file against itself; the removal direction is precisely the one they cannot see, because the file still contains the string.

`@pithy-sh/vite`'s `src/clientEnv.test.ts` closes it. Fifteen cases, each a real capability resolved through the real `resolveClientProjection` and rendered by the real `renderVirtualModule` — both branches of every union, the absent-capability answer included — and the rendered literal is assigned to the declared type in a throwaway TypeScript program with `tsc` as the comparator. Narrowing the union with `Extract` before the assignment is what makes it exact in both directions: a fresh object literal against a single object type is missing-property-checked and excess-property-checked at once. No expectation is written down anywhere.

Proven able to fail, and permanently: every field of every projection, at every depth, is dropped, added beside, and retyped — one module each, three compiler runs — and every one must be red. That is also the reach assertion. A declared property this suite leaves green is one an adopter could read after the projection stopped writing it.

It stays hand-written. Generating it is the better shape, but `Capability.client` is typed `(context) => ClientProjection` — `{ enabled: boolean }` plus a JSON catchall — so a capability's real shape exists only as an inferred object literal inside a closure and is erased at the interface. The only source in reach is the projected values, and a type inferred from a value is weaker than the file it would replace: the literal unions, the nullable blocks and the product element type all collapse to whichever branch one sample config took, and every doc comment is lost. No build step is involved either way.

The CLI now asserts what is actually its own: the bytes it seeds are that file's, unaltered, in every scaffold.
