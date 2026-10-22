import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Include every on-disk YAML file, even one Git ignores: an ignored executable
// workflow must not bypass the repository's exact automation allowlist.
export function collectRepositoryWorkflowFiles(root) {
  const files = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name);
      if (entry.isDirectory()) visit(pathname);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(pathname);
    }
  }
  visit(join(root, ".github/workflows"));
  visit(join(root, ".github/actions"));
  return files;
}
