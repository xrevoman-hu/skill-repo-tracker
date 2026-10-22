// ADR 0010 permits one native local transport adapter, never a general network exception.
export function credentialLocalTransport(relative, masked, ownerAt) {
  if (relative !== "src-tauri/src/credential_ipc.rs") return { masked, sites: [] };
  if (/\b(?:UnixStream|UnixListener)\s+as\b|\btype\s+\w+[^;=]*=\s*(?:\w+::)*(?:UnixStream|UnixListener)\b/.test(masked)) {
    throw new Error(`${relative} credential socket aliases are forbidden`);
  }
  const allowed = new Set(["UnixStream::connect", "UnixListener::bind"]);
  const references = [...masked.matchAll(/\b(UnixStream|UnixListener)\s*::\s*(\w+)\b/g)];
  const calls = [...masked.matchAll(/\b(UnixStream|UnixListener)\s*::\s*(\w+)\s*\(/g)];
  if (references.length !== calls.length || references.some((match) => !allowed.has(`${match[1]}::${match[2]}`))) {
    throw new Error(`${relative} credential sockets require the reviewed direct bind/connect calls`);
  }
  const counts = new Map();
  const sites = calls.map((call) => {
    const key = `${call[1]}::${call[2]}:${ownerAt(call.index)}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return `${relative}:${key}#${count}`;
  });
  // Remove only the reviewed native types/import spellings before the general network ban.
  // TCP, UDP, UnixDatagram, wildcard net imports and async transports remain visible to it.
  const withoutLocalImports = masked
    .replace(/\bstd\s*::\s*os\s*::\s*unix\s*::\s*net\s*::\s*\{\s*UnixListener\s*,\s*UnixStream\s*,?\s*\}/g, "")
    .replace(/\bnet\s*::\s*\{\s*UnixListener\s*,\s*UnixStream\s*,?\s*\}/g, "")
    .replace(/\b(?:std\s*::\s*os\s*::\s*unix\s*::\s*)?net\s*::\s*(?:UnixStream|UnixListener)\b/g, "")
    .replace(/\b(?:UnixStream|UnixListener)\b/g, "");
  return { masked: withoutLocalImports, sites };
}

export function credentialRuntimeInputAllowed(relative, functionName, name) {
  return (relative === "src-tauri/src/credential_runtime.rs" && functionName === "dispatch_from_env" && name === "args_os")
    || (relative === "src-tauri/src/credential_ipc.rs" && functionName === "verify_peer" && name === "current_exe");
}
