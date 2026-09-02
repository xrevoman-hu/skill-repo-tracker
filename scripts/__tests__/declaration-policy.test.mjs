import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkRepositoryBoundaries,
  validateFrontendDeclarations,
} from "../repository-boundaries.mjs";

const CANONICAL_VITE_DECLARATION = [
  '/// <reference types="vite/client" />',
  "",
  "interface Window {",
  "  __TAURI_INTERNALS__?: unknown;",
  "}",
  "",
].join("\n");

test("only the exact canonical Vite declaration is accepted", () => {
  assert.deepEqual(
    validateFrontendDeclarations({
      "src/vite-env.d.ts": CANONICAL_VITE_DECLARATION,
    }),
    [],
  );

  const missing = validateFrontendDeclarations({});
  assert.ok(missing.includes("required frontend declaration is missing: src/vite-env.d.ts"));

  for (const pathname of [
    "src/escape.d.ts",
    "src/types/escape.d.ts",
    "src/escape.d.mts",
    "src/escape.d.cts",
  ]) {
    assert.ok(
      validateFrontendDeclarations({
        "src/vite-env.d.ts": CANONICAL_VITE_DECLARATION,
        [pathname]: "declare const escape: any;\n",
      }).includes(
        `frontend ambient declaration is forbidden; only src/vite-env.d.ts is allowed: ${pathname}`,
      ),
      pathname,
    );
  }
});

test("the canonical declaration rejects any and additional ambient APIs", () => {
  for (const mutation of [
    CANONICAL_VITE_DECLARATION.replace("unknown", "any"),
    CANONICAL_VITE_DECLARATION.replace('/// <reference types="vite/client" />\n\n', ""),
    `${CANONICAL_VITE_DECLARATION}declare const hiddenEscape: unknown;\n`,
    CANONICAL_VITE_DECLARATION.replace(
      "  __TAURI_INTERNALS__?: unknown;",
      "  __TAURI_INTERNALS__?: unknown;\n  hiddenEscape?: unknown;",
    ),
  ]) {
    assert.deepEqual(
      validateFrontendDeclarations({ "src/vite-env.d.ts": mutation }),
      [
        "src/vite-env.d.ts must contain only the canonical vite/client reference and Window.__TAURI_INTERNALS__?: unknown declaration",
      ],
      mutation,
    );
  }
});

test("repository path boundaries reject declaration files outside the canonical path", () => {
  const errors = checkRepositoryBoundaries({
    trackedFiles: ["src/vite-env.d.ts", "src/types/escape.d.ts"],
    packageJson: { dependencies: {}, devDependencies: {}, scripts: {} },
    lockUrls: [],
  });
  assert.ok(
    errors.includes(
      "frontend ambient declaration is forbidden; only src/vite-env.d.ts is allowed: src/types/escape.d.ts",
    ),
  );
  assert.ok(!errors.some((error) => error.endsWith(": src/vite-env.d.ts")));
});

test("a malicious ambient any makes real strict tsc falsely accept unsafe product code", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "declaration-policy-tsc-"));
  const sourceDirectory = join(root, "src");
  const declarationPath = join(sourceDirectory, "escape.d.ts");
  const tsc = join(process.cwd(), "node_modules/typescript/bin/tsc");
  try {
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["ES2022", "DOM"],
          noEmit: true,
          strict: true,
          target: "ES2022",
        },
        include: ["src"],
      }),
    );
    writeFileSync(
      join(sourceDirectory, "product.ts"),
      "window.hiddenEscape.deeply.unchecked();\n",
    );

    const withoutEscape = spawnSync(process.execPath, [tsc, "--project", root], {
      encoding: "utf8",
    });
    assert.notEqual(withoutEscape.status, 0);
    assert.match(`${withoutEscape.stdout}\n${withoutEscape.stderr}`, /hiddenEscape/);

    const maliciousDeclaration = "interface Window { hiddenEscape: any; }\n";
    writeFileSync(declarationPath, maliciousDeclaration);
    const withEscape = spawnSync(process.execPath, [tsc, "--project", root], {
      encoding: "utf8",
    });
    assert.equal(withEscape.status, 0, `${withEscape.stdout}\n${withEscape.stderr}`);
    assert.ok(
      validateFrontendDeclarations({
        "src/vite-env.d.ts": CANONICAL_VITE_DECLARATION,
        "src/escape.d.ts": maliciousDeclaration,
      }).some((error) => error.includes("src/escape.d.ts")),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
