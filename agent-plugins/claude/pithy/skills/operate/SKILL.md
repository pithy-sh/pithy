---
name: operate
description: Lets this session administer a deployed Pithy app's staging or production environment, through pithy mcp. Connects an agent with the reads first, asks before every call that changes anything, widens the grant only on a yes. Use when someone wants the session to read the audit trail, triage support, check a user or otherwise operate a live app.
argument-hint: "[staging|prod]"
---

Let this session administer one deployed environment through its own control-plane connection. You are the main session. The tools are the Worker's own admin routes, served by `pithy mcp serve` on this machine, and every call is verified, refused or allowed, and audited by the person's Worker with actor kind `agent`. Nothing is hosted.

This is not the app's own `/mcp` endpoint, where the app's users connect their agents. That one is `mcp({ floor })`, and `/app-design` settles it.

## 1. Which environment

`staging` unless they say otherwise. One connection per environment: a yes for staging is not a yes for production. Check what is already there with `pithy mcp status --json`, which is yours to run.

**An environment holds one connection: the dashboard's or an agent's, never both.** Read `actorKind` from `pithy dashboard status --env <env> --json`, which is yours to run. `connected: false` means nothing is there: go to step 2. `actorKind` `dashboard`, `script` or null means the connect is refused: say so, and leave the choice to the person. Never disconnect it yourself. `agent` means an agent's connection already exists, perhaps a teammate's or this person's on another machine: a new key joins it and takes its grant, so offer the step 2 command without `--scope`, and change the grant only through step 4.

## 2. Grant the reads first

Start with `manifest:read` plus only the `reads` scopes the person needs. `manifest:read` is required: the server reads the manifest under it on every tool list, and without it no tool is offered. Never `--scope all`, and never a write, a send, a charge, a delete or a credential scope on the first grant. Ask what the connection is for, in their words: it is recorded as its purpose.

Offer it as `! pithy mcp connect …`, for the person to run themselves: it registers a credential under their signed-in session. Always name the grant, one `--scope <read>` per read the person needs:

```bash
! pithy mcp connect --env <env> --purpose '<their words>' --client claude-code --scope manifest:read --scope <read>
```

A `!` command has no terminal, so a connect that names no `--scope` asks nobody and stores the default grant: every read plus `keys:rotate`, which mints credentials. Only when the person runs it without `--scope` in their own terminal does it list every operation, preselected to that same default, for them to deselect `keys:rotate` and anything past what they asked for.

Once it reports `Done.`, tell them to restart Claude Code, or run `/mcp`, so the session picks up the new server. Its tools are named `<capability>_<operation>`.

## 3. Call

A read needs no question. Read each tool's kind from its MCP annotations, never from its name:

- `readOnlyHint: true` is a read. Call it.
- Every tool carries `readOnlyHint`, so anything with `readOnlyHint: false` needs a yes: it writes, sends, charges, deletes or changes a credential. `destructiveHint: true` marks a charge, a delete or a credential change; the description's first sentence says which.

**Before any call that is not a read, ask for a yes for that call.** Name the tool, what it will do in the description's words, and its input. A yes is for one call: never for the next, and never for a loop.

A call the Worker refuses for a missing scope is not offered again under another tool. Say what it needs and go to step 4.

## 4. Widen the grant

Only on the person's yes, naming each scope and its kind. `--update` replaces the grant with exactly the scopes given, so pass every scope to keep, `manifest:read` included:

```bash
! pithy mcp connect --env <env> --update --scope manifest:read --scope <scope>
```

Then `/mcp` again.

## 5. Close it

`pithy mcp disconnect` is the person's. It revokes the key on their Worker and removes the key file, the client entry and the record. Give them the command, `pithy mcp disconnect --connection <alias>`, with the alias `pithy mcp status --json` names.

## CI

A job connects with a workload trust instead of a key, through `pithy mcp connect --env <env> --purpose '<text>' --oidc-issuer <issuer> --oidc-claim <name=value> --scope manifest:read --scope <read>`, and holds no key at all. Name the grant here too: away from a terminal, a trust registered with no `--scope` holds the same default as step 2's. It is the person's to set up.

## Report

The environment, the connection's alias and grant, each call that changed anything and the yes it ran on, and anything left for the person: a scope to widen, a connection to close.
