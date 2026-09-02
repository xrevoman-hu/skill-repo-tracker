const PRODUCT_NAME = "Skill Repo Tracker";

function verifierRemoteTagRef(version) {
  return `refs/tags/_srt-release-remote/v${version}`;
}

export function buildRemoteFetchArguments(version) {
  return [
    "fetch",
    "--no-tags",
    "--prune",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    `refs/tags/v${version}:${verifierRemoteTagRef(version)}`,
  ];
}

export function remoteVerifierTagRef(version) {
  return verifierRemoteTagRef(version);
}

export function buildLocalMainFetchArguments() {
  return [
    "fetch",
    "--no-tags",
    "--prune",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ];
}

export function validateLocalReleaseSource({ version, head, remoteMain, remoteTagOutput }) {
  if (head !== remoteMain) {
    throw new Error(
      `local release source must equal fresh origin/main: HEAD=${head} origin/main=${remoteMain}`,
    );
  }
  if (remoteTagOutput.trim() !== "") {
    throw new Error(`remote tag v${version} already exists; local release generation is forbidden`);
  }
}

function normalizeReleaseBody(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

export function validateFinalReleaseMetadata(release, version, expectedBody) {
  const expectedTag = `v${version}`;
  const expectedName = `${PRODUCT_NAME} ${expectedTag}`;
  if (
    release?.tagName !== expectedTag ||
    release?.name !== expectedName ||
    release?.isDraft ||
    release?.isPrerelease
  ) {
    throw new Error(
      `GitHub Release must be final with tag ${expectedTag} and title ${expectedName}`,
    );
  }
  const normalizedExpected = normalizeReleaseBody(expectedBody);
  for (const disclosure of [
    "## 中文", "## English", "ad-hoc", "Developer ID", "notarized",
    "首次启动", "Control-click", "Privacy & Security",
  ]) {
    if (!normalizedExpected.includes(disclosure)) {
      throw new Error(`tracked release notes are missing required disclosure: ${disclosure}`);
    }
  }
  if (normalizeReleaseBody(release?.body) !== normalizedExpected) {
    throw new Error(`GitHub Release body must exactly match docs/releases/v${version}.md`);
  }
}
