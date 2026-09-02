export const validMap = () => ({
  schemaVersion: 1,
  sourceRoots: [
    {
      path: "src",
      runtime: "frontend",
      extensions: [".ts", ".tsx", ".mts", ".cts", ".css"],
    },
    { path: "src-tauri/src", runtime: "rust", extensions: [".rs"] },
  ],
  layers: [
    { id: "frontend-shell", runtime: "frontend", forbiddenDependencies: [] },
    {
      id: "frontend-view",
      runtime: "frontend",
      forbiddenDependencies: ["frontend-shell"],
    },
    { id: "rust-composition", runtime: "rust", forbiddenDependencies: [] },
    {
      id: "rust-domain",
      runtime: "rust",
      forbiddenDependencies: ["rust-composition"],
    },
  ],
  modules: [
    {
      id: "app-shell",
      runtime: "frontend",
      layer: "frontend-shell",
      ownerRule: "docs/rules/testing-release.md",
      decisions: ["docs/adr/0007-staged-modularization.md"],
      paths: ["src/App.tsx"],
    },
    {
      id: "github-view",
      runtime: "frontend",
      layer: "frontend-view",
      ownerRule: "docs/rules/permissions.md",
      decisions: [],
      paths: ["src/GitHubWorkbench.tsx"],
    },
    {
      id: "rust-root",
      runtime: "rust",
      layer: "rust-composition",
      ownerRule: "docs/rules/testing-release.md",
      decisions: ["docs/adr/0007-staged-modularization.md"],
      paths: ["src-tauri/src/lib.rs"],
    },
    {
      id: "rust-prompts",
      runtime: "rust",
      layer: "rust-domain",
      ownerRule: "docs/rules/prompts.md",
      decisions: ["docs/adr/0005-prompt-export-and-migration.md"],
      paths: ["src-tauri/src/prompts.rs"],
    },
  ],
});

export const trackedFiles = [
  "docs/rules/testing-release.md",
  "docs/rules/permissions.md",
  "docs/rules/prompts.md",
  "docs/adr/0005-prompt-export-and-migration.md",
  "docs/adr/0007-staged-modularization.md",
  "src/App.tsx",
  "src/GitHubWorkbench.tsx",
  "src-tauri/src/lib.rs",
  "src-tauri/src/prompts.rs",
];
