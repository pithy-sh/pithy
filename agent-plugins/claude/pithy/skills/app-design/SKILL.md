---
name: app-design
description: Settle a Pithy app's capabilities, data model and auth flows before any code is written. Use at the start of a new app, or before a change that adds a capability, a table or a sign-in method.
---

Settle the decisions that are expensive to get wrong, before anyone writes code. You are the main session. Ask, decide with the user, and write the result down in this conversation. Do not delegate this.

Ask one question at a time. Recommend an answer with each, and say why in one sentence.

## 1. The capabilities

Run `pithy add --list --json` for what the installed kit offers, with each capability's reason to enable. For each candidate, decide yes or no with the user. Prefer a capability to app code: a capability is maintained and upgraded with the kit, and app code is not. Note the prerequisites each one names.

If a capability the app needs does not exist, or exists and cannot do what the app needs, that is a kit gap. Note it, and file it with `/report-kit-gap` once the design is settled.

## 2. The data model

For each table the app owns:

- Its name. Never `pithy_`-prefixed: that prefix is the kit's.
- One Zod object per table, every field with `.describe()`. That object is the table definition. There is no second interface.
- Its id: an auto-increment number by default, a UUID for anything exposed to a caller, so ids cannot be enumerated.
- Which Worker owns it, and whether another Worker shares it by declaring the same binding name.

Do not model what a capability already stores. Users, sessions, organizations, purchases and media belong to their capabilities. Reference them by id.

## 3. The auth flows

- **Who signs in, and how:** magic link, one-time code, a social provider, or several. Each social provider needs credentials the user registers.
- **Each client's credential.** A mobile app always uses bearer tokens, kept in the device's secure storage. A web app uses either a cookie session on the same origin, with CSRF protection always on, or the same bearer flow. Pick one per client and do not mix them.
- **Which routes are public, and which need a scope** beyond a signed-in user.

## 4. The clients

Web, mobile, or both. This is `pithy init --target`, and it decides which agents build.

## 5. Write it down

Summarize the decisions in this conversation, in one short section per heading above. That summary is what the server agent builds from. A decision the user deferred is listed as open, not guessed.
