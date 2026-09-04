---
"@pithy-sh/cli": patch
---

A project name is validated where it becomes a path segment, not at every call site that happens to have normalized it.

`devSecretsDir` and `devPreferencesPath` joined a project name into `<config>/<project>/` with the rule that the name was safe to put in a path living at each caller. **Nothing was broken**: every caller passes a name already through `requireProjectName` or `kebab`. This is the step that keeps it that way.

That is the #183 shape — #171 narrowed a manifest's default values, #174 an option's key and describe, #183 the capability's own name: three rounds for one rule that was never stated where it belonged. And the reason each caller here is safe is that it *happens* to have normalized earlier, which is a property of the call graph. #206 added a caller to this family within a day of the last one.

Worth closing while it is theoretical because of what that directory now holds: `secrets.jsonc`, `dev.json`, `tokens.json`, and since #206 the account-scoped credentials beside it. The gates that guard project writes do not reach it — `ensureScaffoldPath` guards writes *inside a project*, and this path is outside every checkout. There is no second line of defense.

Both functions now resolve through one door, `projectConfigDir`, which validates in two halves because a name arrives two ways (#206's phrasing). `assertValidProjectName` is read *after* kebabbing, deliberately: `Acme Corp` is a legal project name because it becomes `acme-corp`. So it is a statement about the slug, not about the string in hand — `My/Project` passes it whole, and joined verbatim it is two path segments. The second half is that the value **is** its own normalized form, so the typed name and the slug are held to one rule instead of the rule being true of only one of them.

A gate states the invariant: **no config string is joined into the config directory without passing a validator**. It is stated about the segment rather than as a list of the two joiners known today, since enumerating is what produced the second and third instance of every other class of this here. What it carries instead is a list of *validators*, each with the argument that it is one — a list that grows when somebody makes a new kind of string safe, not when somebody writes a new join.
