// xAI rejects any tool whose parameter schema does not have an object at the
// root: "tool parameter root must be an object type (root schema is an
// anyOf/oneOf union with a non-object branch)". The rejection fails the whole
// request, not the one tool, so a single union-rooted definition makes every
// turn on that provider a 400.
//
// Codex ships exactly such a tool: `codex_app__automation_update` roots its
// schema in a `oneOf` over the view/create/update/delete shapes. The router
// relays the app toolset to routed providers verbatim, which is how a Grok
// session that never touches automations still dies on its first message.
//
// Flattening keeps the tool callable: the branches are merged into one object
// so the model still sees every field it may send, with `required` narrowed to
// the fields every branch demands (usually none, because the branches are
// alternatives). Validation of which combination is legal stays where it
// already was -- the Codex app executes these calls and checks its own
// arguments.

const MAX_DEPTH = 8;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Resolves the local `#/$defs/...` and `#/definitions/...` pointers Codex
// emits. Anything else (remote refs, unusual pointers) resolves to undefined
// and the branch is skipped rather than guessed at.
function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let node = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!isPlainObject(node)) return undefined;
    node = node[rawSegment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isPlainObject(node) ? node : undefined;
}

// Every object-typed leaf reachable from `schema` through unions and local
// refs. `seen` guards the self-referential `$defs` Codex generates.
function objectBranches(schema, root, seen, depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_DEPTH) return [];
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return [];
    seen.add(schema.$ref);
    return objectBranches(resolveRef(schema.$ref, root), root, seen, depth + 1);
  }
  const branches = [];
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) {
      branches.push(...objectBranches(branch, root, seen, depth + 1));
    }
  }
  if (schema.type === "object" || isPlainObject(schema.properties)) branches.push(schema);
  return branches;
}

const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf"];

function hasRootUnion(schema) {
  return UNION_KEYWORDS.some((keyword) => Array.isArray(schema[keyword]));
}

// xAI's rule is about the root *keywords*, not the declared type: a schema may
// say `type: "object"` and still be rejected for carrying a `oneOf` beside it.
// Checking only `type`/`properties` here is what let the live client's
// `automation_update` -- which sends both -- through untouched.
export function hasObjectRoot(schema) {
  if (!isPlainObject(schema)) return false;
  if (hasRootUnion(schema)) return false;
  return schema.type === "object" || isPlainObject(schema.properties);
}

// Returns `schema` unchanged when its root is already a plain object, so the
// common case costs one type check and no copy.
export function objectRootToolSchema(schema) {
  if (!isPlainObject(schema)) return { type: "object", properties: {} };
  if (hasObjectRoot(schema)) return schema;

  const branches = objectBranches(schema, schema, new Set());
  const properties = {};
  // Root-level properties apply to every branch, so they win over branch
  // definitions of the same name.
  if (isPlainObject(schema.properties)) Object.assign(properties, schema.properties);
  for (const branch of branches) {
    if (!isPlainObject(branch.properties)) continue;
    for (const [name, property] of Object.entries(branch.properties)) {
      if (!(name in properties)) properties[name] = property;
    }
  }
  // Required only where every branch requires it: a field the view branch
  // demands is optional for the delete branch, and marking it required would
  // reject calls the app accepts. Root-level requirements are separate -- they
  // bind every branch, so they survive whatever the branches disagree about.
  const rootRequired = Array.isArray(schema.required) ? schema.required : [];
  const unionBranches = branches.filter((branch) => branch !== schema);
  const shared = unionBranches.length
    ? unionBranches
        .map((branch) => (Array.isArray(branch.required) ? branch.required : []))
        .reduce((left, right) => left.filter((name) => right.includes(name)))
    : [];
  const required = [...new Set([...rootRequired, ...shared])];

  return {
    ...(schema.$schema ? { $schema: schema.$schema } : {}),
    ...(schema.$defs ? { $defs: schema.$defs } : {}),
    ...(schema.definitions ? { definitions: schema.definitions } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    // The merged object cannot describe which branch a call belongs to, so it
    // must not reject fields that only one branch declares.
    additionalProperties: true,
  };
}
