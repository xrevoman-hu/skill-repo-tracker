import assert from "node:assert/strict";
import test from "node:test";

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
    assertBlocked(source, /raw JSX anchor|programmatic anchor/, path);
  }
});
