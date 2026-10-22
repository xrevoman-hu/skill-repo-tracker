// libsqlite3-sys probes pkg-config even when SQLCIPHER_LIB_DIR is supplied.
// Deny that probe so only the prepared static artifact can provide SQLite FFI.
export function nativeLinkEnvironment(prepared) {
  const keys = ["SQLCIPHER_LIB_DIR", "SQLCIPHER_INCLUDE_DIR", "SQLCIPHER_STATIC", "SRT_CIPHER_SOURCE_SHA256"];
  if (Object.keys(prepared).length !== keys.length || keys.some((key) =>
    !Object.hasOwn(prepared, key) || typeof prepared[key] !== "string" || prepared[key].length === 0) ||
    prepared.SQLCIPHER_STATIC !== "1") {
    throw new Error("native linker environment requires the exact prepared static contract");
  }
  return {
    ...prepared,
    SQLCIPHER_NO_PKG_CONFIG: "1",
    LIBSQLITE3_SYS_USE_PKG_CONFIG: "0",
  };
}
