// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Nothing non-deterministic may be evaluated in a Workflow driver body.**
 *
 * A Cloudflare Workflow does not resume inside the step it died in. It re-executes the driver from the top
 * and serves every completed step from the journal. So a value the body *computes* answers differently on
 * every attempt, while a value the journal *holds* does not — and every field the pages behind the
 * interruption were already written under has to come from the second kind.
 *
 * The kit has now shipped this defect four times, in four capabilities, one field at a time: payments minted
 * its run id in the body (#328), then read its clock in the body in the very fix for it (#331), and testers,
 * email and secrets each held a body-read clock of their own. Patching the reported field and leaving its
 * sibling is the failure mode, so this is a statement about *where* a value may be produced rather than a
 * list of the ways to produce one.
 *
 * ## The rule, and why it is not a list of function names
 *
 * > **A driver body may not evaluate a nullary call or a nullary construction.**
 *
 * A call that takes no arguments cannot compute its result from its input, because it has none. Whatever it
 * returns therefore came from outside the program — a clock, an entropy source, a counter, a queue. That is
 * the whole population of things a replay must not re-read, and it is closed under the next author's
 * favourite spelling of it: `Date.now()`, `new Date()`, `crypto.randomUUID()`, `performance.now()`,
 * `deps.now()` and the sixth thing nobody has written yet are all nullary, necessarily, because a source
 * takes no input. A deny-list of names would have caught the first five and not the sixth — which is
 * pithy-sh/pithy#326 finding 4 in miniature, and precisely what this refuses to be.
 *
 * Two structural exceptions, both of which are the rule rather than holes in it:
 *
 *   - **A function-like node is not evaluated where it is written.** `now: () => new Date()` handed into a
 *     step is the *correct* pattern — the thunk is defined in the body and called inside the journal — so
 *     the walk stops at every function boundary. That is also what excludes a `step.do` callback, which
 *     needs no special case: it is an arrow like any other.
 *   - **A module-local function called from the body is part of the body.** `await buildSendDeps(this.env)`
 *     is one argument long and perfectly innocent-looking, and email's clock was inside it. So the walk
 *     follows a call to a function declared in the same module and judges its body by the same rule.
 *
 * ## What this does not see
 *
 * A thunk defined and then *called* in the same driver body would be missed: the call site is an identifier
 * this walker does not resolve to its arrow. Nothing in the tree does that, and the population assertions in
 * `workflowDeterminism.test.ts` are what would surface a new driver that did.
 *
 * The population is discovered, never declared: a driver is the `run` of a class extending
 * `WorkflowEntrypoint`, or any function taking a parameter typed as a step runner — and a step runner is
 * itself discovered, as any interface in the tree whose one member is `do(name, callback)`. A capability
 * that adds a Workflow tomorrow is analysed tomorrow, with nothing to remember.
 *
 * ## A second rule, off the same walk (#426)
 *
 * > **Every module in this kit that extends `WorkflowEntrypoint` has a default export.**
 *
 * A worker whose entry exports only classes is not an ES module as far as the build is concerned. wrangler
 * warns, falls back to service-worker format, and then refuses the entry outright — `Unexpected external
 * import of "cloudflare:workers" and "cloudflare:workflows"` — so the host does not build at all. `pithy dev`
 * carries on with the rest of the set, which is how three of these shipped: `support`, `media` and `vector`
 * each had no cron, so nothing prompted anyone to write the `export default { async scheduled(…) }` that
 * happened to make the other four ES modules. The format was a side effect of a feature four hosts wanted
 * and three did not.
 *
 * So the property belongs to the *class*, not to whoever remembers it, and it is answered here rather than
 * in a list: this walk already knows every module in the tree that extends `WorkflowEntrypoint`, and whether
 * that module has a default export is one more question about the same file. See {@link WorkflowHostModule}
 * and `workflowModuleFormat.test.ts`, which is what holds the kit to it.
 */

/** A source file the analysis reads. The same shape `sourceFiles` yields, so the tree walk feeds it directly. */
export interface DriverSource {
  /** Path to the file, used in findings. */
  readonly path: string;
  /** Its text. */
  readonly text: string;
}

/** One Workflow driver body the analysis found. */
export interface WorkflowDriver {
  /** The file it lives in. */
  readonly file: string;
  /** `ClassName.run` for a Workflow class, or the function's name for a delegate that takes a step runner. */
  readonly name: string;
  /** Whether it is the Workflow class itself or a function the class hands its step runner to. */
  readonly kind: "entrypoint" | "delegate";
}

/** One evaluation of a source in a driver body — the thing this gate exists to refuse. */
export interface DriverFinding extends WorkflowDriver {
  /** 1-indexed line of the offending expression. */
  readonly line: number;
  /** The expression as written, e.g. `deps.now()` or `new Date()`. */
  readonly expression: string;
  /** Where it was found: the driver body itself, or a module-local function the body calls. */
  readonly via: string;
}

/**
 * One module that hosts at least one Workflow, and whether the build will read it as an ES module.
 *
 * The unit is the **file**, not the class: `main` in a `wrangler.jsonc` names a module, and the default
 * export is a property of that module however many Workflow classes it happens to hold.
 */
export interface WorkflowHostModule {
  /** The file, repo-relative as the caller supplied it. */
  readonly file: string;
  /** Every `WorkflowEntrypoint` subclass it declares, sorted. Never empty — that is what puts it here. */
  readonly classes: string[];
  /** Whether the module declares a default export, in any of the three spellings ESTree has for one. */
  readonly defaultExport: boolean;
}

/** What one analysis pass found. */
export interface DriverAnalysis {
  /** Every `WorkflowEntrypoint` subclass in the tree, as `path#ClassName`, sorted. */
  readonly entrypoints: string[];
  /** Every module holding one or more of those classes, sorted by path. See {@link WorkflowHostModule}. */
  readonly hosts: WorkflowHostModule[];
  /** Every driver body analysed. */
  readonly drivers: WorkflowDriver[];
  /** Every `WorkflowSpec.className` declared anywhere in the tree, sorted. */
  readonly declaredClassNames: string[];
  /** Every violation of the rule. */
  readonly findings: DriverFinding[];
  /** Files that were parsed. A gate over an empty population is not a gate. */
  readonly parsed: number;
}

/**
 * An AST node, structurally. The walk needs a discriminant, a position and children; it needs nothing else.
 *
 * **ESTree.** The names below — `MethodDefinition`, `Property`, `Literal` — are the standard ones, not any
 * one parser's dialect, which is what lets the parser behind `ParseModule` be replaced without touching this.
 */
export interface Node {
  readonly type: string;
  /** Byte offset of the node in the source text. Turned into a line by `lineIndex`. */
  readonly start?: number;
  readonly [key: string]: unknown;
}

/**
 * The parser, injected.
 *
 * A seam rather than an import, for one reason: the parser this gate uses is a dev-only dependency, and this
 * module ships. Taking it as a parameter keeps a published `@pithy-sh/cli` free of a module that imports
 * something an installer never gets — and lets the fixture cases in the gate's own suite run through exactly
 * the code path the tree scan does.
 *
 * It must yield an ESTree program. Everything this module knows about a tree is written in ESTree's names.
 */
export type ParseModule = (text: string) => Node;

/**
 * The node kinds that defer evaluation of what is inside them.
 *
 * This is a fact about the language rather than a policy: a function body runs where the function is called,
 * so nothing written inside one is evaluated at the point it appears. It is what makes `() => new Date()`
 * handed to a step legal and `new Date()` beside it not.
 *
 * Three entries, and that is the whole of it in ESTree: a method is a `MethodDefinition` or a `Property`
 * *wrapping* a `FunctionExpression`, so the wrapper is walked — its computed key is evaluated where it is
 * written — and the function inside it is not.
 */
const DEFERRED = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** The superclass every Cloudflare Workflow extends. The platform's name for the seam, not ours. */
const WORKFLOW_BASE = "WorkflowEntrypoint";

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Every child node of `node`, in source order. Property-driven, so it needs no per-kind knowledge. */
function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (isNode(value)) found.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isNode(item)) found.push(item);
  }
  return found;
}

/**
 * Offsets to 1-indexed lines.
 *
 * An ESTree node carries a byte offset, not a line, so the line a finding prints is derived here from the
 * same text the parser read. Built once per file and searched, rather than counted per finding.
 */
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

/** `deps.now` → `deps.now`; `crypto.randomUUID` → `crypto.randomUUID`; anything computed → undefined. */
function memberPath(node: Node): string | undefined {
  if (node.type === "Identifier") return nameOf(node);
  if (node.type !== "MemberExpression" || node.computed === true) return undefined;
  const object = isNode(node.object) ? memberPath(node.object) : undefined;
  const property = nameOf(node.property);
  if (node.type === "MemberExpression" && isNode(node.object) && node.object.type === "ThisExpression") {
    return property === undefined ? undefined : `this.${property}`;
  }
  return object !== undefined && property !== undefined ? `${object}.${property}` : undefined;
}

/**
 * Is this interface a step runner?
 *
 * Structurally: one member, called `do`, taking a name and a callback. That is the whole of the seam every
 * package declares for itself — `ReconcileStep`, `ReprocessStep`, `StepRunner` — and it is how a fourth one
 * added tomorrow is recognised without being written down here.
 */
function isStepRunnerInterface(node: Node): boolean {
  if (node.type !== "TSInterfaceDeclaration" || !isNode(node.body)) return false;
  const members = Array.isArray(node.body.body) ? node.body.body.filter(isNode) : [];
  if (members.length !== 1) return false;
  const member = members[0] as Node;
  if (member.type !== "TSMethodSignature") return false;
  return nameOf(member.key) === "do" && Array.isArray(member.params);
}

/** The type name a parameter is annotated with, if it is a plain reference. */
function parameterTypeName(param: Node): string | undefined {
  const annotation = param.typeAnnotation;
  if (!isNode(annotation) || !isNode(annotation.typeAnnotation)) return undefined;
  const reference = annotation.typeAnnotation;
  if (reference.type !== "TSTypeReference" || !isNode(reference.typeName)) return undefined;
  return nameOf(reference.typeName);
}

/**
 * Does this module declare a default export?
 *
 * Top-level only, because that is the only place one can be, and structural rather than textual: a comment
 * or a string containing `export default` is not one, and `export { entry as default }` is.
 *
 * All three ESTree spellings count, and a re-export counts too — `export { default } from "./entry"` puts a
 * default binding on this module, which is the whole of what the build asks.
 */
function hasDefaultExport(program: Node): boolean {
  const body = Array.isArray(program.body) ? program.body.filter(isNode) : [];
  for (const statement of body) {
    // A type is not a default export, whatever it is spelled like — Jim, 2026-08-21.
    //
    // `export type { HostEntry as default }` and `export default interface HostEntry {}` both put the
    // word `default` in the syntax tree and neither survives to runtime: `verbatimModuleSyntax` erases
    // them, so the emitted module has no default binding and wrangler infers Service Worker format
    // exactly as before. An adversarial pass planted both against a copy of the pre-fix support host
    // and this function answered `true` while the real build still failed with `Unexpected external
    // import of "cloudflare:workers"`.
    //
    // `exportKind` is `"type"` on those and `"value"` on everything real, which is the fact this rule
    // is actually about: the build asks whether the *emitted* module has a default binding.
    if (statement.exportKind === "type") continue;
    if (statement.type === "ExportDefaultDeclaration") {
      // And the declaration itself, because `export default interface X {}` is a value-kind statement
      // whose declaration is a type. There is nothing to emit for either.
      const declared = isNode(statement.declaration) ? statement.declaration.type : "";
      if (declared === "TSInterfaceDeclaration" || declared === "TSTypeAliasDeclaration") continue;
      return true;
    }
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") {
      const specifiers = Array.isArray(statement.specifiers) ? statement.specifiers.filter(isNode) : [];
      const exported = statement.type === "ExportAllDeclaration" ? [statement] : specifiers;
      for (const entry of exported) {
        // Per-specifier too: `export { a, type b as default }` is a value-kind statement carrying one
        // type specifier, so the statement-level check above does not see it.
        if (entry.exportKind === "type") continue;
        if (nameOf(entry.exported) === "default") return true;
      }
    }
  }
  return false;
}

/** Collect every function declaration in a module, by name, so a call from a driver body can be followed. */
function moduleFunctions(program: Node): Map<string, Node> {
  const found = new Map<string, Node>();
  const visit = (node: Node): void => {
    if (node.type === "FunctionDeclaration") {
      const name = nameOf(node.id);
      if (name !== undefined) found.set(name, node);
    }
    for (const child of children(node)) visit(child);
  };
  visit(program);
  return found;
}

/** Every name a binding pattern introduces — a plain identifier, or one buried in destructuring. */
function boundNames(pattern: unknown, into: Set<string>): void {
  if (!isNode(pattern)) return;
  const name = nameOf(pattern);
  if (name !== undefined) {
    into.add(name);
    return;
  }
  for (const child of children(pattern)) boundNames(child, into);
}

/**
 * The bindings a scope holds that carry a value it already has, rather than a way of getting one.
 *
 * This is the line between `now.getTime()` and `deps.now()`, and it is the only thing in this file that has to
 * be careful. `now` is a `const` the body computed from a journalled step; calling a method on it reads a
 * value already in hand and answers the same on every replay. `deps` is a *parameter* — the injected effect
 * surface — and `Date` is a free identifier the module never declared. Both of those reach outside.
 *
 * So: a local declared in this scope is a value; a parameter, an import, and a global are not.
 *
 * **Aliasing is not a way round it.** A local whose initializer is just a name or a property of one — the
 * `const clock = deps.clock` shape — is a second name for the seam rather than a value, so it does not count
 * as local. A local initialized from an expression that *produces* something (a call, a construction, an
 * `await step.do`) does.
 */
function localValues(scope: Node): Set<string> {
  const locals = new Set<string>();
  const visit = (node: Node): void => {
    if (node !== scope && DEFERRED.has(node.type)) return;
    if (node.type === "VariableDeclarator") {
      const initializer = node.init;
      const aliasesASeam =
        isNode(initializer) &&
        (initializer.type === "Identifier" ||
          (initializer.type === "MemberExpression" && memberPath(initializer) !== undefined));
      if (!aliasesASeam) boundNames(node.id, locals);
    }
    for (const child of children(node)) visit(child);
  };
  visit(scope);
  return locals;
}

/**
 * Walk one scope, refusing every nullary evaluation of something the scope does not already hold, and
 * following calls into this module's own functions.
 *
 * `seen` guards recursion through a helper that calls itself; `via` names where a finding actually sits, so
 * a clock two frames down from the body is reported at the function that holds it rather than at the call.
 */
function walkScope(
  scope: Node,
  context: {
    driver: WorkflowDriver;
    functions: Map<string, Node>;
    via: string;
    seen: Set<string>;
    lineAt: (offset: number) => number;
  },
  findings: DriverFinding[],
): void {
  const locals = localValues(scope);
  const visit = (node: Node): void => {
    if (node !== scope && DEFERRED.has(node.type)) return;

    // `a?.b()` is a `CallExpression` inside a `ChainExpression` in ESTree, so the two kinds below are the
    // whole population of evaluations. The chain wrapper needs no case: it is walked like any other node.
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const callee = isNode(node.callee) ? node.callee : undefined;
      const path = callee ? memberPath(callee) : undefined;
      const root = path?.split(".")[0];

      // A call into this module's own code is part of the body, whatever its arity: the value it produces is
      // produced here. Followed once, and judged by the same rule.
      if (path !== undefined && context.functions.has(path) && !context.seen.has(path)) {
        context.seen.add(path);
        const target = context.functions.get(path) as Node;
        walkScope(target, { ...context, via: path }, findings);
      } else if (args.length === 0 && (root === undefined || !locals.has(root))) {
        // Nullary, on something this scope does not already hold. It takes no input and its receiver is not a
        // value the body computed, so whatever it answers came from outside the program.
        const written = path === undefined ? node.type : path;
        findings.push({
          ...context.driver,
          line: node.start === undefined ? 0 : context.lineAt(node.start),
          expression: node.type === "NewExpression" ? `new ${written}()` : `${written}()`,
          via: context.via,
        });
      }
    }

    for (const child of children(node)) visit(child);
  };
  visit(scope);
}

/**
 * Analyse a set of source files for Workflow driver bodies and the sources they evaluate.
 *
 * Everything is derived from the files: the Workflow classes, the modules that hold them, the step-runner
 * interfaces, the delegates that take one, and the class names the `WorkflowSpec` maps declare. Nothing about
 * the shipped population is written down here, which is the point — see the module doc.
 */
export function analyseDrivers(sources: readonly DriverSource[], parseModule: ParseModule): DriverAnalysis {
  const programs: { source: DriverSource; program: Node }[] = [];
  for (const source of sources) programs.push({ source, program: parseModule(source.text) });

  // Pass one: every step-runner interface in the tree, by name.
  const stepRunners = new Set<string>();
  for (const { program } of programs) {
    const visit = (node: Node): void => {
      if (isStepRunnerInterface(node)) {
        const name = nameOf(node.id);
        if (name !== undefined) stepRunners.add(name);
      }
      for (const child of children(node)) visit(child);
    };
    visit(program);
  }

  const entrypoints: string[] = [];
  const hosts: WorkflowHostModule[] = [];
  const declaredClassNames = new Set<string>();
  const drivers: WorkflowDriver[] = [];
  const findings: DriverFinding[] = [];

  for (const { source, program } of programs) {
    const functions = moduleFunctions(program);
    const bodies: { driver: WorkflowDriver; scope: Node }[] = [];
    // The classes this one file declares, collected as the walk finds them — the module-format rule asks
    // about the file, and `entrypoints` is flat across the tree.
    const hosted: string[] = [];

    const visit = (node: Node): void => {
      // A Workflow class: its `run` is a driver body, and the second parameter is the platform's step runner.
      if (
        (node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
        isNode(node.superClass) &&
        nameOf(node.superClass) === WORKFLOW_BASE
      ) {
        const className = nameOf(node.id) ?? "<anonymous>";
        entrypoints.push(`${source.path}#${className}`);
        hosted.push(className);
        const members = isNode(node.body) && Array.isArray(node.body.body) ? node.body.body.filter(isNode) : [];
        for (const member of members) {
          if (member.type !== "MethodDefinition" || nameOf(member.key) !== "run") continue;
          // The scope is the `FunctionExpression`, never the `MethodDefinition` that holds it. A method is a
          // wrapper in ESTree, and a wrapper's first child is a deferred node — so walking the wrapper walks
          // exactly nothing, silently, and reports every driver in the kit clean.
          const body = member.value;
          if (!isNode(body)) continue;
          bodies.push({
            driver: { file: source.path, name: `${className}.run`, kind: "entrypoint" },
            scope: body,
          });
        }
      }

      // A delegate: any function handed a step runner. It re-executes on resume exactly as the class does.
      if (node.type === "FunctionDeclaration" && Array.isArray(node.params)) {
        const params = node.params.filter(isNode);
        if (
          params.some((param) => {
            const type = parameterTypeName(param);
            return type !== undefined && stepRunners.has(type);
          })
        ) {
          const name = nameOf(node.id);
          if (name !== undefined) {
            bodies.push({ driver: { file: source.path, name, kind: "delegate" }, scope: node });
          }
        }
      }

      // A `WorkflowSpec`'s `className` — the second, independent enumeration of the shipped population.
      //
      // Recognised by the spec's own shape rather than by the key alone: `className` is also what a
      // `durable_object` binding names its class with, so a bare key search collects `MatchmakingPresence`
      // and asserts that a Durable Object is a Workflow. A `WorkflowSpec` is the object that carries a
      // `binding`, a `params` schema and a `className` together.
      if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
        const properties = node.properties.filter(isNode);
        const keys = new Set(properties.map((property) => nameOf(property.key)));
        if (keys.has("binding") && keys.has("params") && keys.has("className")) {
          const declared = properties.find((property) => nameOf(property.key) === "className");
          const value = declared !== undefined && isNode(declared.value) ? declared.value : undefined;
          if (value?.type === "Literal" && typeof value.value === "string") declaredClassNames.add(value.value);
        }
      }

      for (const child of children(node)) visit(child);
    };
    visit(program);

    // A file that declares no Workflow class is not a host, whatever else it exports. The default-export
    // question is only asked of files the answer means something for.
    if (hosted.length > 0) {
      hosts.push({ file: source.path, classes: hosted.sort(), defaultExport: hasDefaultExport(program) });
    }

    if (bodies.length > 0) {
      const lineAt = lineIndex(source.text);
      for (const { driver, scope } of bodies) {
        drivers.push(driver);
        walkScope(scope, { driver, functions, via: driver.name, seen: new Set([driver.name]), lineAt }, findings);
      }
    }
  }

  return {
    entrypoints: entrypoints.sort(),
    hosts: hosts.sort((a, b) => a.file.localeCompare(b.file)),
    drivers: drivers.sort((a, b) => `${a.file}#${a.name}`.localeCompare(`${b.file}#${b.name}`)),
    declaredClassNames: [...declaredClassNames].sort(),
    findings,
    parsed: programs.length,
  };
}
