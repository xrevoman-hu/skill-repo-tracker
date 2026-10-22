import { execFileSync } from "node:child_process";

export const EXPECTED_REPOSITORY = "xrevoman-hu/skill-repo-tracker";
export const EXPECTED_GIT_URL = `https://github.com/${EXPECTED_REPOSITORY}.git`;

export function parseGitHubResponse(raw) {
  const boundary = raw.search(/\r?\n\r?\n/);
  if (boundary < 0) throw new Error("GitHub response headers are missing");
  const lines = raw.slice(0, boundary).split(/\r?\n/);
  const status = /^HTTP\/\S+ (\d{3})(?: |$)/.exec(lines.shift() ?? "");
  if (!status) throw new Error("GitHub response status is invalid");
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) throw new Error("GitHub response header is invalid");
    const key = line.slice(0, index).toLowerCase();
    if (Object.hasOwn(headers, key)) throw new Error("duplicate GitHub response header");
    headers[key] = line.slice(index + 1).trim();
  }
  const text = raw.slice(boundary).replace(/^\r?\n\r?\n/, "");
  return { status: Number(status[1]), headers, body: text.trim() ? JSON.parse(text) : null };
}

export function createGitHubReader({ root, request, maxRequests = 200 } = {}) {
  let requests = 0;
  const repositories = new Map();
  const bindRepository = (name, id) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name ?? "") || !Number.isSafeInteger(id) || id < 1
        || (repositories.has(name) && repositories.get(name) !== id)) throw new Error("repository ID binding is invalid or changed");
    repositories.set(name, id);
  };
  const transport = request ?? ((endpoint) => parseGitHubResponse(execFileSync("gh", [
    "api", "--hostname", "github.com", "--method", "GET", "--include", endpoint,
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 })));
  const response = (endpoint) => {
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 200
        || ++requests > maxRequests) throw new Error("GitHub request budget exhausted");
    if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/.test(endpoint)) {
      throw new Error("GitHub endpoint must remain in the selected repository");
    }
    const result = transport(endpoint);
    if (!result || !Number.isInteger(result.status) || typeof result.headers !== "object") {
      throw new Error("GitHub response is incomplete");
    }
    return result;
  };
  const get = (endpoint) => {
    const result = response(endpoint);
    if (result.status !== 200) throw new Error(`GitHub GET failed with status ${result.status}`);
    return result.body;
  };
  const collection = (endpoint, itemKey, { maxPages = 10 } = {}) => {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) {
      throw new Error("GitHub page budget is invalid");
    }
    const result = [], ids = new Set();
    let total;
    for (let page = 1; page <= maxPages; page += 1) {
      const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
      const current = response(url);
      if (current.status !== 200) throw new Error(`GitHub page failed with status ${current.status}`);
      const rows = itemKey ? current.body?.[itemKey] : current.body;
      if (!Array.isArray(rows) || rows.length > 100) throw new Error("GitHub page has invalid items");
      if (itemKey) {
        const count = current.body?.total_count;
        if (!Number.isSafeInteger(count) || count < 0 || count > 1000
            || (total !== undefined && total !== count)) throw new Error("GitHub pagination total is invalid or changed");
        total = count;
      }
      for (const row of rows) {
        const id = row?.id ?? row?.name;
        if (id === undefined || ids.has(id)) throw new Error("GitHub page has missing or duplicate identity");
        ids.add(id); result.push(row);
      }
      const name = /^repos\/([^/]+\/[^/]+)/.exec(endpoint)?.[1];
      const next = nextPage(current.headers.link, url, repositories.get(name));
      if (next && (rows.length !== 100 || (total !== undefined && result.length >= total))) {
        throw new Error("GitHub next page contradicts the response");
      }
      if (!next) {
        if (total !== undefined && result.length !== total) {
          throw new Error("GitHub pagination is incomplete");
        }
        if (total === undefined && rows.length === 100) continue;
        return result;
      }
    }
    throw new Error("GitHub page budget exhausted");
  };
  return { response, get, collection, bindRepository, requestCount: () => requests };
}

function nextPage(link, endpoint, repositoryId) {
  if (link === undefined) return false;
  if (typeof link !== "string" || !link) throw new Error("invalid GitHub pagination Link");
  const current = new URL(`https://api.github.com/${endpoint}`);
  const seen = new Set();
  let next = false;
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
    if (!match || seen.has(match[2])) throw new Error("invalid GitHub pagination relation");
    seen.add(match[2]);
    const target = new URL(match[1]);
    const page = target.searchParams.get("page");
    if (!/^[1-9]\d*$/.test(page ?? "")) throw new Error("invalid GitHub pagination page");
    target.searchParams.set("page", current.searchParams.get("page"));
    const query = (url) => JSON.stringify([...url.searchParams.entries()].sort());
    const suffix = current.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const samePath = target.pathname === current.pathname
      || (repositoryId !== undefined && target.pathname === `/repositories/${repositoryId}${suffix}`);
    if (target.origin !== current.origin || !samePath
        || target.username || target.password || target.hash || query(target) !== query(current)) {
      throw new Error("GitHub pagination escaped its query");
    }
    if (match[2] === "next") {
      if (Number(page) !== Number(current.searchParams.get("page")) + 1) {
        throw new Error("GitHub pagination skipped a page");
      }
      next = true;
    }
  }
  return next;
}
