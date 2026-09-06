import { resolve } from "node:path";

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid detailed coverage hit count");
  return value;
}

function range(location, lineCount, allowEmpty = false) {
  if (allowEmpty && Object.keys(location?.start ?? {}).length === 0
    && Object.keys(location?.end ?? {}).length === 0) return null;
  const start = location?.start?.line;
  const end = location?.end?.line;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end < start || end > lineCount) {
    throw new Error("invalid detailed coverage source range");
  }
  return { start, end };
}

function entries(locations, hits) {
  if (!locations || !hits || Array.isArray(locations) || Array.isArray(hits)
    || typeof locations !== "object" || typeof hits !== "object"
    || Object.keys(locations).sort().join() !== Object.keys(hits).sort().join()) {
    throw new Error("detailed coverage map/counter inventory mismatch");
  }
  return Object.entries(locations).map(([key, location]) => [location, hits[key]]);
}

// Supplement only missing LCOV lines. This retains statement coverage semantics:
// a hit statement owns its multiline source span, except zero-hit nested regions.
// It does not claim expression completion when evaluation throws within a statement.
export function detailedLineEvidence(record, lcov, contents) {
  if (!record || !lcov) throw new Error("missing detailed coverage or LCOV source record");
  const lineCount = contents.split(/\r?\n/).length;
  const positive = [];
  const negative = [];
  const starts = new Map();
  for (const [location, hits] of entries(record.statementMap, record.s)) {
    const span = range(location, lineCount);
    const covered = count(hits) > 0;
    starts.set(span.start, Boolean(starts.get(span.start)) || covered);
    (covered ? positive : negative).push(span);
  }
  if (starts.size !== lcov.lines.size || [...starts].some(([line, hit]) => lcov.lines.get(line) !== hit)) {
    throw new Error("detailed statement coverage does not match LCOV");
  }
  const functions = new Map();
  for (const [location, hits] of entries(record.fnMap, record.f)) {
    const declaration = range(location.decl, lineCount);
    const body = range(location.loc, lineCount);
    if (typeof location.name !== "string") throw new Error("invalid detailed function name");
    functions.set(location.name, count(hits) > 0);
    if (hits > 0) positive.push(declaration);
    else negative.push(declaration, body);
  }
  if (!lcov.functions || functions.size !== lcov.functions.size
    || [...functions].some(([name, hit]) => lcov.functions.get(name) !== hit)) {
    throw new Error("detailed function coverage does not match LCOV");
  }
  const branches = new Map();
  for (const [branch, hits] of entries(record.branchMap, record.b)) {
    const span = range(branch.loc, lineCount);
    if (!Array.isArray(hits) || !Array.isArray(branch.locations) || hits.length !== branch.locations.length) {
      throw new Error("detailed branch coverage inventory mismatch");
    }
    const observed = branches.get(span.start) ?? [];
    hits.forEach((value, index) => {
      const covered = count(value) > 0;
      observed.push(covered);
      const arm = range(branch.locations[index], lineCount, branch.type === "if" && index === 1);
      if (arm && !covered) negative.push(arm);
    });
    branches.set(span.start, observed);
  }
  if (branches.size !== lcov.branches.size || [...branches].some(([line, hits]) =>
    JSON.stringify(hits) !== JSON.stringify(lcov.branches.get(line)))) {
    throw new Error("detailed branch coverage does not match LCOV");
  }
  return (line) => positive.some((span) => span.start <= line && line <= span.end)
    && !negative.some((span) => span.start <= line && line <= span.end);
}

export function createFrontendLineEvidence({ coverage, lcov, root, readSource }) {
  if (!coverage || Array.isArray(coverage) || typeof coverage !== "object") {
    throw new Error("invalid detailed frontend coverage report");
  }
  const cache = new Map();
  return (path, line) => {
    if (!cache.has(path)) {
      const absolute = resolve(root, path);
      const record = coverage[absolute];
      if (record?.path !== absolute) throw new Error(`missing or mismatched detailed coverage path: ${path}`);
      cache.set(path, detailedLineEvidence(record, lcov[path], readSource(path)));
    }
    return cache.get(path)(line);
  };
}
