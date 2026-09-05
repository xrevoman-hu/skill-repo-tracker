import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import { createStaticPropertyResolver, isWriteTarget, staticPropertyName } from "./frontend-dom-policy.mjs";

const COMPONENT_PROPS = new Set(["Button", "Detail", "EmptyState", "Section", "Tag"]);
const LUCIDE_COMPONENTS = new Set([
  "BookOpenText", "ChevronLeft", "ChevronRight", "Copy", "Download", "GripVertical",
  "MoreHorizontal", "Pencil", "Pin", "Plus", "Search", "Tag", "Upload", "X",
]);
const PLUGIN_SOURCE_SHA256 = "126137182ee3216699526259fa508043d58fe2867a2af07eefe6b5bdceacbc07";

function isFunctionValue(binding) {
  return Boolean(binding && (
    (ts.isFunctionDeclaration(binding) && binding.body) ||
    (ts.isVariableDeclaration(binding) && binding.initializer &&
      (binding.parent.flags & ts.NodeFlags.Const) !== 0 &&
      (ts.isArrowFunction(binding.initializer) || ts.isFunctionExpression(binding.initializer)))
  ));
}

function writtenBindings(file, resolveDeclaration) {
  const written = new Set();
  const visit = node => {
    if (ts.isIdentifier(node) && isWriteTarget(node)) written.add(resolveDeclaration(node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return written;
}

// Resolve only inventoried inputs. Re-exported, ambiguous, missing, and computed
// component values fail closed; there is no ambient filesystem or name fallback.
export function createJsxBindingPolicy(path, sourceFile, resolveDeclaration, sources) {
  const cache = new Map();
  const localWrites = writtenBindings(sourceFile, resolveDeclaration);
  const pluginPropsReviewed = path === "src/PluginsView.tsx" &&
    createHash("sha256").update(sourceFile.text).digest("hex") === PLUGIN_SOURCE_SHA256;
  const importedFunction = (binding) => {
    let declaration = binding;
    while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
    if (!declaration || declaration.importClause?.isTypeOnly || binding.isTypeOnly) return false;
    const module = declaration.moduleSpecifier.text;
    const exported = ts.isImportClause(binding) ? "default" : (binding.propertyName ?? binding.name)?.text;
    if (module === "react-markdown") return exported === "default";
    if (module === "lucide-react") return LUCIDE_COMPONENTS.has(exported);
    if (!module.startsWith(".")) return false;
    const stem = posix.normalize(posix.join(posix.dirname(path), module));
    const candidates = [stem, `${stem}.tsx`, `${stem}.ts`].filter(candidate => sources.has(candidate));
    if (candidates.length !== 1) return false;
    const target = candidates[0];
    if (!cache.has(target)) {
      const file = ts.createSourceFile(target, sources.get(target), ts.ScriptTarget.Latest, true,
        target.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const resolver = createStaticPropertyResolver(file, staticPropertyName);
      cache.set(target, { file, writes: writtenBindings(file, resolver.declaration) });
    }
    const { file, writes } = cache.get(target);
    const matches = [];
    for (const statement of file.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
      if (!modifiers.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const isDefault = modifiers.some(item => item.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isFunctionDeclaration(statement) &&
        (isDefault ? exported === "default" : statement.name?.text === exported)) matches.push(statement);
      if (ts.isVariableStatement(statement) && !isDefault) {
        matches.push(...statement.declarationList.declarations.filter(item => item.name.getText(file) === exported));
      }
    }
    return matches.length === 1 && isFunctionValue(matches[0]) && !writes.has(matches[0]);
  };
  const callable = (binding) => !localWrites.has(binding) && (isFunctionValue(binding) || Boolean(binding &&
    (ts.isImportSpecifier(binding) || ts.isImportClause(binding)) && importedFunction(binding)));
  return {
    reviewedParameter(binding, name) {
      return pluginPropsReviewed && COMPONENT_PROPS.has(name) && Boolean(binding &&
        (ts.isBindingElement(binding) || ts.isParameter(binding)));
    },
    violation(opening) {
      const binding = resolveDeclaration(opening.tagName);
      if (binding && (ts.isImportSpecifier(binding) || ts.isImportClause(binding) ||
        ts.isFunctionDeclaration(binding)) && !callable(binding)) {
        return "imported JSX tag is not a reviewed function component";
      }
      for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || !COMPONENT_PROPS.has(attribute.name.getText(sourceFile))) continue;
        const expression = attribute.initializer && ts.isJsxExpression(attribute.initializer)
          ? attribute.initializer.expression : undefined;
        if (!expression || !callable(resolveDeclaration(expression))) return "JSX component prop must bind a reviewed function";
      }
      return undefined;
    },
  };
}
