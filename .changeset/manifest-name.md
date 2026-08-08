---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
---

A capability's own name and package, and the rule that stops the fourth one.

#171 narrowed a manifest option's **value**. #174 narrowed its **key** and its **describe**. Neither touched the capability's own `name`, which reaches generated TypeScript twice — the import binding and the registration call — or its `package`, which reaches the import specifier. Both were still `z.string().min(1)`.

Reproduced with the real CLI. A manifest declaring `"name": "audit }) ; evil("` was accepted, and `pithy add audit` wrote

```ts
import { audit }) ; evil( } from "@pithy-sh/audit/src/index";
    audit }) ; evil((),
```

then reported `Done.` A `"package": "@pithy-sh/audit/src/index\"; evil(); //"` closed the quoted specifier and appended a statement, and reported `Done.` too. A manifest is third-party data read from `node_modules`; this is that data interpolated unescaped into a file the adopter's own `bun run lint`, `tsc` and runtime all read.

`CapabilityManifest.name` is now a bare identifier and `package` an npm package name. `peerCapabilities` and `optionalCapabilities` are held to the same rule as `name`, because that is what they are. The refusal names the manifest and the field, as #174's does: `@pithy-sh/audit ships a malformed pithy.manifest.json: name — A capability name must be a bare identifier, and "audit }) ; evil(" is not`.

The two lines have producers now, as the option's two lines got in #174: `renderCapabilityImport` and `renderCapabilityRegistration` in `@pithy-sh/core`, total over what the schema parses. `pithy add` writes both through them; `pithy upgrade` writes the registration head through the second when it converts a one-liner into a block, which was the third place the name was interpolated by hand.

**The part that matters is the gate.** Three rounds, three fields, one rule that kept living at the call site that had just been fixed — so the rule is stated at the schema and enforced by a test that walks it: every string a manifest may state carries a pattern or a refinement, or it is named in `NEVER_RENDERED` with the reason no generated file can carry it. A string field added to `CapabilityManifest` with neither fails the build on the commit that adds it, whatever it is called. Deny by default, because enumerating the fields known at the time is exactly what produced the first two misses. A second test renders the **whole** config `pithy add` would write for every capability the repo ships — imports, registrations, option lines — and puts it through a real scaffold's own `biome check`, with a control that proves the gate bites.

Every consumer of `name` was checked under the narrowed type. The catalog now has a test that every built-in entry states a name and a package the manifest schema would accept, since a mismatch there would read as "not installed" forever. `pithy add --eject` builds its fork directory from the name, so the names that could escape `./capabilities/` are exactly the names the schema now refuses. `remove`'s test fixtures go through `parse` rather than a cast.
