import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type {} from "remark-parse";
import type { Plugin } from "unified";

// Prompt previews only parse Markdown; exports retain the original source text.
// Keep all GFM syntax without registering unused Markdown serialization handlers.
const readGfm: Plugin = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(gfm());
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown());
};

export default readGfm;
