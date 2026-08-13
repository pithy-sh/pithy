---
"@pithy-sh/core": patch
---

A `__proto__` key in a manifest is refused, where it used to disappear.

`needs` on a `helped` secret is keyed by issuer, and a key is preserved verbatim rather than degraded — rewriting two unknown issuers onto `other` loses one of them's requirements in silence. That rule was written and, for one key name, never ran. `JSON.parse` gives `__proto__` an own property; Zod skips it while projecting a record, because assigning it would replace the prototype of the object being built. Both decisions are right on their own. Together they meant a key entered the parse, matched no rule, raised no issue, and was not in the result. `{ __proto__: ["deployments:write"] }` parsed successfully to `{}`.

`manifestRecord` refuses it instead. Refuse rather than degrade: an unrecognised *issuer* degrades to `other` so a client built today can read a manifest written tomorrow, but `__proto__` is not a name a future issuer will carry, and degrading a key is the merge the key rule exists to prevent. A manifest that will not parse is reported by every client that reads it; a key that vanishes is reported by none.

Both records a manifest may state are behind the guard — `needs`, and the object form of a config option's `default`. `manifestRecord.test.ts` walks `CapabilityManifest` and attacks every record it finds with a key that would vanish, so a record added later without the guard fails on the commit that adds it rather than on the manifest that exploits it.
