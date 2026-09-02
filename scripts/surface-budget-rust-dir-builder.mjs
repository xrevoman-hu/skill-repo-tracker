const CONSTRUCTOR_SOURCE = String.raw`std\s*::\s*fs\s*::\s*DirBuilder\s*::\s*new`;

function governedUseStatements(masked) {
  return [...masked.matchAll(/\b(?:pub\s+)?use\b[\s\S]*?;/g)].map(
    (match) => match[0],
  );
}

export function discoverDirBuilderPathSites(relative, masked, ownerAt) {
  const dirBuilderTokens = [...masked.matchAll(/\bDirBuilder\b/g)];
  if (dirBuilderTokens.length === 0) return [];

  for (const statement of governedUseStatements(masked)) {
    const compact = statement.replace(/\s+/g, "");
    if (
      /\bDirBuilder\b/.test(statement) ||
      /^pubuse(?:::)?std::fs;?$/.test(compact) ||
      /^use(?:::)?std::fs(?:as[A-Za-z_][A-Za-z0-9_]*)?;$/.test(compact) ||
      /^use(?:::)?std::\{fs(?:as[A-Za-z_][A-Za-z0-9_]*)?(?:,|\})/.test(compact)
    ) {
      throw new Error(`${relative} DirBuilder imports and filesystem aliases are forbidden`);
    }
  }
  if (/\bextern\s+crate\s+std\s+as\b/.test(masked)) {
    throw new Error(`${relative} DirBuilder must not use an aliased std root`);
  }
  if (/\btype\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^;=]+>)?\s*=\s*[^;]*\bDirBuilder\b/.test(masked)) {
    throw new Error(`${relative} DirBuilder type aliases are forbidden`);
  }
  if (/<[^>]*\bDirBuilder\b[^>]*>\s*::\s*(?:create|new)\b/.test(masked)) {
    throw new Error(`${relative} DirBuilder UFCS and trait calls are forbidden`);
  }

  const references = [...masked.matchAll(new RegExp(`\\b${CONSTRUCTOR_SOURCE}\\b`, "g"))];
  const calls = [
    ...masked.matchAll(new RegExp(`\\b${CONSTRUCTOR_SOURCE}\\s*\\(\\s*\\)`, "g")),
  ];
  if (references.length !== calls.length || dirBuilderTokens.length !== references.length) {
    throw new Error(`${relative} DirBuilder must use the canonical direct constructor`);
  }

  const chainPattern = new RegExp(
    `\\b${CONSTRUCTOR_SOURCE}\\s*\\(\\s*\\)\\s*\\.\\s*recursive\\s*\\(\\s*true\\s*\\)\\s*\\.\\s*create\\s*\\(`,
    "g",
  );
  const bindingPattern = new RegExp(
    `\\blet\\s+mut\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${CONSTRUCTOR_SOURCE}\\s*\\(\\s*\\)\\s*;\\s*\\1\\s*\\.\\s*recursive\\s*\\(\\s*true\\s*\\)\\s*;\\s*\\1\\s*\\.\\s*create\\s*\\(`,
    "g",
  );
  const creates = [
    ...[...masked.matchAll(chainPattern)].map((match) => match.index),
    ...[...masked.matchAll(bindingPattern)].map((match) => match.index),
  ];
  if (creates.length !== calls.length) {
    throw new Error(
      `${relative} DirBuilder values must remain statically bound to recursive(true).create(path)`,
    );
  }

  const counts = new Map();
  return creates.map((position) => {
    const owner = ownerAt(position);
    const ordinal = (counts.get(owner) ?? 0) + 1;
    counts.set(owner, ordinal);
    return `${relative}:std::fs::DirBuilder::create:${owner}#${ordinal}`;
  });
}
