import { execFileSync } from "node:child_process";
import ts from "typescript";

import {
  parseNulDelimitedGitIndexEntries,
  parseNulDelimitedGitPaths,
} from "./git-paths-core.mjs";

export {
  gitPathExistsAtRef,
  parseNulDelimitedGitIndexEntries,
  parseNulDelimitedGitPaths,
  parseNulDelimitedGitRecords,
} from "./git-paths-core.mjs";

function javaScriptKind(pathname) {
  if (pathname.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (pathname.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:ts|mts|cts)$/.test(pathname)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export function findUnsafeGitPathInventory(pathname, source) {
  const sourceFile = ts.createSourceFile(
    pathname,
    source,
    ts.ScriptTarget.Latest,
    true,
    javaScriptKind(pathname),
  );
  const errors = [];
  const visit = (node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const arguments_ = node.elements
        .filter(ts.isStringLiteralLike)
        .map((element) => element.text);
      const inventory = arguments_.includes("ls-files")
        ? "git ls-files"
        : arguments_.includes("ls-tree") && arguments_.includes("--name-only")
          ? "git ls-tree --name-only"
          : arguments_.includes("diff") && arguments_.includes("--name-status")
            ? "git diff --name-status"
            : undefined;
      if (inventory && !arguments_.includes("-z")) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        errors.push(
          `${pathname}:${line + 1}:${character + 1} ${inventory} path inventory must use -z and a NUL parser`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

function withPathspec(arguments_, pathspecs) {
  return pathspecs.length > 0 ? [...arguments_, "--", ...pathspecs] : arguments_;
}

export function listRepositoryFiles(root, pathspecs = []) {
  return parseNulDelimitedGitPaths(
    execFileSync(
      "git",
      withPathspec(
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        pathspecs,
      ),
      { cwd: root },
    ),
  );
}

export function listUntrackedFiles(root, pathspecs = []) {
  return parseNulDelimitedGitPaths(
    execFileSync(
      "git",
      withPathspec(["ls-files", "-z", "--others", "--exclude-standard"], pathspecs),
      { cwd: root },
    ),
  );
}

export function listTrackedIndexEntries(root) {
  return parseNulDelimitedGitIndexEntries(
    execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root }),
  );
}
