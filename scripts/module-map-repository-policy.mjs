import path from "node:path";

const ALLOWED_PERSONAL_PATH_FIXTURES = new Set([
  "example",
  "source-machine",
  "target-machine",
]);
const SECRET_PATTERNS = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private key", /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE KEY-----/g],
];

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function findForbiddenTrackedArtifactPaths(paths) {
  const errors = [];
  for (const pathname of paths) {
    const normalized = pathname.replaceAll("\\", "/");
    const basename = path.posix.basename(normalized);
    const lower = basename.toLowerCase();
    const segments = normalized.split("/");
    if (basename.startsWith(".env") && normalized !== ".env.example") {
      errors.push(`tracked environment file is forbidden: ${pathname}`);
    }
    if (/\.(?:pem|key|p12|mobileprovision)$/i.test(basename)) {
      errors.push(`tracked signing or private-key material is forbidden: ${pathname}`);
    }
    if (
      lower.endsWith(".dmg") ||
      lower.endsWith(".srtmigration") ||
      segments.some((segment) => segment.toLowerCase().endsWith(".app"))
    ) {
      errors.push(`tracked generated product artifact is forbidden: ${pathname}`);
    }
    if (
      basename === "manifest.token" ||
      (basename === "manifest.json" && segments.some((segment) =>
        /(?:_aarch64\.release-|^\.srt-release-handoff-)/.test(segment)))
    ) {
      errors.push(`tracked private release handoff is forbidden: ${pathname}`);
    }
  }
  return uniqueSorted(errors);
}

export function findSensitiveTrackedContent(pathname, contents) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents));
  if (buffer.includes(0)) return [];
  const source = buffer.toString("utf8");
  const errors = [];
  for (const [label, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      errors.push(
        `${pathname}:${lineNumber(source, match.index)} contains a probable ${label}; tracked secrets are forbidden`,
      );
    }
  }
  for (const match of source.matchAll(/(?:\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g)) {
    if (!ALLOWED_PERSONAL_PATH_FIXTURES.has(match[1])) {
      errors.push(
        `${pathname}:${lineNumber(source, match.index)} contains a personal home path; use a fictional fixture identity`,
      );
    }
  }
  for (const match of source.matchAll(/[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/g)) {
    if (!ALLOWED_PERSONAL_PATH_FIXTURES.has(match[1])) {
      errors.push(
        `${pathname}:${lineNumber(source, match.index)} contains a personal home path; use a fictional fixture identity`,
      );
    }
  }
  return uniqueSorted(errors);
}
