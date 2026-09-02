function commandSegments(command) {
  const segments = [];
  let current = "";
  let quote;
  let escaped = false;
  let comment = false;
  const flush = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };
  const source = String(command ?? "").replace(/\r\n?/g, "\n");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
        flush();
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      if (!quote) return undefined;
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      current += character;
    } else if (character === "#") {
      comment = true;
    } else if (character === "\n") {
      flush();
    } else if (character === "&" && source[index + 1] === "&") {
      flush();
      index += 1;
    } else if ([";", "|", "<", ">", "&"].includes(character)) {
      return undefined;
    } else {
      current += character;
    }
  }
  if (quote || escaped) return undefined;
  flush();
  return segments;
}

function commandTokens(segment) {
  const tokens = [];
  let current = "";
  let quote;
  let escaped = false;
  const flush = () => {
    if (current !== "") tokens.push(current);
    current = "";
  };
  for (const character of segment) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      flush();
    } else if (["`", "$", "(", ")", "{", "}"].includes(character)) {
      return undefined;
    } else {
      current += character;
    }
  }
  if (quote || escaped) return undefined;
  flush();
  return tokens;
}

export function canonicalCommandInvocations(command) {
  const segments = commandSegments(command);
  if (!segments) return [];
  const invocations = [];
  const forbiddenPrograms = new Set([
    ".", "break", "builtin", "case", "cd", "command", "continue", "do", "done", "elif",
    "else", "esac", "eval", "exec", "exit", "export", "false", "fi", "for", "function",
    "if", "logout", "popd", "pushd", "return", "source", "then", "trap", "until", "while",
  ]);
  for (const segment of segments) {
    const tokens = commandTokens(segment);
    if (
      !tokens ||
      tokens.length === 0 ||
      forbiddenPrograms.has(tokens[0]) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) ||
      (tokens[0] === "set" && tokens.join(" ") !== "set -euo pipefail")
    ) {
      return [];
    }
    invocations.push(tokens);
  }
  return invocations;
}
