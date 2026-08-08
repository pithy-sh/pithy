---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

The rest of the line a manifest writes into a generated config.

#171 narrowed what a manifest may state as an option's **value**, so the renderer could only be handed shapes it prints the way Biome would. It left the option's `key` and its `describe` as `z.string().min(1)`, and both are interpolated raw into the TypeScript `pithy add` and `pithy upgrade` write. `renderConfigValue` guarded the keys of a *nested* object and threw; the line's own key had no guard at all.

The schema parsed every one of these and the renderer emitted every one of them: `content-type` became `content-type: "x",`, which is not TypeScript — Biome answers with three parse errors. So did `a"b`, `1`, `a b`, and `}) ; evil(`. A `describe` carrying a newline put its second line into `pithy.config.ts` as bare code; one with trailing whitespace failed `biome format`.

This is not only a formatting bug. A manifest is read from `node_modules/@pithy-sh/<cap>/pithy.manifest.json` — third-party data — and an option key is that data interpolated unescaped into generated source. `}) ; evil(` is the shape that makes the point. Nothing shipped today carries such a key: all 15 manifests and their 40 options are bare, so this was latent, and it predates #171.

`ConfigOption.key` is now a bare identifier and `ConfigOption.describe` is one line with no trailing whitespace — #171's own argument applied to the rest of the line. The refusal names the manifest and the option: `@pithy-sh/audit ships a malformed pithy.manifest.json: configOptions[1].key — A config option key must be a bare identifier, and "content-type" is not`. `renderConfigOptionLine` refuses the same keys, because `--set` reaches it without passing through a manifest.

The comment above the line had two producers, which is how the line below it came to have two in the first place. `renderConfigOptionComment` is now that one function, and `pithy add` and `pithy upgrade` both call it. `MissingConfigKey` stops copying the manifest's contract for `key` and `describe` and refers to it, as its `default` already did.

Every boundary here was measured by running Biome, not guessed. A line terminator ends a `//` comment and trailing whitespace fails the formatter; leading whitespace, an interior tab, non-ASCII, `${x}` and a comment of any length do not. A test renders both lines for every option in every manifest the repo ships into a real scaffold and runs that scaffold's own `biome check` over the result, with a control that proves the gate bites.
