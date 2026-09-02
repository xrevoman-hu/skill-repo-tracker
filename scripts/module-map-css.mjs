function escapedCharacter(source, index) {
  const hex = source.slice(index + 1).match(/^[0-9a-f]{1,6}/i)?.[0];
  if (!hex) return { character: source[index + 1] ?? "", next: index + 2 };
  let next = index + 1 + hex.length;
  if (/\s/.test(source[next] ?? "")) next += 1;
  const point = Number.parseInt(hex, 16);
  return {
    character: point === 0 || point > 0x10ffff ? "\uFFFD" : String.fromCodePoint(point),
    next,
  };
}

function identifierAt(source, index) {
  let cursor = index;
  let value = "";
  while (cursor < source.length) {
    if (/[A-Za-z0-9_-]/.test(source[cursor])) value += source[cursor++];
    else if (source[cursor] === "\\") {
      const escaped = escapedCharacter(source, cursor);
      value += escaped.character;
      cursor = escaped.next;
    } else break;
  }
  return { cursor, value: value.toLowerCase() };
}

export function findForbiddenCssImports(pathname, source) {
  for (let index = 0; index < source.length;) {
    if (source.startsWith("/*", index)) {
      const closing = source.indexOf("*/", index + 2);
      index = closing === -1 ? source.length : closing + 2;
      continue;
    }
    if (["\"", "'"].includes(source[index])) {
      const quote = source[index++];
      while (index < source.length) {
        if (source[index] === "\\") index = escapedCharacter(source, index).next;
        else if (source[index++] === quote) break;
      }
      continue;
    }
    const atRule = source[index] === "@";
    if (!atRule && !/[A-Za-z_\\-]/.test(source[index])) {
      index += 1;
      continue;
    }
    const { cursor, value } = identifierAt(source, index + Number(atRule));
    if (atRule && value === "import") {
      return [
        `${pathname} uses CSS @import; import stylesheets from TypeScript so module dependencies remain auditable`,
      ];
    }
    if (!atRule && value === "url" && /^\s*\(/.test(source.slice(cursor))) {
      return [
        `${pathname} uses CSS url(); route assets and external hosts through the audited TypeScript inventory`,
      ];
    }
    index = Math.max(cursor, index + 1);
  }
  return [];
}
