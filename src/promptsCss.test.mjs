/* @vitest-environment node */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const promptsCss = readFileSync("src/prompts.css", "utf8");

function extractBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  const openingBrace = source.indexOf("{", markerIndex);
  if (markerIndex < 0 || openingBrace < 0) throw new Error(`CSS block not found: ${marker}`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      return { body: source.slice(openingBrace + 1, index), end: index, start: markerIndex };
    }
  }
  throw new Error(`Unclosed CSS block: ${marker}`);
}

describe("prompt-library CSS contracts", () => {
  it("gives the media reduced-motion override enough specificity to cancel pointer entry", () => {
    const pointerEntry = promptsCss.indexOf('.prompt-drawer-layer[data-motion="pointer"] .prompt-drawer');
    const reducedMotionMedia = extractBlock(promptsCss, "@media (prefers-reduced-motion: reduce)");

    expect(pointerEntry).toBeGreaterThan(promptsCss.indexOf("@keyframes prompt-drawer-enter"));
    expect(reducedMotionMedia.start).toBeGreaterThan(pointerEntry);
    expect(reducedMotionMedia.body).toMatch(
      /\.prompt-drawer-layer\[data-motion="pointer"\] \.prompt-drawer\s*\{[^}]*animation:\s*none;[^}]*transform:\s*none;/,
    );
    expect(reducedMotionMedia.end).toBeLessThan(promptsCss.length);
  });
});
