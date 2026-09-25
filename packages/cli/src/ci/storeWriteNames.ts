// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **No write to the Cloudflare Secrets Store is addressed by a name this repository made up on the spot.**
 *
 * A Cloudflare account has exactly one Secrets Store. It is flat and account-wide, so the entry *name* is
 * the only partition there is — between two projects, between two environments, and between a live key and
 * an orphan. Every name that addresses an entry therefore has to come out of the naming facade
 * (`core/src/naming/resourceNames`, or one of the secret-name helpers built on it), because that is the one
 * place `<project>-<env>-<thing>` exists and the one place a name can be *recomputed* later — by teardown,
 * by the reaper, by `pithy secrets verify`.
 *
 * A name written at the call site instead fails in the worst way this kit has: `putSecret` upserts, so a
 * stale or hand-spelled name finds nothing, **creates** an entry, and answers 200. The rotation believes it
 * persisted the new key set, every row is re-encrypted under it, and the binding goes on serving the old
 * one. Nothing returns an error, anywhere. That is #647.
 *
 * ## What this module answers, and what it deliberately does not
 *
 * It answers three questions about the tree, all by reading it:
 *
 *   1. **Who may touch the Secrets Store SDK at all?** {@link StoreWriteAnalysis.sdkModules} — every module
 *      that reaches `secretsStore.stores.secrets.<verb>`. One module does, and the gate asserts exactly
 *      that, which is what makes the chokepoint below a real chokepoint rather than a convention.
 *   2. **Which verbs write?** {@link StoreWriteAnalysis.verbs}, discovered from that chokepoint's own class
 *      body, and {@link StoreWriteAnalysis.seamVerbs}, discovered from the adapter that forwards to them.
 *      Neither is a list this module carries.
 *   3. **What name does each call site pass?** {@link StoreWriteAnalysis.sites}, with the argument
 *      classified — {@link StoreWriteKind}.
 *
 * It does **not** try to answer whether a forwarded name was composed through the facade. That fact lives a
 * constructor and two modules away from the call — `SecretsStoreConfigWriter` is handed `this.entryName` by
 * a builder in a third file — and the draft this replaces tried to chase it by fixed point over bare
 * function names across the whole tree. The result came back empty and the gate was green over nothing. So
 * the verdict on a forwarded name is a **declared row** in `storeWriteNames.test.ts`, written by a human who
 * followed it; the *population* those rows must exactly cover is discovered here, so no call site can enter
 * the tree without one.
 *
 * ## The two shapes this repository already had, and why this is both
 *
 * `migrations/orders.test.ts` and `ci/bindingResourceNames.test.ts` are hand-maintained tables: a new entry
 * fails until a human adds a row. `ci/workflowDeterminism.test.ts` is an analyzer over the whole tree with
 * an exact-population tripwire. The two answer different questions — *is each member right?* and *is the set
 * complete?* — and this rule needs both answers. The set is mechanically discoverable (a call to a verb is a
 * syntactic fact); the verdict is not (where a string came from is a human's reading). Taking only the table
 * gives a gate that never notices a seventh call site. Taking only the analyzer gives the draft's gate,
 * which noticed nothing at all.
 *
 * One part of the verdict is mechanical, and it is the part that matters most: a literal, a template, or a
 * concatenation passed as the name is a finding **no row can excuse** ({@link StoreWriteKind}). That is the
 * shape of the defect itself, and it is refused here rather than declared away.
 *
 * ## Fail-closed, three times over
 *
 * - An SDK verb is a **write** unless it is one of {@link SDK_READ_VERBS}. A verb Cloudflare adds tomorrow
 *   counts as a write until somebody says otherwise, rather than slipping past a list of known mutations.
 * - A name argument this module cannot classify is `unclassified`, which is a finding. Not silence.
 * - A write verb whose first parameter is not a name is still reported, marked
 *   {@link ManagerVerb.addressedBy} `other`. The draft discovered verbs *by* "first parameter named `name`",
 *   so an id-addressed edit verb was invisible to it — the exact hole D1 says the name-addressed verb exists
 *   to close. Here such a verb changes the verb table and fails the population assertion, which puts a human
 *   in front of it.
 *
 * ## The walker is local, and that is the point of the rewrite
 *
 * `ci/workflowDrivers.ts` has a `memberPath` that renders a dotted path, and it cannot express what this
 * analyzer needs. Every SDK access in the manager is written `this.getClient().secretsStore.stores.secrets.edit(…)`
 * — a call in the middle of the chain — and a dotted path bails there. That is precisely why the draft's
 * seam discovery returned an empty set. {@link propertyChain} collects a property-name *sequence* and walks
 * straight through an intervening `CallExpression`, so the chain above reads
 * `this · getClient · secretsStore · stores · secrets · edit` and the seam is found in the middle of it.
 */

/** A source file the analysis reads. The same shape `sourceFiles` yields, so the tree walk feeds it directly. */
export interface StoreWriteSource {
  /** Path to the file, repo-relative and POSIX, used in findings. */
  readonly path: string;
  /** Its text. */
  readonly text: string;
}

/**
 * The Cloudflare SDK's own path to a store's secrets, as a property-name sequence.
 *
 * Their names, not ours, and written as a sequence rather than a string because it is reached through a
 * call: `this.getClient().secretsStore.stores.secrets.edit(…)`.
 */
const SDK_PATH = ["secretsStore", "stores", "secrets"] as const;

/**
 * The SDK verbs that only read.
 *
 * **Everything else is a write.** Stated as the small closed set rather than the large open one, because
 * the open one is Cloudflare's to grow: a `bulkEdit` landing in a future SDK is a write from the day it is
 * called, with nobody having had to remember to add it here. The cost of the polarity is that a new *read*
 * verb reports as a write once, and is corrected by one word.
 */
const SDK_READ_VERBS = new Set(["list", "get"]);

/** One reach into the Secrets Store SDK — the tier nothing but the encapsulating manager may occupy. */
export interface SdkSite {
  /** The file it lives in. */
  readonly file: string;
  /** 1-indexed line. */
  readonly line: number;
  /** The SDK verb called: `create`, `edit`, `delete`, `list`. */
  readonly verb: string;
  /** Whether this module treats it as a write. See {@link SDK_READ_VERBS}. */
  readonly writes: boolean;
}

/** How a store-write verb addresses the entry it acts on. */
export type Addressing = "name" | "other";

/** One verb on the encapsulating manager that reaches a mutating SDK call. */
export interface ManagerVerb {
  /** The method name, as a caller spells it. */
  readonly name: string;
  /**
   * Whether its first parameter is the entry `name`.
   *
   * `other` is not an error and is not filtered out — it is the thing a human has to look at. An
   * id-addressed write is outside the reach of a rule about names (D1), so one appearing here means the
   * gate's coverage just changed.
   */
  readonly addressedBy: Addressing;
  /** The mutating SDK verbs it reaches, directly or through a private method of the same class, sorted. */
  readonly sdkVerbs: string[];
}

/** One adapter seam member that forwards to a {@link ManagerVerb} — discovered, never declared. */
export interface SeamVerb {
  /** The member name on the seam, e.g. `put`. */
  readonly name: string;
  /** The seam type it belongs to, e.g. `SecretsStore`. */
  readonly type: string;
  /** The manager verbs its implementation calls, sorted. */
  readonly forwardsTo: string[];
}

/**
 * How a call site produced the name it passed.
 *
 * - `composed` — the argument is a call. Something named it; which composer is the row's business.
 * - `forwarded` — an identifier or a member. It arrived from a caller, a field, or a parameter.
 * - `made-here` — a literal, a template, or a concatenation. **The defect itself**, and the one verdict no
 *   declared row may overrule.
 * - `unclassified` — anything else, including a call with no arguments at all. Treated as a finding, because
 *   a name this analyzer cannot read is a name nobody reviewed.
 */
export type StoreWriteKind = "composed" | "forwarded" | "made-here" | "unclassified";

/** One call in the tree that writes to the Secrets Store. */
export interface StoreWriteSite {
  /** The file it lives in. */
  readonly file: string;
  /** 1-indexed line. */
  readonly line: number;
  /** The verb called. */
  readonly verb: string;
  /** Whether it was reached through the manager directly or through the adapter seam. */
  readonly tier: "manager" | "seam";
  /** The name argument exactly as written, whitespace collapsed. */
  readonly argument: string;
  /** How that argument was produced. */
  readonly kind: StoreWriteKind;
  /**
   * The whole call as written — `verb(arg, arg)`, whitespace collapsed.
   *
   * The name argument alone would not identify a site: `SecretsStoreConfigWriter` writes the same entry
   * twice, once with a stamp comment and once without, and both read `updateExistingSecret(this.entryName)`.
   * Two rows that cannot be told apart are two rows nobody can review, so the key carries the rest of the
   * call — which is also what a reader needs to find the line.
   */
  readonly call: string;
}

/** What one analysis pass found. */
export interface StoreWriteAnalysis {
  /** Every reach into the Secrets Store SDK, sorted by file and line. */
  readonly sdkSites: SdkSite[];
  /** The modules holding them, sorted and deduplicated. One, if the encapsulation holds. */
  readonly sdkModules: string[];
  /** Every mutating verb the encapsulating manager exposes, sorted by name. */
  readonly verbs: ManagerVerb[];
  /** Every adapter seam member that forwards to one of them, sorted by type then name. */
  readonly seamVerbs: SeamVerb[];
  /** Every store-write call site in the tree, sorted by file then line. */
  readonly sites: StoreWriteSite[];
  /** Files parsed. A gate over an empty population is not a gate. */
  readonly parsed: number;
}

/**
 * An AST node, structurally. ESTree names throughout, so the parser behind {@link ParseModule} is replaceable.
 */
export interface Node {
  readonly type: string;
  /** Byte offset of the node's first character. */
  readonly start?: number;
  /** Byte offset one past its last. */
  readonly end?: number;
  readonly [key: string]: unknown;
}

/** The parser, injected — a dev-only dependency this shipped module must not import. */
export type ParseModule = (text: string) => Node;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Every child node, in source order. Property-driven, so it needs no per-kind knowledge. */
function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (isNode(value)) found.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isNode(item)) found.push(item);
  }
  return found;
}

/** Depth-first visit of every node under `root`, itself included. */
function walk(root: Node, visit: (node: Node) => void): void {
  visit(root);
  for (const child of children(root)) walk(child, visit);
}

/** Offsets to 1-indexed lines: built once per file, then searched. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] as number) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

function nameOf(node: unknown): string | undefined {
  return isNode(node) && node.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;
}

/**
 * An identifier or a `#private` one, the latter spelled with its `#`.
 *
 * The hash is kept rather than stripped because it is part of the name a reader sees, and because keeping
 * it makes a private field and a same-named public one two different links in a chain. `this.#manager` is
 * how the rotation's config writer holds the manager, so a walker blind to `PrivateIdentifier` bails on the
 * first link and loses `packages/secrets/src/manager/secretsConfigWriter.ts` — the one call site #647 was
 * opened for.
 */
function memberName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "PrivateIdentifier" && typeof node.name === "string") return `#${node.name}`;
  return nameOf(node);
}

/**
 * The property-name sequence of a member chain, left to right — **the fix for what killed the draft**.
 *
 * `this.getClient().secretsStore.stores.secrets.edit` reads
 * `["this","getClient","secretsStore","stores","secrets","edit"]`: a `CallExpression` in the middle of the
 * chain is walked through rather than treated as the end of it, which is the whole difference between this
 * and a dotted-path renderer. A computed member (`a[b]`) makes the chain unknowable, and an unknowable chain
 * is empty rather than partial — a partial one would silently match a shorter seam path.
 */
export function propertyChain(node: Node): string[] {
  const parts: string[] = [];
  let current: unknown = node;
  while (isNode(current)) {
    const step: Node = current;
    if (step.type === "MemberExpression") {
      if (step.computed === true) return [];
      const property = memberName(step.property);
      if (property === undefined) return [];
      parts.unshift(property);
      current = step.object;
      continue;
    }
    if (step.type === "CallExpression" || step.type === "NewExpression") {
      current = step.callee;
      continue;
    }
    if (step.type === "TSNonNullExpression" || step.type === "ParenthesizedExpression") {
      current = step.expression;
      continue;
    }
    if (step.type === "ChainExpression") {
      current = step.expression;
      continue;
    }
    if (step.type === "AwaitExpression") {
      current = step.argument;
      continue;
    }
    if (step.type === "Identifier") {
      parts.unshift(step.name as string);
      return parts;
    }
    if (step.type === "ThisExpression") {
      parts.unshift("this");
      return parts;
    }
    return parts;
  }
  return parts;
}

/** The SDK verb this chain reaches, or `undefined`. See {@link SDK_PATH}. */
function sdkVerbOf(chain: readonly string[]): string | undefined {
  for (let index = 0; index + SDK_PATH.length < chain.length; index += 1) {
    if (SDK_PATH.every((segment, offset) => chain[index + offset] === segment)) {
      return chain[index + SDK_PATH.length];
    }
  }
  return undefined;
}

/** Every type-reference name anywhere inside a type annotation — `() => Promise<SecretsStore>` yields both. */
function typeNames(node: Node): string[] {
  const found: string[] = [];
  walk(node, (child) => {
    if (child.type !== "TSTypeReference") return;
    const name = nameOf(child.typeName);
    if (name !== undefined) found.push(name);
  });
  return found;
}

/** The declared name a value binds — an identifier, or a property key. */
function boundName(node: Node): string | undefined {
  return memberName(node.key) ?? memberName(node.id) ?? memberName(node.argument);
}

/** One parsed module, kept so every pass reads the same tree. */
interface Parsed {
  readonly file: string;
  readonly text: string;
  readonly program: Node;
  readonly lineAt: (offset: number) => number;
}

/** The source text of a node, whitespace collapsed, so a row stays one line. */
function sourceOf(parsed: Parsed, node: Node): string {
  const { start, end } = node;
  if (typeof start !== "number" || typeof end !== "number") return `<${node.type}>`;
  return parsed.text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Parse every source, dropping any the parser refuses — a file that will not parse is a build failure elsewhere. */
function parseAll(sources: readonly StoreWriteSource[], parse: ParseModule): Parsed[] {
  const parsed: Parsed[] = [];
  for (const source of sources) {
    try {
      parsed.push({
        file: source.path,
        text: source.text,
        program: parse(source.text),
        lineAt: lineIndex(source.text),
      });
    } catch {
      // Unparseable source is not this gate's business to report.
    }
  }
  return parsed;
}

/** Every reach into the SDK, wherever it is. */
function sdkSites(modules: readonly Parsed[]): SdkSite[] {
  const found: SdkSite[] = [];
  for (const module of modules) {
    walk(module.program, (node) => {
      if (node.type !== "CallExpression" || !isNode(node.callee)) return;
      const verb = sdkVerbOf(propertyChain(node.callee));
      if (verb === undefined) return;
      found.push({
        file: module.file,
        line: module.lineAt(node.start ?? 0),
        verb,
        writes: !SDK_READ_VERBS.has(verb),
      });
    });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** One class method, as verb discovery needs it. */
interface ClassMethod {
  readonly name: string;
  readonly private: boolean;
  readonly addressedBy: Addressing;
  /** Mutating SDK verbs its own body reaches. */
  readonly direct: Set<string>;
  /** Methods of the same class its body calls as `this.x(…)` or `this.#x(…)`. */
  readonly calls: Set<string>;
}

/** The first parameter's name, seeing through a default and a type annotation. */
function firstParameterName(fn: unknown): string | undefined {
  if (!isNode(fn) || !Array.isArray(fn.params)) return undefined;
  const first = fn.params.find(isNode);
  if (first === undefined) return undefined;
  if (first.type === "AssignmentPattern") return nameOf(first.left);
  return nameOf(first);
}

/** Read one class body into {@link ClassMethod}s. */
function classMethods(body: Node): ClassMethod[] {
  const members = Array.isArray(body.body) ? body.body.filter(isNode) : [];
  const methods: ClassMethod[] = [];
  for (const member of members) {
    if (member.type !== "MethodDefinition" || member.kind !== "method") continue;
    const name = memberName(member.key);
    if (name === undefined) continue;
    const direct = new Set<string>();
    const calls = new Set<string>();
    if (isNode(member.value)) {
      walk(member.value, (node) => {
        if (node.type !== "CallExpression" || !isNode(node.callee)) return;
        const chain = propertyChain(node.callee);
        const verb = sdkVerbOf(chain);
        if (verb !== undefined && !SDK_READ_VERBS.has(verb)) direct.add(verb);
        if (chain.length === 2 && chain[0] === "this" && chain[1] !== undefined) calls.add(chain[1]);
      });
    }
    methods.push({
      name,
      private: member.accessibility === "private" || (isNode(member.key) && member.key.type === "PrivateIdentifier"),
      addressedBy: firstParameterName(member.value) === "name" ? "name" : "other",
      direct,
      calls,
    });
  }
  return methods;
}

/**
 * Every mutating verb the encapsulating manager exposes.
 *
 * Reachability, not a list: a method counts when its own body reaches a mutating SDK call **or** calls a
 * method of the same class that does. `putSecret` is the case that needs it — its create branch is one
 * `this.createSecret(…)` away, and a rule reading only the method's own body would have missed the upsert
 * that is the entire reason #647 exists.
 */
function managerVerbs(modules: readonly Parsed[]): ManagerVerb[] {
  const verbs: ManagerVerb[] = [];
  for (const module of modules) {
    walk(module.program, (node) => {
      if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return;
      if (!isNode(node.body)) return;
      const methods = classMethods(node.body);
      if (methods.length === 0) return;
      const byName = new Map(methods.map((method) => [method.name, method]));
      const reached = new Map<string, Set<string>>();
      const resolve = (name: string, seen: Set<string>): Set<string> => {
        const cached = reached.get(name);
        if (cached !== undefined) return cached;
        const method = byName.get(name);
        if (method === undefined || seen.has(name)) return new Set();
        seen.add(name);
        const found = new Set(method.direct);
        for (const callee of method.calls) for (const verb of resolve(callee, seen)) found.add(verb);
        reached.set(name, found);
        return found;
      };
      for (const method of methods) {
        if (method.private) continue;
        const sdk = resolve(method.name, new Set());
        if (sdk.size === 0) continue;
        verbs.push({ name: method.name, addressedBy: method.addressedBy, sdkVerbs: [...sdk].sort() });
      }
    });
  }
  return verbs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every adapter seam member that forwards to a manager verb — **discovered from the forwarding itself**.
 *
 * The shape is `function cloudflareSecretsStore(…): SecretsStore { return { put: (name, value) => store.putSecret(name, value), … } }`.
 * So: a function with a declared return type, returning an object literal, whose property bodies call
 * manager verbs. The seam *type* is that return type, and the seam's write members are exactly the
 * properties that reach a mutating verb — which is why `exists` is not one of them and nothing had to say so.
 *
 * Declaring the seam instead would be a second source of truth for a fact the implementation already states,
 * and it is the fact most likely to rot: a member renamed here with the table left alone drops its call
 * sites out of the population in silence.
 */
function seamVerbs(modules: readonly Parsed[], verbs: ReadonlySet<string>): SeamVerb[] {
  const found: SeamVerb[] = [];
  for (const module of modules) {
    walk(module.program, (node) => {
      if (node.type !== "FunctionDeclaration" && node.type !== "ArrowFunctionExpression") return;
      if (!isNode(node.returnType) || !isNode(node.body)) return;
      const type = typeNames(node.returnType).find((name) => name !== "Promise");
      if (type === undefined) return;
      walk(node.body, (returned) => {
        if (returned.type !== "ObjectExpression" || !Array.isArray(returned.properties)) return;
        for (const property of returned.properties.filter(isNode)) {
          if (property.type !== "Property" || !isNode(property.value)) continue;
          const member = boundName(property);
          if (member === undefined) continue;
          const forwards = new Set<string>();
          walk(property.value, (call) => {
            if (call.type !== "CallExpression" || !isNode(call.callee)) return;
            const chain = propertyChain(call.callee);
            const last = chain[chain.length - 1];
            if (last !== undefined && chain.length > 1 && verbs.has(last)) forwards.add(last);
          });
          if (forwards.size > 0) found.push({ name: member, type, forwardsTo: [...forwards].sort() });
        }
      });
    });
  }
  return found.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

/**
 * The names a module binds to a seam type.
 *
 * A name is seam-bound when *any* declaration of it in the module carries a type annotation mentioning the
 * seam — `store?: SecretsStore`, `store: () => Promise<SecretsStore>`, `Promise<{ store: SecretsStore }>`.
 * That is what makes `store.put(…)`, `options.store.remove(…)` and a `const store = options.store` beside
 * them all resolve, with nothing chasing assignments.
 *
 * **It keys on the name, not on a resolved type**, which is the honest limit of a walk that does not resolve
 * imports. A module holding both a seam `store` and an unrelated one would report the unrelated one's writes
 * too. That direction is chosen deliberately: a false positive fails the gate and costs a row, while the
 * other polarity is the defect shipping.
 */
function seamBoundNames(module: Parsed, seamTypes: ReadonlySet<string>): Set<string> {
  const bound = new Set<string>();
  walk(module.program, (node) => {
    const annotation = node.typeAnnotation;
    if (!isNode(annotation)) return;
    if (!typeNames(annotation).some((name) => seamTypes.has(name))) return;
    const name = boundName(node);
    if (name !== undefined) bound.add(name);
  });
  return bound;
}

/** Classify the name a call site passed. See {@link StoreWriteKind}. */
function classify(argument: Node | undefined): StoreWriteKind {
  if (argument === undefined) return "unclassified";
  if (argument.type === "TemplateLiteral") return "made-here";
  if (argument.type === "Literal") return typeof argument.value === "string" ? "made-here" : "unclassified";
  if (argument.type === "BinaryExpression" && argument.operator === "+") return "made-here";
  if (argument.type === "CallExpression" || argument.type === "NewExpression") return "composed";
  if (argument.type === "Identifier" || argument.type === "MemberExpression") return "forwarded";
  if (argument.type === "AwaitExpression" || argument.type === "TSNonNullExpression") {
    return classify(
      isNode(argument.argument) ? argument.argument : isNode(argument.expression) ? argument.expression : undefined,
    );
  }
  return "unclassified";
}

/**
 * Analyze one set of sources.
 *
 * Order matters and is the argument for one pass object rather than four exported functions: the seam is
 * discovered from the manager's verbs, and the call sites are discovered from both.
 */
export function analyzeStoreWrites(sources: readonly StoreWriteSource[], parse: ParseModule): StoreWriteAnalysis {
  const modules = parseAll(sources, parse);
  const sdk = sdkSites(modules);
  const sdkModules = [...new Set(sdk.map((site) => site.file))].sort();
  const holders = modules.filter((module) => sdkModules.includes(module.file));
  const verbs = managerVerbs(holders);
  const verbNames = new Set(verbs.map((verb) => verb.name));
  const seams = seamVerbs(modules, verbNames);
  const seamTypes = new Set(seams.map((seam) => seam.type));
  const seamNames = new Set(seams.map((seam) => seam.name));

  const sites: StoreWriteSite[] = [];
  for (const module of modules) {
    const bound = seamNames.size === 0 ? new Set<string>() : seamBoundNames(module, seamTypes);
    walk(module.program, (node) => {
      if (node.type !== "CallExpression" || !isNode(node.callee)) return;
      const chain = propertyChain(node.callee);
      if (chain.length < 2 || sdkVerbOf(chain) !== undefined) return;
      const verb = chain[chain.length - 1] as string;
      const receiver = chain[chain.length - 2] as string;
      const tier: "manager" | "seam" | undefined = verbNames.has(verb)
        ? "manager"
        : seamNames.has(verb) && bound.has(receiver)
          ? "seam"
          : undefined;
      if (tier === undefined) return;
      const passed = Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
      const argument = passed[0];
      sites.push({
        file: module.file,
        line: module.lineAt(node.start ?? 0),
        verb,
        tier,
        argument: argument === undefined ? "" : sourceOf(module, argument),
        kind: classify(argument),
        call: `${verb}(${passed.map((each) => sourceOf(module, each)).join(", ")})`,
      });
    });
  }

  return {
    sdkSites: sdk,
    sdkModules,
    verbs,
    seamVerbs: seams,
    sites: sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    parsed: modules.length,
  };
}

/** `<file> <verb>(<args>)` — the key a declared row and a discovered site are matched on. */
export function siteKey(site: StoreWriteSite): string {
  return `${site.file} ${site.call}`;
}
