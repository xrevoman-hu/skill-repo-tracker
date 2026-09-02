const DEDICATED_RUST_TEST_MODULE = /(?:^|\/)[^/]*_tests\.rs$/;

export const RUST_COVERAGE_TEST_FILE_PATTERN =
  "(^|/)src-tauri/(tests/|src/[^/]*_tests\\.rs$)";

export function isDedicatedRustTestModulePath(pathname) {
  return typeof pathname === "string" && DEDICATED_RUST_TEST_MODULE.test(pathname);
}

export function isRustIntegrationTestPath(pathname) {
  return (
    typeof pathname === "string" &&
    pathname.startsWith("src-tauri/tests/") &&
    pathname.endsWith(".rs")
  );
}

export function isRustProductionSourcePath(pathname) {
  return (
    typeof pathname === "string" &&
    pathname.startsWith("src-tauri/src/") &&
    pathname.endsWith(".rs") &&
    !isDedicatedRustTestModulePath(pathname)
  );
}

export function isRustTestSourcePath(pathname) {
  return (
    (typeof pathname === "string" &&
      pathname.startsWith("src-tauri/src/") &&
      isDedicatedRustTestModulePath(pathname)) ||
    isRustIntegrationTestPath(pathname)
  );
}
