---
"@pithy-sh/secrets": minor
"@pithy-sh/core": minor
---

A secret rotated and no client could see how, or ask for one.

`#322` put `rotation` on the registry entry and `#367` shipped `pithy secrets rotate`, and neither reached a remote client. `SecretStatusView` carried eleven fields and `rotation` was not among them, so **no shape a management client could read said whether a secret rotates by `local`, `provider` or `manual`** — and `rotatable` is explicitly not the same question (`SECRETS_ENCRYPTION_KEYS` is `local` and `rotatable: false`; a payments credential is `rotatable: true` and rotates only by hand). A client's only conservative reading was to give every secret an instruction and none of them a control. There was also no `POST` anywhere in the package, so there was nothing for a management client's rotation to open.

## `rotation` on the status read

`GET {base}/admin/status` now reports each secret's rotation declaration verbatim: the kind, the issuer, and the documentation page. `null` when the entry declares none, which is a different fact from `manual` — nobody has said, rather than somebody has said it takes a human.

No value fits in any of it. A kind from a closed set, an issuer from a closed set, and a URL the schema holds to `https:`, copied from a registry entry `defineSecretRegistry` already validated. `SECRET_RESPONSES_CARRY_NO_VALUE` still holds, the exact-field-set tests still assert the whole shape, and the response sweep now names the three nested keys explicitly rather than deriving them. An issuer a client has never heard of parses as `other` rather than throwing, so a Worker newer than its reader still renders.

## `POST {base}/admin/status/:name/rotate`, behind `secrets:rotate`

Its own scope, and that is the load-bearing decision. `scopeCovers` matches exactly, so a scope confers every route requiring it — a rotation behind `secrets:status:read` would have handed credential replacement to every adopter who ever wanted a status pane, retroactively and without being asked. It never enters a default grant either: `defaultGrant` classifies by route method, and every route requiring this scope is a `POST`.

**A rotation supplies nothing, which is why this write can exist where create and update cannot.** A management client holds neither the adopter's registry nor their Zod schemas, so it could not write a value against the schema that governs it. A rotation's successor is produced *inside* the Worker — minted from the entry's own recipe, or returned by the rotator its registry entry carries — so no value crosses in either direction. The route takes no body at all.

It answers `rotateSecretValue`'s outcome faithfully and per environment: `rotated` / `unchanged` / `unrecorded` / `failed`, with `recorded` and `stranded` named, `rolled` and `rollFailed` distinguishing *was rolled* from *may have been rolled*, and no field a value could sit in — `cause` is dropped at the projection, because an exception raised inside a rotator is raised in the one place a credential is definitely in scope. **200 for every status, including `unrecorded`**: throwing would render one sentence and drop `recorded` and `stranded`, which is the "all rotated" summary over a partial failure the whole design refuses.

Every rotation opens a `pithy_secrets_rotations` row against the management client's own subject, before the roll, and closes it after — so *who rolled the production key on the twelfth* has an answer, a rotator that never returns still leaves a trace, and a rotated secret stops reporting overdue. Audited as `secrets/rotated`, the same code the CLI emits for the same act, `critical` on `unrecorded`.

## A Worker rotates less than the CLI does, and says so

`pithy secrets rotate` runs in a process holding the project: the registry from source, a Cloudflare token, a dispatcher to every environment's manager. A Worker holds one environment's D1 and its own master key. So a `cf-secrets-store` secret (an account-level entry written through Cloudflare's API with a token an app Worker must never hold) and a `global` secret (identical everywhere by definition, and writing one environment would strand the rest under one name) are refused with the new `secrets/rotation_unsupported` (409), naming the command that can — before anything is called.

So is a name this environment has never stored. `runWriteSecret` in `update` mode raises on a missing name, and reaching that raise *after* a provider roll would manufacture the unrecorded incident out of a configuration gap that cost nothing to check.

`secrets/rotation_unsupported` is its own code because a client has three different things to render and only one of them is a mistake: *you may not* is a scope refusal, *it broke* is a fault, and this is neither — it is *run the command*. The free path is in `message`, since `action` is stripped at the HTTP boundary.
