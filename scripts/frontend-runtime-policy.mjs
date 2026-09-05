import ts from "typescript";
import {
  RAW_DOM_MUTATION_METHODS,
  DOCUMENT_POLICY_METHODS,
  DOCUMENT_POLICY_PROPERTIES,
  DOCUMENT_POLICY_TAGS,
  createStaticPropertyResolver, domMutationHandleViolation,
  declaredPropertyName,
  documentPropertyWriteViolation,
  findJsxResourceEscape,
  isForbiddenRuntimeAttributeName, isGlobalObjectAssign, isReviewedPromptsIconLookup, isReviewedReactStrictMode, jsxAttributeName,
  isWriteTarget,
  objectAssignHasUnreviewedDocumentPolicyWrite,
  objectAssignHasUnreviewedStyleWrite,
  parseTypeScript,
  propertyAccessChain,
  recoveredDocumentPolicyMethod,
  staticPropertyName,
  unreviewedStyleSetPropertyCall,
} from "./frontend-dom-policy.mjs";

function jsxTagName(name) {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function getJsxAttribute(opening, name) {
  return opening.attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && jsxAttributeName(attribute) === name,
  );
}

function staticJsxAttributeValue(attribute) {
  if (!attribute?.initializer) return true;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    ts.isStringLiteralLike(attribute.initializer.expression)
  ) return attribute.initializer.expression.text;
  return undefined;
}

function isHrefFallback(expression) {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
    ts.isIdentifier(expression.left) &&
    expression.left.text === "href" &&
    ts.isStringLiteralLike(expression.right) &&
    expression.right.text === ""
  );
}

function isReviewedPromptsAnchor(opening) {
  if (
    opening.attributes.properties.length !== 3 ||
    opening.attributes.properties.some((attribute) => ts.isJsxSpreadAttribute(attribute))
  ) return false;
  const href = getJsxAttribute(opening, "href");
  const rel = getJsxAttribute(opening, "rel");
  const onClick = getJsxAttribute(opening, "onClick");
  const hrefExpression = href?.initializer && ts.isJsxExpression(href.initializer)
    ? href.initializer.expression
    : undefined;
  const handler = onClick?.initializer && ts.isJsxExpression(onClick.initializer)
    ? onClick.initializer.expression
    : undefined;
  if (
    !ts.isIdentifier(hrefExpression) ||
    hrefExpression.text !== "href" ||
    staticJsxAttributeValue(rel) !== "noreferrer" ||
    !handler ||
    !ts.isArrowFunction(handler) ||
    handler.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    handler.parameters.length !== 1 ||
    !ts.isIdentifier(handler.parameters[0].name) ||
    !ts.isBlock(handler.body) ||
    handler.body.statements.length !== 2
  ) return false;
  const eventName = handler.parameters[0].name.text;
  const first = handler.body.statements[0];
  const firstExpression = ts.isExpressionStatement(first) ? first.expression : undefined;
  const firstChain = firstExpression && ts.isCallExpression(firstExpression)
    ? propertyAccessChain(firstExpression.expression)
    : undefined;
  const second = handler.body.statements[1];
  const secondExpression = ts.isExpressionStatement(second) ? second.expression : undefined;
  const adapterCall = secondExpression && ts.isVoidExpression(secondExpression)
    ? secondExpression.expression
    : undefined;
  if (
    firstChain?.join(".") !== `${eventName}.preventDefault` ||
    firstExpression.arguments.length !== 0 ||
    !adapterCall ||
    !ts.isCallExpression(adapterCall) ||
    !ts.isIdentifier(adapterCall.expression) ||
    adapterCall.expression.text !== "openExternal" ||
    adapterCall.arguments.length !== 1 ||
    !isHrefFallback(adapterCall.arguments[0])
  ) return false;
  for (let current = opening.parent; current; current = current.parent) {
    if (!ts.isConditionalExpression(current)) continue;
    const condition = current.condition;
    return (
      ts.isCallExpression(condition) &&
      ts.isIdentifier(condition.expression) &&
      condition.expression.text === "safeExternalUrl" &&
      condition.arguments.length === 1 &&
      isHrefFallback(condition.arguments[0])
    );
  }
  return false;
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text;
  }
  return undefined;
}

function belongsToDirectTauriInvoke(node) {
  let current = node;
  while (
    ts.isPropertyAccessExpression(current.parent) ||
    ts.isElementAccessExpression(current.parent)
  ) {
    if (current.parent.expression !== current) return false;
    current = current.parent;
  }
  if (!ts.isCallExpression(current.parent) || current.parent.expression !== current) return false;
  const chain = propertyAccessChain(current);
  return (
    chain?.at(-1) === "invoke" &&
    (chain.includes("__TAURI__") || chain.includes("__TAURI_INTERNALS__"))
  );
}

export function findForbiddenFrontendRuntimeUsage(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const sourceStaticPropertyName = createStaticPropertyResolver(sourceFile, staticPropertyName);
  const sourcePropertyAccessChain = (node) => propertyAccessChain(node, sourceStaticPropertyName);
  const rawNetworkApis = new Set();
  const runtimeBoundaryViolations = new Set();
  const dynamicExecutionViolations = new Set();
  const webkitCompatibilityViolations = new Set();
  let hardenedBrowserOpenCalls = 0;
  let importsTauriCoreOutsideApi = false;
  let invokesTauriGlobal = false;

  const rawNetworkNames = new Set(["fetch", "XMLHttpRequest", "EventSource", "WebSocket", "sendBeacon", "RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]);
  const globalNames = new Set(["window", "globalThis", "self", "frames", "top", "parent", "opener", "navigator", "document", "location"]);
  const dynamicExecutionNames = new Set(["CSSStyleSheet", "DOMParser", "eval", "Function", "WebAssembly"]);
  const asynchronousEscapeNames = new Set(["MessageChannel", "MessagePort", "postMessage", "queueMicrotask", "scheduler"]);
  const reflectiveObjectMethods = new Set(["create", "defineProperties", "defineProperty", "getPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "setPrototypeOf"]);
  const reflectivePropertyNames = new Set(["__proto__", "constructor", "prototype"]);
  const line = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const isTypeOnly = (node) => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isTypeNode(current)) return true;
      if (ts.isStatement(current)) return false;
    }
    return false;
  };
  const isNonReferenceIdentifier = (node) => {
    const parent = node.parent;
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node && parent.initializer !== node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isPropertyDeclaration(parent) && parent.name === node) ||
      (ts.isPropertySignature(parent) && parent.name === node)
    );
  };
  const isTypeofOperand = (node) =>
    ts.isTypeOfExpression(node.parent) && node.parent.expression === node;
  const recordDocumentPropertyWrite = (expression) => {
    if (!isWriteTarget(expression)) return;
    const violation = documentPropertyWriteViolation(sourcePropertyAccessChain(expression));
    if (violation) runtimeBoundaryViolations.add(`${path}:${line(expression)} ${violation}`);
  };

  const recordBrowserNavigation = (expression) => {
    const chain = propertyAccessChain(expression);
    if (!chain?.length) return;
    const globalRoot = globalNames.has(chain[0]);
    const locationIndex = chain.indexOf("location");
    const openIndex = chain.indexOf("open");
    if (locationIndex >= 0 && (globalRoot || locationIndex === 0)) {
      const isAllowedSearchRead =
        chain[0] === "window" &&
        chain[1] === "location" &&
        chain[2] === "search" &&
        !isWriteTarget(expression);
      if (!isAllowedSearchRead) {
        runtimeBoundaryViolations.add(
          `${path}:${line(expression)} raw location navigation is forbidden; retain only the reviewed window.location.search read`,
        );
      }
    }
    if (!globalRoot || openIndex < 1) return;
    const call = ts.isCallExpression(expression.parent) && expression.parent.expression === expression
      ? expression.parent
      : undefined;
    const firstArgument = call?.arguments[0];
    const canonicalValue = firstArgument && ts.isCallExpression(firstArgument)
      ? propertyAccessChain(firstArgument.expression)
      : undefined;
    const isExactHelperCall =
      path === "src/externalNavigation.ts" &&
      chain.join(".") === "window.open" &&
      call?.arguments.length === 3 &&
      canonicalValue?.join(".") === "parsed.toString" &&
      firstArgument.arguments.length === 0 &&
      ts.isStringLiteralLike(call.arguments[1]) &&
      call.arguments[1].text === "_blank" &&
      ts.isStringLiteralLike(call.arguments[2]) &&
      call.arguments[2].text === "noopener,noreferrer" &&
      enclosingFunctionName(call) === "openGithub";
    if (isExactHelperCall) hardenedBrowserOpenCalls += 1;
    else {
      runtimeBoundaryViolations.add(
        `${path}:${line(expression)} raw browser navigation is forbidden outside the exact openGithub adapter call`,
      );
    }
  };

  const recordFormSurface = (expression) => {
    const chain = propertyAccessChain(expression);
    if (!chain?.length) return;
    const api = chain.find((property) => ["submit", "requestSubmit"].includes(property));
    if (api) {
      runtimeBoundaryViolations.add(
        `${path}:${line(expression)} programmatic form submission is forbidden; use a synchronous React onSubmit boundary`,
      );
    }
  };

  const recordJsxSurface = (opening) => {
    const declaredTag = jsxTagName(opening.tagName);
    const resolvedTag = sourceStaticPropertyName(opening.tagName);
    const tag = resolvedTag ?? declaredTag;
    const tagBinding = sourceStaticPropertyName.declaration(opening.tagName);
    const reviewedMemberTag = isReviewedReactStrictMode(path, opening, sourceFile, sourceStaticPropertyName.declaration);
    const reviewedComponentProp =
      path === "src/PluginsView.tsx" &&
      new Set(["Button", "Detail", "EmptyState", "Section", "Tag"]).has(declaredTag);
    const reviewedIconLookup = declaredTag === "Component" &&
      isReviewedPromptsIconLookup(path, tagBinding, sourceFile, sourceStaticPropertyName.declaration);
    if (!declaredTag && !reviewedMemberTag) {
      runtimeBoundaryViolations.add(
        `${path}:${line(opening)} dynamic JSX member tag is forbidden outside the exact React.StrictMode root boundary`,
      );
    }
    if (
      /^[A-Z]/.test(declaredTag ?? "") && resolvedTag === undefined &&
      ((tagBinding && ts.isVariableDeclaration(tagBinding) && !reviewedIconLookup) ||
        (tagBinding && ts.isParameter(tagBinding) && !reviewedComponentProp) ||
        (tagBinding && ts.isBindingElement(tagBinding) && !reviewedComponentProp))
    ) {
      runtimeBoundaryViolations.add(
        `${path}:${line(opening)} dynamic JSX tag is forbidden outside the reviewed local icon component map`,
      );
    }
    if (DOCUMENT_POLICY_TAGS.has(tag) && tag !== "a") {
      runtimeBoundaryViolations.add(
        `${path}:${line(opening)} raw JSX navigation or document-policy elements are forbidden`,
      );
    }
    const allowSpread =
      path === "src/App.tsx" &&
      new Set(["PreferencesModal", "PreferencesPanel", "SettingsView"]).has(declaredTag);
    const resourceEscape = findJsxResourceEscape(opening, tag, allowSpread);
    if (resourceEscape) {
      runtimeBoundaryViolations.add(
        `${path}:${line(resourceEscape)} raw JSX resource loading is forbidden`,
      );
    }
    if (tag === "a") {
      const appAnchor =
        path === "src/App.tsx" &&
        opening.attributes.properties.length === 1 &&
        staticJsxAttributeValue(getJsxAttribute(opening, "href")) === "#source";
      const promptsAnchor = path === "src/PromptsView.tsx" && isReviewedPromptsAnchor(opening);
      if (!appAnchor && !promptsAnchor) {
        runtimeBoundaryViolations.add(
          `${path}:${line(opening)} raw JSX anchor is forbidden outside the fixed #source link or reviewed PromptsView external adapter`,
        );
      }
    }
    if (!["form", "button", "input"].includes(tag)) return;
    const dangerousAttribute = opening.attributes.properties.find(
      (attribute) =>
        ts.isJsxAttribute(attribute) &&
        ["action", "target", "formAction", "formTarget"].includes(jsxAttributeName(attribute)),
    );
    if (dangerousAttribute) {
      runtimeBoundaryViolations.add(
        `${path}:${line(dangerousAttribute)} form navigation attributes are forbidden; submit only through React handlers`,
      );
    }
  };

  const recordNetworkApi = (expression) => {
    const chain = propertyAccessChain(expression);
    if (!chain?.length) return;
    const api = chain.at(-1);
    if (rawNetworkNames.has(api)) rawNetworkApis.add(api);
    if (
      api === "invoke" &&
      (chain.includes("__TAURI__") || chain.includes("__TAURI_INTERNALS__"))
    ) {
      invokesTauriGlobal = true;
    }
  };

  const recordDynamicExecutionApi = (expression) => {
    const chain = propertyAccessChain(expression);
    if (!chain?.length) return;
    const api = chain.find((name) => dynamicExecutionNames.has(name));
    if (!api) return;
    dynamicExecutionViolations.add(
      `${path}:${line(expression)} uses dynamic execution API ${api}; executable payloads must be compiled, typed, owned, and covered by the governed module graph`,
    );
  };

  const recordReflectionApi = (expression) => {
    const chain = propertyAccessChain(expression);
    const directProperty = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ts.isElementAccessExpression(expression) &&
          ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text
        : undefined;
    if (directProperty && reflectivePropertyNames.has(directProperty)) {
      runtimeBoundaryViolations.add(
        `${path}:${line(expression)} runtime reflection is forbidden in production because it can hide network, timer, worker, dynamic execution, or Tauri APIs`,
      );
    }
    if (!chain?.length) return;
    const reflectIndex = chain.indexOf("Reflect");
    const isGlobalReflect =
      reflectIndex === 0 || (reflectIndex === 1 && globalNames.has(chain[0]));
    const proxyIndex = chain.indexOf("Proxy");
    const isGlobalProxy =
      proxyIndex === 0 || (proxyIndex === 1 && globalNames.has(chain[0]));
    const objectIndex = chain.indexOf("Object");
    const isGlobalObject =
      objectIndex === 0 || (objectIndex === 1 && globalNames.has(chain[0]));
    const isObjectReflection =
      isGlobalObject && reflectiveObjectMethods.has(chain.at(-1));
    const recoversDefaultView = chain.some((name) =>
      ["contentDocument", "contentWindow", "defaultView"].includes(name));
    const recoversEventView = chain.includes("view");
    const exposesObjectNamespace =
      isGlobalObject &&
      chain.at(-1) === "Object" &&
      !(
        (ts.isPropertyAccessExpression(expression.parent) ||
          ts.isElementAccessExpression(expression.parent)) &&
        expression.parent.expression === expression
      );
    if (recoversEventView) {
      runtimeBoundaryViolations.add(
        `${path}:${line(expression)} DOM view/Window recovery is forbidden because it can hide network or Tauri APIs`,
      );
    }
    if (
      !isGlobalReflect &&
      !isGlobalProxy &&
      !isObjectReflection &&
      !recoversDefaultView &&
      !recoversEventView &&
      !exposesObjectNamespace &&
      !(directProperty && reflectivePropertyNames.has(directProperty))
    ) return;
    if (!recoversEventView) {
      runtimeBoundaryViolations.add(
        `${path}:${line(expression)} runtime reflection is forbidden in production because it can hide network, timer, worker, dynamic execution, or Tauri APIs`,
      );
    }
  };

  const recordAsynchronousEscape = (expression) => {
    const chain = propertyAccessChain(expression);
    if (!chain?.length) return;
    const schedulerIndex = chain.findIndex((name) => name === "scheduler");
    const api = schedulerIndex >= 0 && chain[schedulerIndex + 1] === "postTask"
      ? "scheduler.postTask"
      : asynchronousEscapeNames.has(chain.at(-1))
        ? chain.at(-1)
        : undefined;
    if (!api) return;
    runtimeBoundaryViolations.add(
      `${path}:${line(expression)} asynchronous runtime API ${api} is forbidden outside the governed foreground scheduler and timer budget`,
    );
  };

  const recordUnsupportedWebkitApi = (expression) => {
    const chain = sourcePropertyAccessChain(expression);
    const api = chain?.at(-1);
    const hidesComputedCall =
      api === "*" && ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
    if ((!api || !["at", "structuredClone"].includes(api)) && !hidesComputedCall) return;
    webkitCompatibilityViolations.add(
      `${path}:${line(expression)} uses or hides ${api} runtime access that is unavailable before Safari 15.4; preserve the macOS 12 / Safari 15.0 runtime floor without relying on build-target polyfills`,
    );
  };

  const recordUnsupportedWebkitBinding = (node, name) => {
    const computed = ts.isComputedPropertyName(name);
    const api = computed
      ? sourceStaticPropertyName(name.expression)
      : declaredPropertyName(name);
    if ((!api || !["at", "structuredClone"].includes(api)) && !computed) return;
    webkitCompatibilityViolations.add(
      `${path}:${line(node)} aliases ${api ?? "*"}, which is unavailable before Safari 15.4; preserve the macOS 12 / Safari 15.0 runtime floor without relying on build-target polyfills`,
    );
  };

  const recordModuleSpecifier = (node) => {
    if (
      path !== "src/api.ts" &&
      ts.isStringLiteralLike(node) &&
      /^@tauri-apps\/api\/core(?:$|\/)/.test(node.text)
    ) {
      importsTauriCoreOutsideApi = true;
    }
  };

  const visit = (node) => {
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      recordUnsupportedWebkitBinding(node, node.propertyName ?? node.name);
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isObjectLiteralExpression(node.parent) &&
      ts.isBinaryExpression(node.parent.parent) &&
      node.parent.parent.left === node.parent &&
      node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      recordUnsupportedWebkitBinding(node, node.name);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      recordModuleSpecifier(node.moduleSpecifier);
    }
    if (
      ts.isImportSpecifier(node) && ["cloneElement", "createElement"].includes(
        (node.propertyName ?? node.name).text,
      )
    ) {
      runtimeBoundaryViolations.add(
        `${path}:${line(node)} programmatic document-policy React element factories may not be imported or aliased`,
      );
    }
    if (ts.isCallExpression(node)) {
      recordNetworkApi(node.expression);
      recordDynamicExecutionApi(node.expression);
      recordReflectionApi(node.expression);
      recordAsynchronousEscape(node.expression);
      recordFormSurface(node.expression);
      recordUnsupportedWebkitApi(node.expression);
      const callChain = sourcePropertyAccessChain(node.expression);
      const attributeName = callChain?.at(-1) === "setAttribute" ? sourceStaticPropertyName(node.arguments[0]) : undefined;
      if (callChain?.at(-1) === "setAttribute" && isForbiddenRuntimeAttributeName(attributeName)) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} form navigation or document-policy attributes are forbidden at runtime`,
        );
      }
      if (callChain?.at(-1) === "setAttributeNS") {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} namespaced document-policy runtime attributes are forbidden`,
        );
      }
      if (RAW_DOM_MUTATION_METHODS.has(callChain?.at(-1))) {
        runtimeBoundaryViolations.add(`${path}:${line(node)} raw DOM mutation APIs are forbidden`);
      }
      const elementMethod = ["createElement", "cloneElement"].includes(callChain?.at(-1))
        ? callChain.at(-1)
        : undefined;
      if (elementMethod) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} programmatic document-policy ${elementMethod} is forbidden; use a reviewed JSX boundary`,
        );
      }
      if (["createContextualFragment", "insertAdjacentHTML", "parseHTMLUnsafe", "setHTML", "setHTMLUnsafe", "write", "writeln"].includes(callChain?.at(-1))) {
        runtimeBoundaryViolations.add(`${path}:${line(node)} raw HTML injection APIs are forbidden`);
      }
      if (unreviewedStyleSetPropertyCall(node, callChain, sourceStaticPropertyName)) {
        runtimeBoundaryViolations.add(`${path}:${line(node)} unreviewed DOM style writes are forbidden`);
      }
      if (
        isGlobalObjectAssign(callChain, globalNames) &&
        (objectAssignHasUnreviewedDocumentPolicyWrite(node, sourceStaticPropertyName) ||
          objectAssignHasUnreviewedStyleWrite(node, sourceStaticPropertyName, sourcePropertyAccessChain))
      ) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} form navigation or document-policy property writes are forbidden`,
        );
      }
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        recordModuleSpecifier(node.arguments[0]);
      }
    }
    if (ts.isNewExpression(node)) {
      recordNetworkApi(node.expression);
      recordDynamicExecutionApi(node.expression);
      recordReflectionApi(node.expression);
      recordAsynchronousEscape(node.expression);
      recordFormSurface(node.expression);
    }

    if (ts.isIdentifier(node) && rawNetworkNames.has(node.text) && !isNonReferenceIdentifier(node) && !isTypeOnly(node)) {
      rawNetworkApis.add(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const chain = propertyAccessChain(node);
      recordNetworkApi(node);
      recordDynamicExecutionApi(node);
      recordReflectionApi(node);
      recordAsynchronousEscape(node);
      recordUnsupportedWebkitApi(node);
      recordDocumentPropertyWrite(node);
      const handleViolation = domMutationHandleViolation(node, sourcePropertyAccessChain, globalNames); if (handleViolation) runtimeBoundaryViolations.add(`${path}:${line(node)} ${handleViolation}`);
      const recoveredMethod = recoveredDocumentPolicyMethod(node, sourcePropertyAccessChain);
      if (recoveredMethod) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} document-policy method ${recoveredMethod} may not be aliased or recovered`,
        );
      }
      const isChainPrefix =
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node;
      if (!isChainPrefix) {
        recordBrowserNavigation(node);
        recordFormSurface(node);
      }
      if (chain && globalNames.has(chain[0]) && rawNetworkNames.has(chain.at(-1))) {
        rawNetworkApis.add(chain.at(-1));
      }
      if (
        chain?.includes("__TAURI__") ||
        chain?.includes("__TAURI_INTERNALS__")
      ) {
        if (chain.at(-1) === "invoke") invokesTauriGlobal = true;
        const isPresenceProbe =
          chain.length === 2 &&
          ((ts.isCallExpression(node.parent) &&
            ts.isIdentifier(node.parent.expression) &&
            node.parent.expression.text === "Boolean" &&
            node.parent.arguments.length === 1) ||
            isTypeofOperand(node));
        if (!isPresenceProbe && !belongsToDirectTauriInvoke(node)) {
          runtimeBoundaryViolations.add(
            `${path}:${line(node)} raw Tauri globals may only be used for the explicit Boolean presence probe`,
          );
        }
      }
    }
    if (ts.isElementAccessExpression(node)) {
      recordNetworkApi(node);
      recordDynamicExecutionApi(node);
      recordReflectionApi(node);
      recordAsynchronousEscape(node);
      recordUnsupportedWebkitApi(node);
      recordDocumentPropertyWrite(node);
      const handleViolation = domMutationHandleViolation(node, sourcePropertyAccessChain, globalNames); if (handleViolation) runtimeBoundaryViolations.add(`${path}:${line(node)} ${handleViolation}`);
      const recoveredMethod = recoveredDocumentPolicyMethod(node, sourcePropertyAccessChain);
      if (recoveredMethod) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} document-policy method ${recoveredMethod} may not be aliased or recovered`,
        );
      }
      const isChainPrefix =
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node;
      if (!isChainPrefix) {
        recordBrowserNavigation(node);
        recordFormSurface(node);
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      globalNames.has(propertyAccessChain(node.expression)?.[0])
    ) {
      recordDynamicExecutionApi(node);
      const property = staticPropertyName(node.argumentExpression);
      if (property == null) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} computed global access is forbidden because it can hide network or Tauri APIs`,
        );
      } else if (rawNetworkNames.has(property)) {
        rawNetworkApis.add(property);
      } else if (["__TAURI__", "__TAURI_INTERNALS__"].includes(property)) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} computed Tauri global access is forbidden`,
        );
      } else if (["Reflect", "Proxy"].includes(property)) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} runtime reflection is forbidden in production because it can hide network, timer, worker, dynamic execution, or Tauri APIs`,
        );
      } else if (asynchronousEscapeNames.has(property)) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} asynchronous runtime API ${property} is forbidden outside the governed foreground scheduler and timer budget`,
        );
      }
    }
    if (
      ts.isIdentifier(node) &&
      ["Object", "Reflect", "Proxy"].includes(node.text) &&
      !isNonReferenceIdentifier(node) &&
      !isTypeOnly(node)
    ) {
      const isDirectObjectMethodTarget =
        node.text === "Object" &&
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node;
      if (!isDirectObjectMethodTarget) recordReflectionApi(node);
    }
    if (
      ts.isIdentifier(node) &&
      asynchronousEscapeNames.has(node.text) &&
      !isNonReferenceIdentifier(node) &&
      !isTypeOnly(node) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      )
    ) {
      recordAsynchronousEscape(node);
    }
    if (
      ts.isIdentifier(node) &&
      dynamicExecutionNames.has(node.text) &&
      !isNonReferenceIdentifier(node) &&
      !isTypeOnly(node)
    ) {
      recordDynamicExecutionApi(node);
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "structuredClone" &&
      !isNonReferenceIdentifier(node) &&
      !isTypeOnly(node)
    ) {
      recordUnsupportedWebkitApi(node);
    }
    if (
      ts.isIdentifier(node) &&
      ["open", "submit", "requestSubmit"].includes(node.text) &&
      !isNonReferenceIdentifier(node) &&
      !isTypeOnly(node) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      )
    ) {
      runtimeBoundaryViolations.add(
        node.text === "open"
          ? `${path}:${line(node)} raw browser navigation is forbidden outside the exact openGithub adapter call`
          : `${path}:${line(node)} programmatic form submission is forbidden; use a synchronous React onSubmit boundary`,
      );
    }
    if (ts.isBindingElement(node)) {
      const bindingName = node.propertyName
        ? ts.isComputedPropertyName(node.propertyName)
          ? sourceStaticPropertyName(node.propertyName.expression)
          : declaredPropertyName(node.propertyName)
        : ts.isIdentifier(node.name)
          ? node.name.text
          : undefined;
      if (["style", "attributes", "submit", "requestSubmit"].includes(bindingName)) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} DOM mutation handles and form submission may not be destructured or aliased`,
        );
      }
      if (DOCUMENT_POLICY_METHODS.has(bindingName)) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} document-policy method ${bindingName} may not be destructured or aliased`,
        );
      }
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      isWriteTarget(node.parent)
    ) {
      const assignmentName = ts.isComputedPropertyName(node.name)
        ? sourceStaticPropertyName(node.name.expression)
        : declaredPropertyName(node.name);
      if (assignmentName === undefined || ["style", "attributes"].includes(assignmentName) || DOCUMENT_POLICY_METHODS.has(assignmentName)) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} document-policy methods may not be recovered through destructuring assignment`,
        );
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      recordJsxSurface(node);
    }
    if (
      ts.isIdentifier(node) &&
      globalNames.has(node.text) &&
      !isNonReferenceIdentifier(node) &&
      !isTypeOnly(node) &&
      !isTypeofOperand(node)
    ) {
      const isPropertyTarget =
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node;
      if (!isPropertyTarget) {
        runtimeBoundaryViolations.add(
          `${path}:${line(node)} ${node.text} may not be aliased, destructured, or passed as a value`,
        );
      }
    }
    if (
      ts.isIdentifier(node) &&
      ["contentDocument", "contentWindow", "defaultView"].includes(node.text) &&
      !isTypeOnly(node)
    ) {
      runtimeBoundaryViolations.add(
        `${path}:${line(node)} runtime reflection is forbidden in production because it can hide network, timer, worker, dynamic execution, or Tauri APIs`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (path === "src/externalNavigation.ts" && hardenedBrowserOpenCalls !== 1) {
    runtimeBoundaryViolations.add(
      `${path} must contain exactly one raw browser navigation call with the reviewed target and isolation flags`,
    );
  }

  const errors = [
    "fetch",
    "XMLHttpRequest",
    "EventSource",
    "WebSocket",
    "sendBeacon",
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "WebTransport",
  ]
    .filter((api) => rawNetworkApis.has(api))
    .map(
      (api) =>
        `${path} uses raw frontend network API ${api}; route network access through AppService and Rust adapters`,
    );
  if (importsTauriCoreOutsideApi) {
    errors.push(`${path} imports @tauri-apps/api/core outside the governed src/api.ts wrapper`);
  }
  if (invokesTauriGlobal) {
    errors.push(`${path} invokes the raw Tauri global outside the governed src/api.ts wrapper`);
  }
  errors.push(...runtimeBoundaryViolations);
  errors.push(...dynamicExecutionViolations);
  errors.push(...webkitCompatibilityViolations);
  return errors;
}

export function findForbiddenCoveragePragmas(path, contents) {
  const sourceFile = parseTypeScript(path, contents);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    /\.(?:tsx|jsx)$/.test(path) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    contents,
  );
  const errors = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      ![
        ts.SyntaxKind.SingleLineCommentTrivia,
        ts.SyntaxKind.MultiLineCommentTrivia,
      ].includes(token)
    ) {
      continue;
    }
    if (!/\b(?:v8|c8|istanbul)\s+ignore\b/i.test(scanner.getTokenText())) continue;
    const line = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1;
    errors.push(
      `${path}:${line} disables frontend coverage instrumentation; v8/c8/istanbul ignore pragmas are forbidden in production`,
    );
  }
  return errors;
}
