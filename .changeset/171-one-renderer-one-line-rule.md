---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

One renderer for a manifest default, one gate for the line it lands on.

#168 replaced `JSON.stringify` with `renderConfigValue` so a generated `pithy.config.ts` would already be in the shape Biome prints. It replaced one of two. `pithy upgrade` kept its own copy, so the same manifest produced `[{ code: "chips", name: "Chips" }]` from `pithy add` and `[{"code":"chips","name":"Chips"}]` from `pithy upgrade` — and only the first survived the `biome check` a scaffolded project runs on itself. Both commands now render through `renderConfigOptionLine`, which is the whole line and not just the value, and a test asserts the two commands agree rather than asserting a string. That is what stops a third producer.

The one-line rule was a docstring. Biome breaks any literal past 120 columns and explodes it across a dozen lines, which fails `biome check` on a project the adopter has not touched — the defect #161 and #168 were both about. Nothing checked it, and the margin was thinner than it looked: multiplayer's seed is 98 columns of 120, and a `battle` game with a two-move catalog reaches 135. It is now a test over every manifest the repo ships, rendered at the indent the writers really use. A sixteenth capability with an oversized seed fails the build instead of an adopter's first `bun run lint`.

`ConfigOptionValue` narrows rather than the renderer growing a copy of Biome's formatter. Three shapes the widened type admitted did not print the way Biome prints: `he said "hi"` renders with escaped quotes where Biome writes `'he said "hi"'`, `1e21` renders as `1e+21` where Biome writes `1e21`, and `"${x}"` renders valid TypeScript that trips `noTemplateCurlyInString`. The alternative was to carry a quote-preference heuristic and a numeric-literal normalizer, and keep both in step with a formatter free to change either — for inputs no worked example should carry. A manifest default is an example; one needing a quote inside a string is already too clever. The schema refuses all three, and `renderConfigValue` refuses them too, so `pithy add --set` fails at the command rather than writing a file that fails the lint gate later.

The test that asserted the escaped-quote rendering as correct is corrected. It pinned a violation of the function's own stated contract, which would have made the fix look like a deliberate assertion being deleted.

Every case above was checked by writing the rendered output to a file and running Biome over it with the scaffold's own `biome.jsonc`. The whole defect class here is guessing what Biome would print.
