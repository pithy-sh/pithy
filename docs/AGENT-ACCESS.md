# Agent access

_The written form of a decision taken on 2026-10-13. This is reference rather than a plan: it states the model an implementation must match, and the modules that implement each section are to cite it by name, the way `packages/cli/src/dashboard/contract.ts` cites [`CONTROL-PLANE.md`](CONTROL-PLANE.md)._

How an AI agent reaches a Pithy application — as an operator of the system, or as a user of the app — and why those are two different answers.

---

## 1. Two kinds of agent. Conflating them is the mistake this document exists to prevent.

Read this section first. Every other decision here follows from it, and the two cases look similar enough that they will be merged by anyone who skips it.

**An agent building on Pithy** is a developer's coding agent, writing an app against the kit, on a developer's machine. The blast radius is a checkout. This is served already: the CLI is an agent's first-class interface, the docs server answers questions about the kit, and `pithy schema --json` describes the data model.

**An agent operating a live application** holds a credential against a deployed system and acts on real customers. It is the subject of this document, and it divides again:

| | Administering the system | Using the app |
|---|---|---|
| What it does | Reads the audit trail, suspends a user, repairs an entitlement, runs a saved analytical query | Calls the app's own routes as somebody |
| Whose authority | An **external management client**, authorized by the adopter | A **user of the app**, authorized by their own account |
| Reaches it through | The control-plane seam | The app's own routes |
| Authorized by | Control-plane **scopes** on a connection | **Powers**, through the user's role |
| Creates a session? | No — [`CONTROL-PLANE.md` §10](CONTROL-PLANE.md) | Yes; it *is* a session |

**The line is drawn by the architecture, not imposed on it.** An operator is not a user of the application, and modeling one as a user would place an administrator inside the tenancy it administers. The seam already refuses to do that: a control-plane call creates no user and no session. So an agent that acts *as somebody* authenticates as that somebody, and an agent that acts *on the system* does not authenticate as anybody at all.

**Which kind a feature needs is a property of the feature, not of the customer.** A saved analytical query called by a customer's own agent is the second kind. An agent summarizing last night's audit events is the first. The same adopter may want both.

---

## 2. Scopes and powers are separate systems, and neither is evidence for the other

Two vocabularies, two callers, no translation table between them.

| | Control-plane **scopes** | **Powers** |
|---|---|---|
| Answers | What did this Worker grant an external management client? | What may a user of this app do inside it? |
| Held by | A connection | A membership, through a role |
| Declared by | Each capability, federated — `payments:entitlements:grant` | `KIT_POWERS`'s five, plus the adopter's own, through `defineRoles` |
| Pattern | `resource:action`, or `resource:sub:action` | The adopter's own vocabulary beside the reserved five |
| Enforced by | `requireControlPlane(scope)` | `requirePowerOnRoute(power)` |

**A management client's own roles are a third thing again.** The hosted dashboard declares `connections:read` and `connections:manage` as *its* powers, and what they gate is who on *its* side may ask for a control-plane call. [`CONTROL-PLANE.md` §9](CONTROL-PLANE.md) states the rule that governs all three: both gates apply, in order, and one is never evidence for the other.

---

## 3. The administering path

**The control-plane MCP server is a stdio server shipped with the CLI.** Not a capability, and not hosted by anyone.

Three structural reasons it cannot be a capability composed into the adopter's Worker:

- `requireControlPlane` verifies a **registered external key**. A server inside the Worker is inside the trust boundary and cannot use the seam it exists to expose.
- The signer must hold the private key. An in-Worker server would make the adopter's Worker a key custodian for every agent pointed at it.
- A Worker cannot fetch its own hostname — the subrequest loops back through the edge and times out, which is why a self-addressed call goes through a binding instead. An in-Worker MCP server could not reach the control-plane routes over HTTP at all.

And it is not hosted, by us or by anyone, because a hosted server would hold the signing key and would put a third party in the path of an adopter administering their own system.

**It is a second transport over the client the CLI already is.** `pithy dashboard connect | rotate | revoke-key | disconnect | status` is a control-plane client today. The JWS primitives are in core. MCP is a different front end on the same client.

**The tool list derives from the manifest.** `GET /control-plane/manifest` already reports every admin route with its method, its mounted path and the scope it requires — a tool definition in all but name. So the server asks the three questions a dashboard pane asks: does this Worker compose the capability, does it declare this route, and were we granted the scope. A tool that fails any of them is **not offered**, rather than offered and refused.

---

## 4. The using path

**An MCP capability composed into the adopter's Worker, authorizing agents with the MCP specification's own OAuth.** Composing it mounts the endpoint; the adopter writes no route.

**The authorization server is composed, not written.** Better Auth's OAuth 2.1 provider turns an instance into a full authorization server with OIDC compatibility — dynamic client registration, PKCE, ID tokens, JWT access tokens verified at a JWKS endpoint — and its MCP plugin makes the app both an authorization server and a protected resource for MCP clients. The kit already composes four Better Auth plugins, and adopters may compose their own.

**Two things to verify before relying on that.** The MCP plugin has been reported to pin OAuth discovery — issuer, endpoints, authorization servers — to `baseURL` with no override, which breaks split-origin auth servers; this kit runs `dev`, `staging` and `prod` on different origins deliberately, so that is the first thing to test rather than the last. And the plugin makes the adopter's Worker an **authorization server**, which is a larger surface than a resource server and warrants its own security review.

**The default is closed.** Correct route gates are not the whole question: an endpoint that lets any signed-in user drive an agent against the application is remote automation of a surface designed for a person at a keyboard, which changes rate, cost and abuse patterns even when every gate holds. So the capability is off unless composed deliberately, carries a power or entitlement floor when on, and `doctor` states which of the two is in force — the way a declined binding is recorded as a decision rather than left as a gap.

**A route is a tool only when it says so, and a non-`GET` says so louder.** Not every route is a sensible tool: one that sends mail, charges a card or deletes something is a tool an agent can call in a loop. Opt-in, never opt-out, for the reason `requireControlPlane` has no zero-argument form — an optional argument is a thing you can forget.

### 4.1 The tool list is built per caller

`tools/list` arrives with the authenticated token, so the server answers with the tools **that caller may call**, filtered by the same `roleAllows(role, power)` call the route itself makes. A tool a role withholds is absent, not locked: offering it and handling the refusal discloses that it exists and spends a call to learn what the answer would be.

**Hide what a role withholds; it is defensible to show what a *tier* withholds.** A tier lock says *you could have this by paying*, which is informative. A role lock would say *this exists*, which is disclosure.

**And the route declarations are already a tool list.** `describeRoute` ships on every route as of `#740`, and a `RouteSpec` carries exactly what a tool definition needs: a **`summary`** — *"one sentence, in the brand voice"*, which is the description an agent chooses on — an optional longer **`description`** for *"anything a client author must know that the schemas do not say"*, the **`verification`** strategy, the **`scopes`** a caller's credential must carry beyond being verified, and the **`responses`** by status. The input schema comes from the same route's `validate(...)`. `openApiDocument()` reads both off the composed app, `pithy contract` writes each Worker's `openapi.json`, and the kit publishes `docs/openapi.generated.json` — OpenAPI 3.1.0, 150 paths, checked in CI.

So the tool list derives from declarations rather than from anything written twice, and **the scope is declared beside the route rather than inferred** — which is the same property the control-plane manifest has, arrived at from the other side.

**A tool inherits its route's power. That is the whole mapping, and there is nothing else to maintain.** A route that gains a power is a tool that moves on the same commit; a role that gains a power is an agent that sees more with no deploy.

### 4.2 Tools defined by data, not by code

A saved analytical query is a tool whose definition is a row: its **name** is the tool name, its **purpose** is the tool description — the entire basis on which an agent decides to call it — and its declared parameters are the input schema. A query with no purpose is a tool no agent will choose correctly.

**Such a record names a required *power*, never a role.** Role names are the adopter's and they churn; a power is the stable vocabulary the routes already speak, it composes with the role matrix for free, and it can be validated when the record is saved rather than at the first refused call.

**The list changes without a deploy**, which is what MCP's list-changed notification is for. And the review surface is the tool surface: the registry an administrator reviews is literally what agents can call.

**Authoring may itself be a tool, gated on its own power.** The line is not who writes a query but whether it is named: an ad-hoc execution tool is allowed, gated, cost-estimated before it runs, capped, and audited with what it ran — and naming is what converts a one-off into a reviewable interface. A record's creator must therefore be able to be an agent, not only a person.

---

### 4.3 The flow the user sees, and the screens it needs

**The sequence, once a client is pointed at the endpoint.** It hits `/mcp` unauthenticated and is answered with a challenge naming the protected-resource metadata; it reads that, finds the authorization server, reads its metadata, **registers itself dynamically**, and starts an authorization code exchange with PKCE — which opens **the user's browser** on the adopter's own origin. The user signs in if they are not already, approves, and the client receives a **resource-bound** access token: one minted for this MCP endpoint, so it cannot be replayed at another. Clients with no native remote support are shimmed through `mcp-remote`, which caches the token locally.

**So there are two screens, and only one of them exists.** Sign-in is already scaffolded — `pithy ui` writes it when the Worker composes auth, and `#257` settled that the scaffolded screen should be the one the first adopter had to build. **The consent screen does not exist and has to be scaffolded the same way**, because every adopter needs the identical screen and it is the one place in this flow where a mistake is irreversible. (Verify what Better Auth's provider renders versus what it expects the app to render; the plugin supplies the endpoint, and the page is usually the application's.)

#### What the consent screen must show, and the trap it has to avoid

**The client's name is self-asserted, and the screen must not present it as a fact.** Dynamic client registration is open by design — that is what lets a client reach an authorized session from a URL alone — so **any client picks its own name**, and nothing has verified it. A screen rendering *"POWERPLAY Official Sync would like access"* in the same weight as the rest of the page is a phishing surface the adopter did not know they shipped.

What is actually identifying is the **redirect URI**: it is where the token goes, and the authorization server enforces it. So the screen names the client as *reported by the application requesting access*, shows the redirect target plainly, and reserves its emphasis for the thing that cannot be spoofed. The kit already holds this exact discipline one layer down — *"a token that carries its own key is a token that verifies itself"* — and the same scepticism applies to a name that carries its own authority.

**Show the permissions grouped by capability, in each capability's own words.** The vocabulary exists: `dashboard connect` already renders every operation a Worker exposes, grouped, described by the capability that declares it, preselected to a sane default and narrowable. The consent screen is that list in a browser, and it should reuse those strings rather than invent a second description of the same operations. A screen that says *"read your data"* makes consent meaningless; one that lists forty tool names makes it unread.

**Never list a permission the user does not hold.** The token is bound to a user and every route enforces that user's powers, so a scope the user's role does not carry would grant nothing — and offering it teaches people to approve things that do not work. Where a client has **asked** for something the user cannot give, say so: *requested, and not granted, because your role does not include it.* That is not disclosure, because the client named it; it is the honest answer to a request the user can see.

**The grant is bounded above by the user, and the screen should say which bound applies.** Consent decides what this client may do *on the user's behalf*; the role decides the ceiling. Both gates apply and neither is evidence for the other, so a user approving everything on the screen still only ever gets the narrower of the two.

#### What the list actually is — the capability, not the tool

**The unit of consent is a capability, and the tools are shown beneath it as the consequence.** Three candidates were available and only one survives contact with the rest of this design.

| Unit | Why not |
|---|---|
| A **power** | Powers are a role vocabulary, not a consent one, and no power carries a per-member description to render. A user also already holds their powers; a checkbox beside one is ambiguous about what is being decided |
| A **tool** | Precise, and it cannot work: **the tool list changes without a deploy.** A saved query becomes a tool the moment somebody names it, so a per-tool grant is stale on the next save, and the user is re-consenting forever or silently not covered |
| A **capability** | Coarse enough for a human to mean it — *this client may touch support and nothing else* — fine enough to be worth deciding, and stable, because capabilities change when a Worker is deployed and not when a row is written |

**So: one row per composed capability the user can reach, each listing underneath it what the client will then be able to do**, in the capability's own words, counted. *Support — reply to a thread, archive one, reclassify one (3 of 5 operations; two need a role you do not hold).* The selection is the capability; the detail is there so the decision is informed rather than nominal.

**And the list is always the user's own ceiling, never the capability's full surface.** The routes enforce powers, so a consent screen listing operations the signer cannot perform would be describing a grant that does nothing.

#### The decision underneath it, stated because it is easy to take by accident

**A selective consent means the token carries the selection, and every tool call then checks it *in addition to* the role.** That is a second gate. It is defensible — *both gates apply, and one is never evidence for the other* is the pattern this whole product is built on — but it is a second authorization system to declare, describe and keep in step, and §4 argued for adding none.

**At the capability level the cost is small enough to be worth paying**, which is the reason to choose that unit rather than either neighbor: the check is one comparison per call against the tool's own capability, there is nothing new to declare because a tool already knows which capability it came from, and it cannot drift from the route gates because it is not trying to restate them. A per-tool scope vocabulary would be a genuine second system; a per-capability one is a filter.

**What it must never become is the authority.** The role remains the ceiling. A client holding consent for a capability still cannot do anything inside it the user could not, and a test should hold that rather than a comment.

**Decided 2026-10-13: the first version is informational, and selective is deferred until somebody asks.** One decision — *let this client act as you in this application* — with the capability rows and their consequences shown exactly as above, and nothing to tick.

Four things that follow, and the first is the reason it was chosen:

- **There is no second gate, so the role is the single authority rather than the senior of two.** Nothing has to be declared, described or kept in step with the route gates, and no part of the system can disagree with another about what a caller may do.
- **The token carries no permission selection**, so the OAuth scope is one constant value and the only thing bound into the token is the resource and the user. The authorization server has correspondingly less to issue and less to get wrong.
- **The screen is the same screen.** The rows, the counts and the per-capability detail are what a selective version would render too, so adding checkboxes later is adding checkboxes — not rebuilding the page, and not retrofitting a vocabulary.
- **Revocation becomes the user's only narrowing instrument**, which promotes the connected-applications screen from a courtesy to a requirement. With nothing to deselect, *"I do not want it doing that"* has exactly one answer, and it must be reachable without asking an administrator.

**And nothing is added now in anticipation.** No scope vocabulary, no per-capability scope constants, no column waiting for a selection. The deferral is only honest if the deferred thing is actually absent.

#### Three things that follow from the screen existing

- **A later widening is a new consent, never a silent one.** A client that comes back asking for more gets the screen again. The same semantics as a scope update replacing a grant rather than merging into it, and the change is audited.
- **The user needs somewhere to see and revoke what they approved.** A connected-applications screen, on the adopter's side, listing what was approved, when, and by which client — with a revoke. It is the user-facing half of the access review an administrator gets, and without it consent is a one-way door.
- **Both events are audited.** A grant and a revocation are each a row, for the same reason every control-plane call is one.

---

## 5. Tool names

**Derived, never hand-written.** MCP tool names are flat and global within one server, so two capabilities both exposing `list` collide, and a hand-written name drifts from the route it stands for. Compose from the declarations that already produce the route and its power.

Neither existing separator survives: MCP names conventionally allow `[a-z0-9_-]`, so a scope's `:` and an audit action's `/` both become `_`. Normalize in one place.

**Once published, a tool name is permanent.** An agent references it by name — in prompts, in saved workflows, in its own record of what worked — so renaming breaks callers silently. The same class of rule as a role name, which is stable forever once a membership holds one, and the project name, which does not rename what it has provisioned but orphans it.

**Filtering per caller also keeps the list short enough to choose from.** A tool list is a prompt, and past a certain size a model chooses worse from it. The safe design and the better-performing one agree here, which is rare enough to state.

---

## 6. One object, two credential kinds

**An agent connection is one object.** The credential kind is a property of it, not a second system. Everything governing an agent — the record, the review surface, revocation, the role re-check — is written once and works for both kinds, because none of it needs to know how the caller proved itself.

### 6.1 A registered key

The client generates an Ed25519 keypair, keeps the private half, and registers the public one; the adopter's CLI writes it into their D1. A call is a compact JWS on a dedicated header, verified against that key, with the `jti` claimed last and **one scope named per call**. See [`CONTROL-PLANE.md` §3](CONTROL-PLANE.md).

This suits an interactive or local agent, where a key on the host is unremarkable.

### 6.2 An OIDC trust

For an agent running unattended — in a container, a job, a Worker — there is no person to place a key, and workload identity removes the need: the host mints a short-lived token, the Worker verifies it against the issuer's published keys, and **neither end holds a secret**. `core/src/http/oidcWebhook.ts` already implements the verification, and the release pipeline already replaced a shared HMAC secret with it.

Four rules carry over, three of them already enforced in that module:

- **The claims check is the boundary, not the signature.** An identity provider signs for everybody with the same keys. A trust with an unconstrained subject accepts every workload that provider serves, so it is **refused at registration** rather than discouraged.
- **The verification order is a security property.** Pin the algorithm to a literal before touching a key; resolve the key by `kid` from the issuer's published set and never from the token; verify over the exact received segments; read claims only after.
- **The claims become data here, and that is a deliberate departure.** In a webhook the predicate belongs to the route, because whoever wrote the route knows the legitimate sender. A connection's trust is per adopter, set at registration, by the party who also grants the scopes — so it is a stored matcher, validated on the way in.
- **An identity assertion proves who, not what.** A JWS names one scope for one call; a bearer token does not, so anyone holding a live one may send any body until it expires. Either verify the token per call and still require the scope named in the request, or exchange it once for a short-lived credential and sign per call. The first is simpler; the second keeps every property.

### 6.2.1 Registering one

**A trust is a third registration mode, and it is the quietest of the three.** The device-code path exists so a management client can generate a keypair and hand over the public half; `--public-key` exists for a key generated out of band and contacts no dashboard at all. A trust has no keypair to exchange and no client to call, so it contacts nobody: it is a row, written by the adopter against their own project.

```
pithy dashboard connect --env prod \
  --oidc-issuer https://token.actions.githubusercontent.com \
  --oidc-claim repository_id=1262274726 \
  --oidc-claim environment=leed-release \
  --purpose 'nightly audit summarizer'
```

**No `--scope` there, deliberately.** At a terminal the command lists every operation the Worker exposes, in each capability's own words, preselected to the derived default, with `a` to toggle all and `i` to invert — and **`--scope` answers that same question non-interactively**, narrowing to exactly what is passed. For an agent the prompt is the better path and should stay the documented one: choosing what a standing credential may do is precisely the decision a human should be shown rather than type from memory. `--scope` is for a scripted or CI registration, and `--scope all` is the `a` key without a terminal.

Passing it skips the question and nothing else: the address is still resolved and printed, the default is still derived from what the Worker declares, and an explicitly empty selection is still passed through as empty rather than quietly collapsed into the default.

**An issuer and at least one claim constraint are both required, and a trust with neither is refused.** An issuer alone accepts every workload that provider serves, and the refusal is structural rather than a warning — the same discipline as refusing an unknown permission key before anything is minted.

**The audience defaults to the environment's own resolved origin.** `connect` already resolves that address from the project and prints what it found and where it came from, so the property that stops a staging token being replayed against production is **derived rather than typed** — which is how the release pipeline already pins its own audience. Passing `--oidc-audience` overrides it; not passing it is the right answer almost always.

**Match named claims, not the `sub` string — and that is what dissolves the format problem.** A `sub` is a *concatenation* whose composition belongs to the provider and to the adopter's own template; the claims underneath it are individually published and individually stable. GitHub's token carries `repository_id`, `repository_owner_id`, `environment`, `ref`, `ref_type` and `actor_id` as claims **in their own right, independent of `sub`**, and its own documentation notes they are what cloud providers use to set trust conditions. GitLab's carries `project_id`, `ref` and `ref_type` the same way. So `--oidc-claim` is repeatable, `sub` is simply one claim you may match among the others rather than a special case, and there is no template to know.

**Prefer an immutable identifier, and the CLI should say so.** `repository_id` over `repository`, `project_id` over `project_path`. A numeric id survives a rename, and it cannot be claimed by somebody who creates a project of the same name somewhere else — which is the whole reason GitHub introduced an immutable subject form in the first place. A name-based match is accepted, with the trade stated once.

**And this removes a question that would otherwise have to be asked.** Matching `sub` would mean knowing whether a repository predates GitHub's 2026-07-15 immutable default, because the string differs either side of it. `repository_id` is present as a claim in both eras, so the question never arises — the cutover is a `sub` problem and matching claims is not subject to it.

**The grant is the same surface, unchanged.** The derived default, the interactive list in each capability's own words, `a` and `i`, `--scope`, `--scope all`, and the empty selection passed through as empty — all of it applies, because the grant belongs to the connection and not to the credential kind.

**Known issuers ship as profiles; anything else is custom and says so.** A profile is a provider's claim vocabulary — which claims its tokens carry, which of them are the recommended constraint, and an example of each — so registering against a recognized issuer is a prompt over real choices rather than a string somebody composes from documentation. Two, as a starting point:

| Issuer | Recommended | Also available |
|---|---|---|
| GitHub Actions | `repository_id`, plus `environment` or `ref` | `repository_owner_id`, `actor_id`, `ref_type`, `workflow_ref`, `job_workflow_ref`, `event_name`, `runner_environment` |
| GitLab CI | `project_id`, plus `ref` and `ref_type` | `namespace_id`, `ref_protected`, `environment` |

**A custom issuer is a first-class answer, not a failure mode.** Name the issuer, name the claims and values, and the trust registers — the kit validates the *shape* of what it was given and nothing about whether the provider will send it. That is honest about where the knowledge sits, and it means a provider nobody has profiled is not a provider nobody can use.

**Nothing is enforced against a profile.** A profile informs a prompt and seeds a default; it never refuses a claim it has not heard of. GitHub's template is customizable per organization and repository, so a kit that validated against its own table would eventually refuse a legitimate token with a refusal the adopter can neither argue with nor work around.

Two further consequences, and the second is what makes the custom path survivable:

- **It is not derivable from discovery.** An OIDC discovery document publishes endpoints and the claim *names* a provider supports, never the value a claim will carry. There is nothing to read, which is why profiles are written rather than fetched.
- **On a refused call, record the claims that actually arrived.** This is the affordance that makes a custom issuer workable and a profiled one self-correcting: the operator registers the trust, lets the workload run once, reads the claims the token actually carried off the refusal, and picks from them. Rolling the dice becomes rolling it once, with the answer printed. It is safe for the same reason the verifier already distinguishes a scope failure — *"by then the caller is proven legitimate"*: once the signature, the issuer and the audience have verified, the caller has demonstrably been issued a genuine token for this audience, so naming the claims it sent us leaks nothing it does not already hold. **Only after those three verify.** Before that the single-error discipline holds, and a mismatch reveals nothing.

**The authorizing principal is the resolved CLI actor, and it must resolve.** There is no browser in this path, so the device-code approval that captures a principal for a key is absent. The CLI already resolves an actor from the Cloudflare token, verified against the account's user endpoint rather than assumed, and falls back to an unattributed `system` actor when it cannot. **That fallback is correct for an audit row and wrong for a standing credential**: §7 requires a principal, and §8's revocation-on-departure cannot be implemented for a credential nobody is named against. So a trust registration whose actor does not resolve is **refused**, naming why — unlike the provisioning commands, where an unattributed row is an honest record of a local run.

**What can be proven at registration is narrower than for a key, and the status must say so.** The key path refuses to report `connected` until a signed ping round-trips, because a registration that cannot be reached is a dead link. A trust cannot ping: there is no private key here, and the workload is not present at registration time. What *is* verifiable is that the issuer's discovery document resolves and its key set is reachable and parses — so that is what the command checks, and the state it reports is **awaiting a first call**, never `connected`. Reporting a state nothing proved is the failure `needs_reconnect` exists to prevent.

**Rotation does not apply; review does.** There is no key to append, prove and expire. The hygiene a trust needs instead is the review-by date of §6.3, because its usable population can change with no event here.

**Revocation changes shape.** A token cannot be revoked; the **trust** is revoked, and anything already minted stays live until it expires. So the kill switch has latency bounded by token lifetime, which has to be said at the moment of revocation rather than discovered afterwards.

### 6.3 A key is a bearer; a trust is a policy

One agent holds a key. A trust pinned to a workflow is usable by **anyone who can run that workflow** — a population defined by somebody else's access control, which can grow after registration with no event in this system or the adopter's.

Three consequences: the authorizing principal on a trust records who **sanctioned** it, not who may **use** it; the subject constraint is the population and belongs on the face of any listing; and nothing re-checks that population, which argues for a trust carrying a review-by date rather than living indefinitely.

---

## 7. What a connection records, and why

Three fields, on the **connection** rather than the credential, so they hold for both kinds.

| Field | Why |
|---|---|
| **Authorizing principal** | Which human sanctioned this. Without it, "whose agent did this" is unanswerable from the adopter's own audit trail, and revocation on departure is not implementable |
| **Actor kind** | An agent, a dashboard, or a script. The audit actor kind `control-plane` names all three and distinguishes none |
| **Purpose** | What the agent is for, in the creator's words. **Required, and refused when absent** |

**The purpose field is load-bearing, not a nicety.** A review listing credentials by key id cannot support the decision it exists for. One reading *support triage bot, scoped to thread reads and replies* can. The cost of omitting it is not a worse screen; it is that nobody revokes anything, because nobody can tell which one matters.

**It belongs on the adopter's side**, since they perform the review, on their own trail, possibly without any dashboard open. **It is editable and the edit is audited**, because an agent's job changes and a label nobody may correct is a label that rots. **It is untrusted input**, written by a customer and rendered elsewhere, and is validated at the boundary like anything else that crosses one.

**The principal is named, not derived, and that is a finding rather than a preference.** A device-code registration does put a human in a browser — but the approval happens at the management client, and nothing about it comes back: `ConnectToken` carries a bearer and an expiry, `IssuedConnection` carries the connection, the key, the public JWK, the issuer and the scopes, and neither carries identity. The client knows who approved and does not send it.

**Nor is the CLI's own actor a person on the recommended setup.** `resolveActor`'s `actorId` is *"a user email, a token name"*: a user token resolves through `GET /user` to an email, and an **account-owned token resolves to the token's name** — and account-owned is the kind this kit prefers and `pithy token mint` produces. A token name cannot leave an organization, so a governance rule built on it would not work. A signed-in session is the exception: under `pithy cloudflare connect` (#759), `resolveActor` names the person through `GET /user`.

**The root cause is the credential model, not the wire.** A registration is authorized by holding a Cloudflare account credential rather than by a person's session, so there is no person in the path to derive.

**So the principal is given — `--authorized-by <email>` — pre-filled from a derivation where one exists, and the registration is refused when nothing names a person.** An email string rather than a reference into the organization model, because an adopter's user table holds their customers and the operator registering a connection is their staff. It works identically on all three registration paths, which is why it was chosen over sending the approving user, which would answer only one of them. **It becomes derived where the CLI runs under a browser sign-in to Cloudflare** — `pithy cloudflare connect` now provides one — and `--authorized-by` demotes to the fallback for a non-interactive caller.

---

## 8. Governance

**An agent may never be granted more than its creator holds.** Enforced at creation, and re-checked rather than assumed.

**The weight sits entirely on creation, and that is the honest cost of the direct design.** For a human at a dashboard, both gates apply on every call. An agent calling a Worker directly presents its own credential and is checked against the adopter's grant alone — the management client's own role gate never runs again. So the ceiling set at creation is the only control, and it has to be right rather than approximately right.

**Re-check on role change, not only on removal.** A demotion that leaves a write-scoped agent running is a privilege the demotion was meant to remove. A declared role nesting makes this computable rather than a guess: a reduction in powers is a set comparison the catalog can answer.

**Revoke on removal, automatically, and show the consequence before the act rather than asking a question.** A removal is often urgent, and a yes/no prompt at that moment is a place to click the wrong thing. The confirmation names what will be revoked and what it last did. **Reassignment is the only alternative offered** — re-authorizing under somebody still present, which has a precedent in two-party ownership transfer. *Leave it running, unowned* is not an option, for the reason an owner role is unassignable. **Immediately, with no grace window**: a grace period on a credential revoked because somebody left is the opposite of the point.

**A credential's last use and last action come from the adopter's audit store, not from a field.** The most recent allowed call answers both, and carries the scope. Three honest qualifications: it is a query rather than a column; retention bounds the answer, so it reads *not used in the last N days as recorded* and never *never used*; and a dropped audit write is not proof of no call, which is why the label is **last observed**. The scope belongs beside the timestamp, because an idle agent whose last act was a deletion reads differently from one whose last act was a read.

**Granted is not used, and both numbers exist.** The connection holds the grant; the audit rows hold the scope exercised. An over-grant is therefore derivable with nothing new, and an agent's scope set — chosen once, by someone guessing — makes over-grant the default outcome rather than an occasional mistake. The remedy already exists as a narrowing command, so the finding ends in something to run.

---

## 9. Audit

**A control-plane call is audited by the seam's own guard**, with the scope, the key, the connection, the method and the path, and the record is evidence of the decision rather than part of making it — [`CONTROL-PLANE.md` §11](CONTROL-PLANE.md).

**An in-Worker MCP tool call is not a control-plane call and emits none of that.** Left alone this produces an asymmetry in which an agent administering the system is fully audited and an agent using the application is invisible. Every tool call wants a row: who, which tool, which class of argument, and what it cost.

---

## 10. What this document does not yet describe

Stated so a reader can tell a decision from a gap.

- The agent fields of §7, and the actor kind, are not implemented. A connection records none of them.
- No Cloudflare browser sign-in exists, so §7's principal is given rather than derived. `pithy-sh/pithy#759` is the fix; `#721` ships before it.
- Neither MCP server exists. The CLI's `mcp/` directory writes client configuration for an external server and contains no server.
- The OIDC credential kind of §6.2 is not registrable; the verifier exists, the trust does not.
- The data-defined tools of §4.2 presuppose an analytical capability that is not built.
