# pithy privacy

_The site renders this for readers: [pithy.sh/docs/cli/commands/privacy](https://pithy.sh/docs/cli/commands/privacy). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Declare the privacy classes a project handles, close `console` behind them, and find the stored fields that read as private and are not marked. What a class is, what a marker does and what the control plane reports is [`docs/PRIVACY.md`](../PRIVACY.md).

## Synopsis

```bash
pithy privacy enable [--class <name>]... [--json]
pithy privacy scan [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `--class <name>` | `enable` only. A class to declare: `secret`, `pii`, `phi`, `pci`, or one you registered with `definePrivacyClass`. Repeatable, and a comma-separated list is read too: `--class pii --class phi` is `--class pii,phi`. No default: without it a terminal is asked, and a run that cannot ask is refused. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

### `pithy privacy enable`

Writes the root `pithy.config.ts` key, `privacy: { classes: [...] }`, and closes `console` in each linter config the project root holds: `biome.jsonc` or `biome.json`, and `.oxlintrc.json`. It needs no prompt when `--class` is passed, and a re-run writes nothing.

**The classes are added, never replaced.** `--class phi` on a project that declares `pii` declares both. Narrowing a declaration is an edit you make by hand.

**It writes literals in place.** The object the root config default-exports is found — `export default { … }`, or `export default config` over a `const config = { … }`, which is the starter's shape — and the key is added, or the starter's commented-out example uncommented. A `privacy` value that is an expression is never flattened: the run is refused, naming the line to write by hand, before a byte changes. The file is then read back through the real loader, and a read-back that disagrees restores it.

**It closes `console` by writing one `overrides` entry into each config it finds**: Biome's `suspicious/noConsole`, or Oxlint's `no-console`, at `error`, on every file under `apps/*/src` in a language the linters lint — `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` — and not on tests, because a test printing to a terminal is output for a person. In `.oxlintrc.json` that is `files` naming each extension and `excludeFiles: ["**/*.test.*"]`. That is wider than the starter's `no-console` safeguard, which covers `.ts`: once a class is declared, a `console` in any Worker file goes around the privacy gates the same way. It writes into a config only where the rule is not stated there at all. A rule you turned down on purpose — `warn`, `off`, an override lowering it on Worker source, a method let through by an allow-list, the linter disabled or Worker source left out of its includes or caught by `ignorePatterns` — is left alone and reported, and `pithy deploy` refuses until you change it. **With neither config present it writes nothing and says so**: deciding your toolchain is not this command's job, and the gate reads `unverifiable`.

**At a terminal it offers auditing, once.** *Turn on auditing too?* — an offer at the moment it is relevant, defaulting to no. Yes runs `pithy add audit`. No leaves the project exactly as working as it was. `pithy add audit` asks the inverse.

### `pithy privacy scan`

Walks the storage schemas each Worker under `apps/` composes — every capability's D1 tables and KV stores, the key, value and metadata of each — and reads each field's name. A name whose last words read as private is a **candidate**, with the class it suggests and the marker to wrap its schema in. A field already marked is **covered**. It prints the report and exits 0, whatever it finds. It edits no file and fails no build.

| Reads as | When the name ends in |
|---|---|
| `pii` | `email`, `phone`, `phone number`, `mobile`, `address`, `ip`, `postal code`, `zip`, `zip code`, `first name`, `last name`, `full name`, `date of birth`, `birth date`, `birthday`, `dob`, `ssn`, `national id`, `passport` |
| `phi` | `diagnosis`, `diagnoses`, `medication`, `medications`, `prescription`, `prescriptions`, `treatment`, `allergy`, `allergies`, `symptoms`, `medical record`, `mrn`, `blood type` |
| `pci` | `card number`, `pan`, `cvv`, `cvc` |
| `secret` | `password`, `password hash`, `passphrase`, `token`, `secret`, `api key`, `otp` |

A name is split into words first, so `contactEmail`, `contact_email` and `contact-email` all end in `email`, and `ownership` does not end in `ip`.

**It reaches the schemas the way every command does: through each Worker's own `pithy.config.ts` and the capabilities it composes.** It does not import arbitrary modules looking for exported Zod objects. A config is already something the CLI resolves, and walking its capabilities' storage schemas is walking exactly what the control plane's inventory walks. It walks them with the inventory's own walk, so the scan and the report cannot disagree about what was covered: a marked root, array element or record value is covered in both. A schema that is not stored — a request body, an email template — is not reached. A Worker whose config does not load is reported as not scanned, with the reason.

**A kit capability's field is reported, and is the kit's to mark.** `@pithy-sh/auth` stores an email. The finding says so and says the kit marks it, because a marker in a package you do not own is not one you can apply.

**It advises, and the marking stays yours.** Which of your fields are regulated is a question about your jurisdiction, your sector and your counsel. A tool that surfaces candidates is useful the day you inherit a codebase. One that locked your data down on a heuristic would be Pithy deciding your compliance posture for you.

## `--json`

One line on stdout.

### `pithy privacy enable --json`

| key | type | meaning |
|---|---|---|
| `command` | string | `"privacy enable"`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `classes` | string[] | Every class the root config now declares, the built-ins first in their fixed order. |
| `configChanged` | boolean | Whether the root `pithy.config.ts` was written. `false` on a re-run. |
| `biomeChanged` | boolean | Whether the Biome config was written. `false` when the rule was already on, turned down, or there is no Biome config. |
| `oxlintChanged` | boolean | Whether `.oxlintrc.json` was written. `false` when the rule was already on, turned down, or there is no `.oxlintrc.json`. |
| `consoleGate` | object | The console gate after this run, as `pithy deploy` will read it. |
| `consoleGate.state` | string | `"enforced"`, `"off"` (deploy refuses), or `"unverifiable"` (no linter config Pithy can read). With both linters configured, `enforced` only when both close the rule. |
| `consoleGate.file` | string \| null | The config the state is about, project-relative — `"biome.jsonc and .oxlintrc.json"` when both were read and both close it — or `null` when there is none. |
| `consoleGate.reason` | string \| null | Why it is not enforced, in one sentence. `null` when it is. |

### `pithy privacy scan --json`

| key | type | meaning |
|---|---|---|
| `command` | string | `"privacy scan"`. |
| `schemaVersion` | integer | The version of this payload's shape. |
| `findings` | object[] | Every candidate and every covered field, Worker by Worker. |
| `findings[].worker` | string | The Worker under `apps/` that composes it. |
| `findings[].capability` | string | The capability that declares the schema. |
| `findings[].owner` | string | `"app"` for your own schema; `"kit"` for a `@pithy-sh/*` capability's. |
| `findings[].storage` | string | `"d1"` or `"kv"`. |
| `findings[].container` | string | The D1 database or KV namespace it lives in. |
| `findings[].schema` | string | The table name, or the KV store name. |
| `findings[].path` | string | The field's path: `email`, `profile.phone`, `key.email`, `value.token`. |
| `findings[].status` | string | `"candidate"` (reads as private, unmarked) or `"covered"` (marked). |
| `findings[].class` | string | For a candidate, the class its name suggests; for a covered field, the class it carries. |
| `findings[].marker` | string \| null | For a candidate, the marker to apply — `"pii(…)"`. `null` for a covered field. |
| `candidates` | integer | How many findings are candidates. |
| `covered` | integer | How many findings are covered. |
| `unreadable` | object[] | Workers whose config did not load: `{ worker, reason }`. Their schemas were not scanned. |

## Errors

- **`Name a class to declare.`** `enable` with no `--class`, and nothing can be asked. `input/required`, naming `--class` and the four built-in classes. Exit 2.
- **`"<name>" is not a privacy class name.`** A class is a lowercase identifier: letters, digits and underscores.
- **`Could not write the privacy declaration into <path>.`** The root config does not default-export an object literal `enable` can find, or its `privacy` value is an expression. The action is the line to add by hand.
- **`The \`privacy\` block in pithy.config.ts is not valid.`** Read on every command that loads the root config, so a misspelled `clases` refuses rather than reading as nothing declared.

`pithy privacy scan` refuses nothing it finds. A Worker it cannot read is a row in `unreadable`, and the run still exits 0.

## Examples

```console
$ pithy privacy enable --class pii --class phi
Declared pii, phi in pithy.config.ts.
Wrote suspicious/noConsole into biome.jsonc.
Console is closed.
Done.
```

```console
$ pithy privacy scan
api app patients.email: reads as pii. Mark it pii(…)
api app patients.diagnosis: covered, phi.
api auth users.email: reads as pii. A kit schema — the kit marks it, not you.
2 to consider, 1 covered. Advice only: nothing was changed.
```
