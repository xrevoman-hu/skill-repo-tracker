import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { findForbiddenFrontendRuntimeUsage } from "../frontend-runtime-policy.mjs";

function assertBlocked(source, pattern, path = "src/NetworkEscape.tsx") {
  const errors = findForbiddenFrontendRuntimeUsage(path, source);
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `${source}\nexpected ${pattern}, received:\n${errors.join("\n")}`,
  );
}

test("peer and transport channels cannot bypass AppService", () => {
  const mutations = [
    "new RTCPeerConnection()",
    "new webkitRTCPeerConnection()",
    'new globalThis["RTC" + "PeerConnection"]()',
    'new self["webkitRTCPeerConnection"]()',
    'new window.WebTransport("https://github.com")',
    "const Peer = window.RTCPeerConnection; new Peer()",
    "const { WebTransport: Transport } = globalThis; new Transport(url)",
    "Reflect.construct(globalThis.RTCPeerConnection, [])",
    "new (Window.prototype.RTCPeerConnection)()",
  ];
  for (const source of mutations) {
    assertBlocked(source, /raw frontend network API|runtime reflection|may not be aliased/);
  }
});

test("production runtime remains compatible with the Safari 15.0 product floor", () => {
  for (const source of [
    "const last = values.at(-1)",
    "const last = values['a' + 't'](-1)",
    "const { at: take } = values; take.call(values, -1)",
    "const { ['a' + 't']: take } = values; take.call(values, -1)",
    "const key = readKey(); const { [key]: take } = values; take.call(values, -1)",
    "{ const key = 'at'; const { [key]: take } = values } { const key = 'map'; const { [key]: map } = values }",
    "({ at: take } = values); take.call(values, -1)",
    "const key = 'at'; values[key](-1)",
    "{ const key = 'at'; values[key](-1) } { const key = 'map'; values[key](fn) }",
    "const key = 'map'; function pick(key) { return values[key](-1) }",
    "const copy = structuredClone(value)",
    "const { structuredClone: copy } = globalThis; copy(value)",
    "const copy = globalThis.structuredClone(value)",
    "const key = 'structuredClone'; globalThis[key](value)",
  ]) {
    assertBlocked(source, /unavailable before Safari 15\.4/);
  }
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/Compatibility.ts",
      "const last = values[values.length - 1]; const copy = { ...value }",
    ),
    [],
  );
});

test("runtime DOM cannot create navigation or document-policy escape surfaces", () => {
  const mutations = [
    'document.createElement("meta")',
    'const tag = "meta"; document.createElement(tag)',
    'React.createElement("style")',
    'meta.httpEquiv = "refresh"',
    'meta["http" + "Equiv"] = "content-security-policy"',
    'const attr = "http-equiv"; meta.setAttribute(attr, "refresh")',
    'Object.assign(meta, { httpEquiv: "refresh" })',
    'const src = remote; Object.assign(image, { src })',
    'const key = "src"; Object.assign(image, { [key]: remote })',
    '{ const key = "src"; Object.assign(image, { [key]: remote }) } { const key = "safe"; Object.assign(image, { [key]: value }) }',
    'Object.assign(image, props)',
    'Object.assign(image, { safe: true }, { src: remote })',
    'Object.assign(image, { ...props })',
    'Object.assign(node, { style: { backgroundImage: remote } })',
    'globalThis.Object.assign(node, { style: { backgroundImage: remote } })',
    'window["Object"]["assign"](image, { src: remote })',
    'const attribute = readName(); meta.setAttribute(attribute, "refresh")',
    'const tag = readTag(); document.createElement(tag)',
    '{ const tag = "meta"; document.createElement(tag) } { const tag = "div"; document.createElement(tag) }',
    'image.src = "https://evil.example/pixel.png"',
    'const key = "src"; image[key] = "https://evil.example/pixel.png"',
    'const key = readName(); image[key] = "https://evil.example/pixel.png"',
    '{ const key = "src"; image[key] = remote } { const key = "safe"; image[key] = value }',
    'image.setAttribute("srcset", "https://evil.example/pixel.png 1x")',
    'node.setAttribute("style", "background-image:url(https://evil.example/pixel.png)")',
    'node.setAttribute("STYLE", "background-image:url(https://evil.example/pixel.png)")',
    'node.setAttribute("Style", css)',
    'const attributeName = "St" + "Yle"; node["set" + "Attribute"](attributeName, css)',
    'node.setAttribute("class", "unreviewed-runtime-class")',
    'const set = image.setAttribute; set("src", remote)',
    'const create = document.createElement; create("img")',
    'const { setAttribute: set } = image; set("src", remote)',
    'const { createElement: create } = document; create("img")',
    'let set; ({ setAttribute: set } = image); set("src", remote)',
    'let create; ({ createElement: create } = document); create("img")',
    'let target; ({ value: target.src } = source)',
    'image.setAttributeNS(null, "src", remote)',
    'node.setAttributeNode(document.createAttribute("style"))',
    'node.getAttributeNode("style").value = css',
    'node.attributes.getNamedItem("style").value = css',
    'document.createElementNS("http://www.w3.org/2000/svg", "style")',
    'root.innerHTML = `<img src="${remote}">`',
    'root.outerHTML = html',
    'frame.srcdoc = html',
    'frame.srcDoc = html',
    'root.insertAdjacentHTML("beforeend", html)',
    'document.write(html)',
    'const write = document.write; write(html)',
    'range.createContextualFragment(html)',
    'node.style.backgroundImage = `url(${remote})`',
    'node.style.WebkitBoxReflect = `below url(${remote})`',
    'node.style.cssText = css',
    'node.style.setProperty("background-image", remote)',
    'const set = node.style.setProperty; set("background-image", remote)',
    'const { setProperty: set } = node.style; set("background-image", remote)',
    'let set; ({ setProperty: set } = node.style); set("background-image", remote)',
    'const target = node.style; target.backgroundImage = remote',
    'const target = node["style"]; target.cssText = css',
    'const { style: target } = node; target.backgroundImage = remote',
    'let target; ({ style: target } = node); target.backgroundImage = remote',
    'function mutate(target) { target.backgroundImage = remote } mutate(node.style)',
    'const holder = { target: node.style }; holder.target.cssText = css',
    '[node.style][0].cssText = css',
    'const target = node.style; Object.assign(target, { backgroundImage: remote })',
    'Object.assign(node.style, { backgroundImage: remote })',
    'new CSSStyleSheet()',
    'new DOMParser()',
    'document.adoptedStyleSheets = [sheet]',
    'document.styleSheets[0].insertRule(css)',
    'node.attributeStyleMap.set("background-image", remote)',
    'styleElement.sheet.replace(css)',
    'sheet.insertRule(css)',
    'sheet.replaceSync(css)',
    'node.append(css)',
    'node.textContent = css',
    '<meta httpEquiv="refresh" content="0;url=https://evil.example/" />',
    '<style>{dangerousCss}</style>',
    '<img src={remoteUrl} />',
    '<video poster="https://evil.example/poster.png" />',
    '<svg><use href={remoteUrl} /></svg>',
    '<svg><use xlink:href={remoteUrl} /></svg>',
    '<svg><path fill="url(https://evil.example/paint.svg#gradient)" /></svg>',
    '<svg><path stroke={remotePaint} /></svg>',
    '<div style={{ backgroundImage: `url(${remoteUrl})` }} />',
    '<div style={{ WebkitMaskImage: `url(${remoteUrl})` }} />',
    '<svg style={{ fill: `url(${remoteUrl})` }} />',
    '<div style={sharedStyle} />',
    '<div {...props} />',
    '<div {...{ src: remoteUrl }} />',
    'const Tag = "style"; <Tag>{css}</Tag>',
    'const Tag = "meta"; <Tag httpEquiv="refresh" content="0;url=https://evil.example" />',
    'const Tag = readTag(); <Tag />',
    'function Dynamic({ Tag }) { return <Tag /> }',
    'const Widgets = { Tag: "style" }; <Widgets.Tag>{css}</Widgets.Tag>',
    'const Elements = { Safe: Component }; <Elements.Safe {...props} />',
    'const React = { StrictMode: "style" }; <React.StrictMode>{css}</React.StrictMode>',
    'import React from "fake-react"; <React.StrictMode>{css}</React.StrictMode>',
    'import type React from "react"; <React.StrictMode>{css}</React.StrictMode>',
    'import * as React from "react"; <React.StrictMode>{css}</React.StrictMode>',
    '<React.StrictMode data-policy="mutable"><App /></React.StrictMode>',
    'React.createElement("div", { dangerouslySetInnerHTML: { __html: html } })',
    'React.createElement("div", { style: { backgroundImage: remote } })',
    'React.createElement("svg", null, React.createElement("use", { href: remote }))',
    'React.cloneElement(node, { dangerouslySetInnerHTML: { __html: html } })',
    'const assign = Object.assign; assign(image, props)',
    'const { assign } = Object; assign(image, props)',
    'import { createElement as make } from "react"; make("div", { src: remote })',
  ];
  for (const source of mutations) {
    assertBlocked(source, /document-policy|resource loading|runtime reflection|raw HTML|raw DOM|DOM (?:mutation|style)|dynamic JSX|dynamic execution/);
  }
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/InlineLayout.tsx",
      '<><div style={{ maxHeight: `${height}px` }} /><span style={flag ? undefined : { width: "42%" }} /></>',
    ),
    [],
  );
  assertBlocked('<PreferencesPanel {...props} />', /resource loading/, "src/App.tsx");
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/main.tsx",
      'import React from "react"; <React.StrictMode><App /></React.StrictMode>',
    ),
    [],
  );
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/InlineLayout.tsx",
      'card.setAttribute("data-drop-flip", "true"); card.setAttribute("aria-label", label); card.style.transform = "none"; card.style.getPropertyValue("--prompt-drag-x"); card.style.setProperty("--prompt-drag-x", "0px"); Object.assign(card.style, { transform: "none" }); Object.assign(error, { code: "safe" })',
    ),
    [],
  );
  assertBlocked('<Button {...props} />', /resource loading/);
});

test("the reviewed React.StrictMode root cannot be replaced before JSX evaluation", () => {
  for (const source of [
    'import React from "react"; React.StrictMode = "style"; <React.StrictMode>{css}</React.StrictMode>',
    'import React from "react"; Object.assign(React, { StrictMode: "style" }); <React.StrictMode>{css}</React.StrictMode>',
  ]) {
    assertBlocked(source, /document-policy/, "src/main.tsx");
  }
});

const reviewedPromptIconSource = `
import { ChevronLeft, ChevronRight, Copy, Download, GripVertical, MoreHorizontal, Pencil, Pin, Plus, Search, Tag, Upload, X } from "lucide-react";
const iconComponents = {
  search: Search, pin: Pin, copy: Copy, close: X, edit: Pencil, download: Download,
  drag: GripVertical, more: MoreHorizontal, tag: Tag, upload: Upload, plus: Plus,
  previous: ChevronLeft, next: ChevronRight,
};
function Icon({ name }: { name: keyof typeof iconComponents }) {
  const Component = iconComponents[name];
  return <Component aria-hidden="true" />;
}`;

test("the reviewed Prompt icon component map has an exact immutable source shape", () => {
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage("src/PromptsView.tsx", reviewedPromptIconSource),
    [],
  );
  for (const source of [
    'const iconComponents = { evil: "style" }; const Component = iconComponents[key]; <Component>{css}</Component>',
    'function Icon(iconComponents) { const Component = iconComponents[key]; return <Component /> }',
    reviewedPromptIconSource.replace('"lucide-react"', '"fake-icons"'),
    reviewedPromptIconSource.replace("const Component", "console.log(iconComponents); const Component"),
    reviewedPromptIconSource.replace("const Component", 'iconComponents.search = "style"; const Component'),
  ]) {
    assertBlocked(source, /dynamic JSX/, "src/PromptsView.tsx");
  }
});

test("DOM event views cannot recover Window and bypass the Tauri adapter", () => {
  const mutations = [
    [
      "function escape(event: UIEvent) {",
      "  const root = event.view;",
      '  const tauri = "__TAURI_INTERNALS__";',
      "  root?.[tauri]?.invoke('open_backup_folder', { repositoryId: '1' });",
      "}",
    ].join("\n"),
    'event["vi" + "ew"]?.__TAURI_INTERNALS__?.invoke("command");',
    'new MouseEvent("click").view?.[runtimeKey]?.invoke("command");',
  ];
  for (const source of mutations) {
    assertBlocked(source, /DOM view\/Window recovery is forbidden/);
  }
});

test("location navigation cannot be recovered through globals or prototypes", () => {
  const mutations = [
    "window.location.assign(url)",
    'globalThis["location"]["replace"](url)',
    "self.location.href = url",
    'window["location"] = url',
    "location.href = url",
    "const redirect = window.location; redirect.assign(url)",
    "const { location: redirect } = globalThis; redirect.replace(url)",
    'Reflect.set(window.location, "href", url)',
    "Location.prototype.assign.call(location, url)",
  ];
  for (const source of mutations) {
    assertBlocked(source, /navigation|runtime reflection|may not be aliased/);
  }
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/App.tsx",
      'new URLSearchParams(window.location.search).get("demo")',
    ),
    [],
  );
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage("src/App.tsx", "window.location.search.slice(1)"),
    [],
  );
});

test("programmatic and URL-bearing form surfaces fail closed", () => {
  const mutations = [
    "form.submit()",
    'form["request" + "Submit"]()',
    "form.action = url",
    'form["target"] = "_blank"',
    'form.setAttribute("action", url)',
    "const fire = form.requestSubmit; fire()",
    "form.submit.bind(form)()",
    "document.forms[0].submit.call(document.forms[0])",
    "const { submit: fire } = form; fire()",
    "Object.assign(form, { action: url })",
    "Reflect.apply(HTMLFormElement.prototype.submit, form, [])",
    '<form action={url} onSubmit={save}>content</form>',
    '<button formTarget="_blank" type="submit">save</button>',
  ];
  for (const source of mutations) {
    assertBlocked(source, /form navigation|form submission|runtime reflection/);
  }
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/PromptsView.tsx",
      '<form onSubmit={save}><button type="submit">save</button></form>',
    ),
    [],
  );
});

test("raw browser opening is unique to the exact hardened helper call", () => {
  const mutations = [
    'window.open(url, "_blank")',
    'globalThis["op" + "en"](url)',
    'self.open(url, "_blank", "noopener")',
    "const launch = window.open; launch(url)",
    "const { open: launch } = globalThis; launch(url)",
    'Reflect.apply(window.open, window, [url, "_blank"])',
    "Window.prototype.open.call(window, url)",
  ];
  for (const source of mutations) {
    assertBlocked(source, /raw browser navigation|runtime reflection|may not be aliased/);
  }

  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/externalNavigation.ts",
      [
        "export function openGithub(value: string) {",
        "  const parsed = new URL(value);",
        '  window.open(parsed.toString(), "_blank", "noopener,noreferrer");',
        "}",
      ].join("\n"),
    ),
    [],
  );
  assertBlocked(
    [
      "export function openGithub(value: string) {",
      "  const parsed = new URL(value);",
      '  window.open(parsed.toString(), "_blank", "noopener,noreferrer");',
      '  window.open(parsed.toString(), "_blank", "noopener,noreferrer");',
      "}",
    ].join("\n"),
    /exactly one raw browser navigation call/,
    "src/externalNavigation.ts",
  );
  assertBlocked(
    'window.open(parsed.toString(), "_blank", "noopener")',
    /raw browser navigation/,
    "src/externalNavigation.ts",
  );
});

test("document policy rejects arbitrary receivers, resource constructors, and React factory recovery", () => {
  for (const source of [
    'this.innerHTML = html', 'this.src = url', 'this.setAttribute("src", url)',
    '(this.src as string) = url', '(this.src!) = url',
    '(this.src satisfies string) = url', 'for (this.src of urls) {}',
    'for ((this.src as string) in urls) {}', '++(this.src as number)',
    'this.style.backgroundImage = url', 'super.setAttribute("src", url)',
    'class Element extends HTMLElement { connectedCallback() { this.innerHTML = html; } }',
    '(flag ? first : second).src = url',
    'new Audio(remoteUrl)', 'new Image()', 'new FontFace("remote", remoteUrl)',
    'const Sound = window.Audio; new Sound(url)',
    'const key = "Audio"; const Sound = window[key]; new Sound(url)',
    'React.createFactory("img")', 'import { createFactory as make } from "react"; make("img")',
    'const make = React.createFactory; make("img")',
    'import { jsx as make } from "react/jsx-runtime"; make("img", props)',
    'import * as runtime from "react/jsx-runtime"; runtime.jsxs("img", props)',
    'import("react/jsx-dev-runtime")', 'require("react/jsx-runtime")',
  ]) assertBlocked(source, /document-policy|resource|dynamic execution|DOM style/);
});

test("Settings component names never exempt JSX spread or intrinsic forwarding", () => {
  for (const source of [
    'function PreferencesPanel(props) { return <div {...props} />; }',
    'function SettingsView(PreferencesPanel) { return <PreferencesPanel {...props} />; }',
    'import { Untrusted as PreferencesModal } from "./other"; <PreferencesModal {...props} />',
    'function SettingsView(props) { return <input {...props.preferences} />; }',
  ]) assertBlocked(source, /resource loading/, "src/App.tsx");
});

test("Settings spread binds the exact reviewed implementations and typed contracts", () => {
  const source = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const sources = new Map(["GitHubWorkbench", "PluginsView", "PromptsView"].map(name =>
    [`src/${name}.tsx`, readFileSync(new URL(`../../src/${name}.tsx`, import.meta.url), "utf8")]));
  assert.deepEqual(findForbiddenFrontendRuntimeUsage("src/App.tsx", source, sources), []);
  for (const mutated of [
    source + '\nfunction Shadow(PreferencesPanel) { return <PreferencesPanel {...props} />; }',
    source + '\nfunction Shadow() { function SettingsView(props) { return null; } return <SettingsView {...props} />; }',
    source.replace('function SettingsView(props: PreferencesProps)', 'function SettingsView(props: OtherProps)'),
    source.replace('type PreferencesProps = {', 'type PreferencesProps = { src?: string;'),
    source.replace('function SettingsView(props: PreferencesProps) {', 'function SettingsView(props: PreferencesProps) { return <input {...props} />;'),
    source.replace('function SettingsView(props: PreferencesProps) {', 'function SettingsView(props: PreferencesProps) { return <Input {...props} />;'),
  ]) assertBlocked(mutated, /resource loading/, "src/App.tsx");
});

test("imported JSX resolves inventoried function exports and rejects intrinsic aliases", () => {
  const consumer = 'import { Sheet } from "./sheet"; export function Render() { return <Sheet />; }';
  for (const producer of [
    'export const Sheet = "style";',
    'export const Sheet = getTag();',
    'export function Sheet() { return null; } Sheet = ("style" as unknown as typeof Sheet);',
    'export function Sheet() { return null; } (Sheet as unknown as string) = "iframe";',
    'export function Sheet() { return null; } (Sheet!) = "iframe";',
    'export function Sheet() { return null; } for (Sheet of tags) {}',
    'export function Sheet() { return null; } for ((Sheet as unknown as string) in tags) {}',
    'export { Sheet } from "./cycle";',
    'export * from "./other";',
  ]) {
    const sources = new Map([["src/sheet.tsx", producer]]);
    assert.ok(findForbiddenFrontendRuntimeUsage("src/consumer.tsx", consumer, sources).some(error => /imported JSX tag/.test(error)));
  }
  assert.deepEqual(findForbiddenFrontendRuntimeUsage("src/consumer.tsx", consumer,
    new Map([["src/sheet.tsx", 'export function Sheet() { return <div />; }']])), []);
  assert.deepEqual(findForbiddenFrontendRuntimeUsage("src/consumer.tsx", consumer,
    new Map([["src/sheet.tsx", 'export const Sheet = () => <div />;']])), []);
  assertBlocked('import { Missing } from "./missing"; <Missing />', /imported JSX tag/);
  assertBlocked('function Sheet() { return null; } Sheet = ("style" as unknown as typeof Sheet); <Sheet />', /imported JSX tag/);
  assertBlocked('export function Rogue({Button}: {Button: "style"}) { return <Button />; }', /dynamic JSX/, "src/PluginsView.tsx");
  assertBlocked('function Holder() { return <PluginsView Tag="style" />; }', /component prop/);
  assertBlocked('function Holder() { const Tag="style"; return <PluginsView Tag={Tag} />; }', /component prop/);
});

test("CSS handles cannot escape through valueOf or receiver-independent setters", () => {
  for (const source of [
    'const css = el.style.valueOf(); css.setProperty("background-image", "url(/payload)")',
    'const css = el.style.valueOf(); css.cssText = "background:url(/payload)"',
    'function update(css: CSSStyleDeclaration) { css.setProperty("background", url); }',
    'function update(css: CSSStyleDeclaration) { css.backgroundImage = url; }',
    'function update(css: CSSStyleDeclaration) { css.cursor = url; }',
  ]) assertBlocked(source, /DOM style|document-policy/);
});

test("SVG resource and SMIL surfaces cannot bypass URL policy through animated values", () => {
  for (const source of [
    '<svg><image ref={node => { if (node) node.href.baseVal = url; }} /></svg>',
    '<svg><use><set attributeName="href" to={url} /></use></svg>',
    '<svg><feImage><animate attributeName="href" values={url} /></feImage></svg>',
    '<svg><foreignObject /><animateMotion /><animateTransform /><mpath /></svg>',
    'function load(node: SVGImageElement) { node.href.baseVal = url; }',
    'function load(node: SVGUseElement) { const href = node.href; href.baseVal = url; }',
    'function load(node: SVGFEImageElement) { Object.assign(node.href, { baseVal: url }); }',
    'const animated = node.href; const value = animated.baseVal;',
    'const { baseVal } = node.href; const value = node.href.animVal;',
  ]) assertBlocked(source, /resource|raw DOM|document-policy/);
});

test("SVG presentation URL attributes reject CSS escapes in strings and JSX literals", () => {
  for (const attribute of ["clipPath", "fill", "filter", "markerEnd", "markerMid", "markerStart", "mask", "stroke"]) {
    assertBlocked(`<svg><path ${attribute}="u&#114;l(/local.svg#x)" /></svg>`, /resource loading/);
    for (const value of [String.raw`u\72l(https://example.com/resource.svg#x)`, String.raw`\75rl(/local.svg#x)`]) {
      assertBlocked(`<svg><path ${attribute}=${JSON.stringify(value)} /></svg>`, /resource loading/);
      assertBlocked(`<svg><path ${attribute}={${JSON.stringify(value)}} /></svg>`, /resource loading/);
    }
  }
});

test("only the two reviewed JSX anchor shapes are accepted", () => {
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/App.tsx",
      '<strong>{link ? <a href="#source">{value}</a> : value}</strong>',
    ),
    [],
  );
  assert.deepEqual(
    findForbiddenFrontendRuntimeUsage(
      "src/PromptsView.tsx",
      [
        "safeExternalUrl(href || '') ? (",
        "  <a href={href} onClick={(event) => { event.preventDefault(); void openExternal?.(href || ''); }} rel=\"noreferrer\">{children}</a>",
        ") : null",
      ].join("\n"),
    ),
    [],
  );

  const mutations = [
    ["src/App.tsx", '<a href="https://github.com/example/repo">repo</a>'],
    ["src/OtherView.tsx", '<a href={url}>repo</a>'],
    ["src/PromptsView.tsx", '<a href={href} onClick={() => openExternal?.(href)}>repo</a>'],
    ["src/PromptsView.tsx", '<a href={href} onClick={async (event) => { await work(); event.preventDefault(); }}>repo</a>'],
    ["src/PromptsView.tsx", "safeExternalUrl(other) ? <a href={href} onClick={(event) => { event.preventDefault(); if (false) openExternal?.(href); }} rel=\"noreferrer\">repo</a> : null"],
    ["src/OtherView.tsx", 'React.createElement("a", { href: url }, "repo")'],
    ["src/OtherView.tsx", 'createElement("a", { href: url }, "repo")'],
  ];
  for (const [path, source] of mutations) {
    assertBlocked(source, /raw JSX anchor|programmatic .*createElement/, path);
  }
});
