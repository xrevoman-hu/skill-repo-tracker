import assert from "node:assert/strict";
import test from "node:test";

import { validateBuiltBundleSnapshot } from "../bundle-policy.mjs";
import { SAFARI_15_OBJECT_HAS_OWN_BANNER } from "../browser-compatibility-contract.mjs";

const budget = { maxTotalBytes: 10_000, maxJavaScriptChunkBytes: 5_000 };

function validBundle() {
  return [
    {
      path: "dist/index.html",
      bytes: 180,
      contents: [
        "<!doctype html>",
        '<html><head><script type="module" crossorigin src="/assets/app.js"></script>',
        '<link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>',
      ].join(""),
    },
    {
      path: "dist/assets/app.js",
      bytes: 100,
      contents: `${SAFARI_15_OBJECT_HAS_OWN_BANNER}\nconsole.log('app')`,
    },
    { path: "dist/assets/app.css", bytes: 100, contents: "body { color: black; }" },
  ];
}

test("production bundle accepts only self-hosted CSP-compatible assets", () => {
  assert.deepEqual(validateBuiltBundleSnapshot(validBundle(), budget), []);
});

test("production bundle rejects source maps and sourceMappingURL references", () => {
  const files = validBundle();
  files.push({ path: "dist/assets/app.js.map", bytes: 20, contents: "{}" });
  files[1].contents += "\n//# sourceMappingURL=app.js.map";
  const errors = validateBuiltBundleSnapshot(files, budget);
  assert.ok(errors.some((error) => /forbidden production source map/.test(error)));
  assert.ok(errors.some((error) => /forbidden sourceMappingURL/.test(error)));
});

test("every JavaScript chunk requires the Safari 15 Object.hasOwn compatibility prelude", () => {
  const files = validBundle();
  files[1].contents = "Object.hasOwn({ safe: true }, 'safe')";
  assert.ok(
    validateBuiltBundleSnapshot(files, budget).some((error) =>
      /missing the reviewed Safari 15 Object\.hasOwn compatibility prelude/.test(error)
    ),
  );
});

test("production bundle rejects inline and remote scripts", () => {
  for (const script of [
    '<script type="module">alert(1)</script>',
    '<script type="module" src="https://example.com/app.js"></script>',
  ]) {
    const files = validBundle();
    files[0].contents = `<!doctype html><html><head>${script}<link rel="stylesheet" href="/assets/app.css"></head></html>`;
    assert.ok(
      validateBuiltBundleSnapshot(files, budget).some((error) =>
        /inline, remote, or non-module script/.test(error)
      ),
    );
  }
});

test("production bundle rejects missing, remote, and ungoverned assets", () => {
  const files = validBundle();
  files[0].contents = files[0].contents.replace("/assets/app.css", "https://example.com/app.css");
  files.push({ path: "dist/payload.wasm", bytes: 20, contents: "payload" });
  const errors = validateBuiltBundleSnapshot(files, budget);
  assert.ok(errors.some((error) => /unsupported or remote link asset/.test(error)));
  assert.ok(errors.some((error) => /outside the governed/.test(error)));

  const missing = validBundle().filter((file) => !file.path.endsWith("app.js"));
  assert.ok(
    validateBuiltBundleSnapshot(missing, budget).some((error) =>
      /references missing script asset/.test(error)
    ),
  );
});

test("production HTML rejects meta refresh and inline event handlers", () => {
  const files = validBundle();
  files[0].contents = files[0].contents.replace(
    "<head>",
    '<head><meta http-equiv="refresh" content="0;url=https://evil.example/"><div onclick="evil()">',
  );
  const errors = validateBuiltBundleSnapshot(files, budget);
  assert.ok(errors.some((error) => /forbidden meta refresh navigation/.test(error)));
  assert.ok(errors.some((error) => /forbidden inline event handler/.test(error)));
});

test("production artifacts reject alternate code, style, CSP, and resource loaders", () => {
  const files = validBundle();
  files[0].contents = files[0].contents.replace(
    "<head>",
    [
      '<head><meta http-equiv="Content-Security-Policy" content="default-src *">',
      '<img srcset="https://evil.example/a.png 1x">',
      '<video poster="https://evil.example/poster.png"></video>',
      '<style>@import "https://evil.example/inline.css"</style>',
    ].join(""),
  );
  files[1].contents += '\nimport/* retained comment */("https://evil.example/payload.js")';
  files[2].contents += String.raw`\n@\69 mport "https://evil.example/payload.css";\na{background:u\72l(h\74 tps://evil.example/a.png)}`;
  const errors = validateBuiltBundleSnapshot(files, budget);
  assert.ok(errors.some((error) => /cannot override the Tauri Content-Security-Policy/.test(error)));
  assert.ok(errors.some((error) => /unreviewed navigation or resource-loading attribute/.test(error)));
  assert.ok(errors.some((error) => /forbidden inline CSS/.test(error)));
  assert.ok(errors.some((error) => /unreviewed module-loading surface/.test(error)));
  assert.ok(errors.some((error) => /forbidden CSS @import surface/.test(error)));
  assert.ok(errors.some((error) => /forbidden remote CSS URL/.test(error)));

  for (const loader of [
    'import value from "https://evil.example/static.js";',
    'export * from "https://evil.example/reexport.js";',
    'console.log(import.meta.url);',
  ]) {
    const mutated = validBundle();
    mutated[1].contents += `\n${loader}`;
    assert.ok(
      validateBuiltBundleSnapshot(mutated, budget).some((error) =>
        /unreviewed module-loading surface/.test(error)
      ),
      loader,
    );
  }
});

test("production CSS caps progressive syntax and requires Safari 15 fallbacks", () => {
  const files = validBundle();
  files[2].contents = ".table-frame:has(.empty-state){display:grid}";
  assert.ok(
    validateBuiltBundleSnapshot(files, budget).some((error) =>
      /uses :has\(\) without a Safari 15-compatible selector/.test(error)
    ),
  );

  files[2].contents = "button:focus-visible{outline:2px solid blue}";
  assert.ok(
    validateBuiltBundleSnapshot(files, budget).some((error) =>
      /without the reviewed Safari 15 focus fallback/.test(error)
    ),
  );

  files[2].contents = [
    "@supports not selector(:focus-visible){button:focus{outline:2px solid blue!important}}",
    "button:focus-visible{outline:2px solid blue}",
  ].join("");
  assert.equal(
    validateBuiltBundleSnapshot(files, budget).some((error) =>
      /without the reviewed Safari 15 focus fallback/.test(error)
    ),
    false,
  );

  files[2].contents = ".prompt-tag{background:color-mix(in srgb,red,blue)}";
  assert.ok(
    validateBuiltBundleSnapshot(files, budget).some((error) =>
      /missing the Safari 15 fallback/.test(error)
    ),
  );

  const expanded = validBundle();
  expanded[2].contents = [
    ".prompt-tag{background:var(--prompt-accent-soft)}",
    ".prompt-card.is-drag-placeholder{background:var(--prompt-accent-soft)}",
    ".prompt-import-success{background:var(--prompt-accent-soft)}",
    ".prompt-inline-error{background:var(--prompt-surface-raised)}",
    ...Array.from({ length: 5 }, (_, index) =>
      `.new-${index}{color:color-mix(in srgb,red,blue)}`
    ),
  ].join("");
  assert.ok(
    validateBuiltBundleSnapshot(expanded, budget).some((error) =>
      /reviewed maximum is 4/.test(error)
    ),
  );
});
