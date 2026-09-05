import ts from "typescript";

export function parseTypeScript(path, contents) {
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(?:js|mjs|cjs)$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, scriptKind);
}

export function staticPropertyName(node) {
  if (ts.isComputedPropertyName(node)) return staticPropertyName(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticPropertyName(node.left);
    const right = staticPropertyName(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

export function declaredPropertyName(node) {
  return ts.isIdentifier(node) ? node.text : staticPropertyName(node);
}

export function propertyAccessChain(node, resolveProperty = staticPropertyName) {
  if (
    ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
  ) return propertyAccessChain(node.expression, resolveProperty);
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return propertyAccessChain(node.expression, resolveProperty);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const prefix = propertyAccessChain(node.expression, resolveProperty);
    return prefix ? [...prefix, node.name.text] : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    const prefix = propertyAccessChain(node.expression, resolveProperty);
    const property = resolveProperty(node.argumentExpression);
    return prefix ? [...prefix, property ?? "*"] : undefined;
  }
  return undefined;
}

export const DOCUMENT_POLICY_TAGS = new Set([
  "a", "audio", "base", "embed", "iframe", "img", "link", "meta", "object",
  "script", "source", "style", "track", "video",
]);

export const DOCUMENT_POLICY_ATTRIBUTES = new Set([
  "action", "background", "cite", "codebase", "data", "formaction", "formtarget", "href", "http-equiv",
  "longdesc", "manifest", "ping", "poster", "profile", "src", "srcdoc", "srcset", "style", "target", "usemap", "xlink:href",
]);

export const DOCUMENT_POLICY_PROPERTIES = new Set([
  "StrictMode", "action", "adoptedStyleSheets", "dangerouslySetInnerHTML", "formAction", "formTarget", "href",
  "httpEquiv", "innerHTML", "innerText", "nodeValue", "outerHTML", "outerText", "poster", "src", "srcDoc",
  "srcSet", "srcdoc", "srcset", "style", "target", "textContent",
]);

export const DOCUMENT_POLICY_METHODS = new Set([
  "addRule", "adoptNode", "after", "append", "appendChild", "assign", "before", "cloneElement", "cloneNode",
  "createAttribute", "createAttributeNS", "createContextualFragment", "createElement", "createElementNS",
  "createHTMLDocument", "deleteRule", "execCommand", "getAttributeNode", "getAttributeNodeNS", "importNode",
  "insertAdjacentElement", "insertAdjacentHTML", "insertAdjacentText", "insertBefore", "insertRule", "parseHTMLUnsafe",
  "prepend", "replaceChild", "replaceChildren", "replaceSync", "replaceWith", "setAttribute", "setAttributeNode",
  "setAttributeNodeNS", "setAttributeNS", "setHTML", "setHTMLUnsafe", "setProperty", "write", "writeln",
]);

export const RAW_DOM_MUTATION_METHODS = new Set([
  "addRule", "adoptNode", "after", "append", "appendChild", "before", "cloneNode", "createAttribute",
  "createAttributeNS", "createElementNS", "createHTMLDocument", "deleteRule", "execCommand", "getAttributeNode",
  "getAttributeNodeNS", "importNode", "insertAdjacentElement", "insertAdjacentText", "insertBefore", "insertRule",
  "prepend", "replaceChild", "replaceChildren", "replaceSync", "replaceWith", "setAttributeNode", "setAttributeNodeNS",
]);

export const JSX_RESOURCE_ATTRIBUTES = new Set([
  "cite", "dangerouslySetInnerHTML", "data", "href", "ping", "poster", "src", "srcDoc", "srcSet", "xlink:href", "xlinkHref",
]);

export const JSX_URL_REFERENCE_ATTRIBUTES = new Set([
  "clipPath", "fill", "filter", "markerEnd", "markerMid", "markerStart", "mask", "stroke",
]);

export const SAFE_INLINE_STYLE_PROPERTIES = new Set([
  "height", "left", "maxHeight", "top", "transform", "transition", "width",
]);

const SAFE_STYLE_SET_PROPERTIES = new Set([
  "height", "left", "max-height", "top", "transform", "transition", "width",
  "--prompt-drag-x", "--prompt-drag-y",
]);

export function createStaticPropertyResolver(sourceFile, fallback) {
  const options = { allowJs: true, jsx: ts.JsxEmit.Preserve, noLib: true, target: ts.ScriptTarget.Latest };
  const host = {
    fileExists: (fileName) => fileName === sourceFile.fileName,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (fileName) => fileName === sourceFile.fileName ? sourceFile : undefined,
    readFile: (fileName) => fileName === sourceFile.fileName ? sourceFile.text : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  const checker = ts.createProgram([sourceFile.fileName], options, host).getTypeChecker();
  const declaration = (node) => {
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = checker.getSymbolAtLocation(node);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  const resolve = (node) => {
    if (ts.isComputedPropertyName(node)) return resolve(node.expression);
    if (ts.isIdentifier(node)) {
      const binding = declaration(node);
      if (
        binding && ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name) && binding.initializer &&
        ts.isVariableDeclarationList(binding.parent) && (binding.parent.flags & ts.NodeFlags.Const) !== 0
      ) return fallback(binding.initializer);
    }
    return fallback(node);
  };
  resolve.declaration = declaration;
  return resolve;
}

export function isReviewedReactStrictMode(path, opening, sourceFile, resolveDeclaration) {
  if (
    path !== "src/main.tsx" || opening.attributes.properties.length !== 0 ||
    !ts.isPropertyAccessExpression(opening.tagName) ||
    !ts.isIdentifier(opening.tagName.expression) || opening.tagName.expression.text !== "React" ||
    opening.tagName.name.text !== "StrictMode"
  ) return false;
  const binding = resolveDeclaration(opening.tagName.expression);
  return Boolean(
    binding && ts.isImportClause(binding) && !binding.isTypeOnly && binding.name?.text === "React" &&
    ts.isImportDeclaration(binding.parent) && ts.isStringLiteralLike(binding.parent.moduleSpecifier) &&
    binding.parent.moduleSpecifier.text === "react",
  );
}

export function isGlobalObjectAssign(chain, globalRoots) {
  return Boolean(
    chain?.slice(-2).join(".") === "Object.assign" &&
    (chain.length === 2 || globalRoots.has(chain[0])),
  );
}

export function domMutationHandleViolation(node, resolveChain, globalRoots) {
  const chain = resolveChain(node);
  const collection = chain?.find((name) =>
    ["adoptedStyleSheets", "attributes", "attributeStyleMap", "sheet", "styleSheets"].includes(name));
  if (collection) return `raw DOM ${collection} mutation handles are forbidden`;
  if (chain?.at(-1) !== "style") return undefined;
  const parent = node.parent;
  const isReceiver =
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node;
  const isReviewedAssignTarget =
    ts.isCallExpression(parent) && parent.arguments[0] === node &&
    isGlobalObjectAssign(resolveChain(parent.expression), globalRoots);
  return isReceiver || isReviewedAssignTarget ? undefined : "raw DOM style handles may not escape reviewed writes";
}

export function isForbiddenRuntimeAttributeName(name) {
  if (name === undefined) return true;
  const normalized = name.toLowerCase();
  return !normalized.startsWith("aria-") && !normalized.startsWith("data-");
}

export function jsxAttributeName(attribute) {
  return propertyName(attribute.name);
}

const REVIEWED_PROMPT_ICONS = new Map([
  ["search", "Search"], ["pin", "Pin"], ["copy", "Copy"], ["close", "X"], ["edit", "Pencil"],
  ["download", "Download"], ["drag", "GripVertical"], ["more", "MoreHorizontal"], ["tag", "Tag"],
  ["upload", "Upload"], ["plus", "Plus"], ["previous", "ChevronLeft"], ["next", "ChevronRight"],
]);

function enclosingImportDeclaration(node) {
  for (let current = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current)) return current;
  }
  return undefined;
}

function isTypeOnlyReference(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current)) return false;
  }
  return false;
}

export function isReviewedPromptsIconLookup(path, tagBinding, sourceFile, resolveDeclaration) {
  if (
    path !== "src/PromptsView.tsx" || !tagBinding || !ts.isVariableDeclaration(tagBinding) ||
    !ts.isIdentifier(tagBinding.name) || tagBinding.name.text !== "Component" ||
    !ts.isVariableDeclarationList(tagBinding.parent) || (tagBinding.parent.flags & ts.NodeFlags.Const) === 0 ||
    !tagBinding.initializer || !ts.isElementAccessExpression(tagBinding.initializer) ||
    !ts.isIdentifier(tagBinding.initializer.expression) || tagBinding.initializer.expression.text !== "iconComponents"
  ) return false;
  const mapAccess = tagBinding.initializer.expression;
  const mapBinding = resolveDeclaration(mapAccess);
  if (
    !mapBinding || !ts.isVariableDeclaration(mapBinding) || !ts.isIdentifier(mapBinding.name) ||
    mapBinding.name.text !== "iconComponents" || !ts.isObjectLiteralExpression(mapBinding.initializer) ||
    !ts.isVariableDeclarationList(mapBinding.parent) || (mapBinding.parent.flags & ts.NodeFlags.Const) === 0 ||
    mapBinding.parent.parent.parent !== sourceFile ||
    mapBinding.initializer.properties.length !== REVIEWED_PROMPT_ICONS.size
  ) return false;
  for (const property of mapBinding.initializer.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !ts.isIdentifier(property.initializer)) return false;
    const expectedImport = REVIEWED_PROMPT_ICONS.get(property.name.text);
    const importBinding = resolveDeclaration(property.initializer);
    const declaration = importBinding && enclosingImportDeclaration(importBinding);
    if (
      expectedImport !== property.initializer.text || !importBinding || !ts.isImportSpecifier(importBinding) ||
      importBinding.isTypeOnly || importBinding.name.text !== expectedImport ||
      (importBinding.propertyName ?? importBinding.name).text !== expectedImport || !declaration ||
      !ts.isStringLiteralLike(declaration.moduleSpecifier) || declaration.moduleSpecifier.text !== "lucide-react" ||
      declaration.importClause?.isTypeOnly
    ) return false;
  }
  let validReferences = true;
  const visit = (node) => {
    if (
      validReferences && ts.isIdentifier(node) && resolveDeclaration(node) === mapBinding &&
      node !== mapBinding.name && node !== mapAccess && !isTypeOnlyReference(node)
    ) validReferences = false;
    if (validReferences) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return validReferences;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isJsxNamespacedName(node)) return `${node.namespace.text}:${node.name.text}`;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) {
    return node.expression.text;
  }
  return undefined;
}

function isSafeStyleExpression(node) {
  if (ts.isParenthesizedExpression(node)) return isSafeStyleExpression(node.expression);
  if (ts.isIdentifier(node)) return node.text === "undefined";
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isConditionalExpression(node)) {
    return isSafeStyleExpression(node.whenTrue) && isSafeStyleExpression(node.whenFalse);
  }
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.every((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = propertyName(property.name);
    return name !== undefined && SAFE_INLINE_STYLE_PROPERTIES.has(name);
  });
}

export function jsxUrlReferenceIsUnreviewed(attribute) {
  const initializer = attribute.initializer;
  if (!initializer) return false;
  if (ts.isStringLiteral(initializer)) return /(?:url|image-set)\s*\(/i.test(initializer.text);
  if (
    ts.isJsxExpression(initializer) && initializer.expression &&
    ts.isStringLiteralLike(initializer.expression)
  ) return /(?:url|image-set)\s*\(/i.test(initializer.expression.text);
  return true;
}

export function findJsxResourceEscape(opening, tag, allowSpread = false) {
  return opening.attributes.properties.find((attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) return !allowSpread;
    if (!ts.isJsxAttribute(attribute)) return false;
    const name = propertyName(attribute.name);
    if (JSX_RESOURCE_ATTRIBUTES.has(name) && !(tag === "a" && name === "href")) return true;
    if (name === "style") return jsxStyleIsUnreviewed(attribute);
    return JSX_URL_REFERENCE_ATTRIBUTES.has(name) && jsxUrlReferenceIsUnreviewed(attribute);
  });
}

export function unreviewedStylePropertyWrite(chain) {
  const styleIndex = chain?.lastIndexOf("style") ?? -1;
  if (styleIndex < 0) return false;
  const property = chain.at(-1);
  return property === "style" || property === "*" || !SAFE_INLINE_STYLE_PROPERTIES.has(property);
}

export function documentPropertyWriteViolation(chain) {
  if (chain?.at(-1) === "*" || DOCUMENT_POLICY_PROPERTIES.has(chain?.at(-1))) {
    return "form navigation, raw HTML, computed, or document-policy property writes are forbidden";
  }
  return unreviewedStylePropertyWrite(chain) ? "unreviewed DOM style writes are forbidden" : undefined;
}

export function isWriteTarget(node) {
  const parent = node.parent;
  if (
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      parent.operand === node &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)) ||
    (ts.isDeleteExpression(parent) && parent.expression === node)
  ) return true;
  let current = node;
  for (;;) {
    const next = current.parent;
    if (!next) break;
    if (
      (ts.isParenthesizedExpression(next) && next.expression === current) ||
      (ts.isPropertyAssignment(next) && next.initializer === current) ||
      (ts.isSpreadAssignment(next) && next.expression === current) ||
      (ts.isObjectLiteralExpression(next) && next.properties.includes(current)) ||
      (ts.isArrayLiteralExpression(next) && next.elements.includes(current))
    ) current = next;
    else break;
  }
  const assignment = current.parent;
  return Boolean(assignment && ts.isBinaryExpression(assignment) && assignment.left === current &&
    assignment.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    assignment.operatorToken.kind <= ts.SyntaxKind.LastAssignment);
}

export function unreviewedStyleSetPropertyCall(call, chain, resolveProperty) {
  if (chain?.at(-1) !== "setProperty" || !chain.includes("style")) return false;
  const property = resolveProperty(call.arguments[0]);
  return property === undefined || !SAFE_STYLE_SET_PROPERTIES.has(property);
}

export function objectAssignHasUnreviewedDocumentPolicyWrite(call, resolveProperty) {
  return call.arguments.slice(1).some((source) => {
    if (!ts.isObjectLiteralExpression(source)) return true;
    return source.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return true;
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return true;
      const name = ts.isComputedPropertyName(property.name)
        ? resolveProperty(property.name.expression)
        : propertyName(property.name);
      return name === undefined || DOCUMENT_POLICY_PROPERTIES.has(name);
    });
  });
}

export function objectAssignHasUnreviewedStyleWrite(call, resolveProperty, resolveChain) {
  if (!resolveChain(call.arguments[0])?.includes("style")) return false;
  return call.arguments.slice(1).some((source) => {
    if (!ts.isObjectLiteralExpression(source)) return true;
    return source.properties.some((property) => {
      if (!ts.isPropertyAssignment(property)) return true;
      const name = ts.isComputedPropertyName(property.name)
        ? resolveProperty(property.name.expression)
        : propertyName(property.name);
      return name === undefined || !SAFE_INLINE_STYLE_PROPERTIES.has(name);
    });
  });
}

export function recoveredDocumentPolicyMethod(node, resolveChain) {
  let current = node;
  while (
    (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) current = current.parent;
  const chain = resolveChain(current);
  const method = chain?.find((name) => DOCUMENT_POLICY_METHODS.has(name));
  if (!method) return undefined;
  const isDirectCall =
    chain.at(-1) === method && ts.isCallExpression(current.parent) && current.parent.expression === current;
  return isDirectCall ? undefined : method;
}

export function jsxStyleIsUnreviewed(attribute) {
  const initializer = attribute.initializer;
  if (!initializer) return true;
  if (ts.isStringLiteral(initializer)) return /(?:url|image-set)\s*\(/i.test(initializer.text);
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return true;
  return !isSafeStyleExpression(initializer.expression);
}
