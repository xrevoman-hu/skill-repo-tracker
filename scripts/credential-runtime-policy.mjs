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
    || (relative === "src-tauri/src/credential_mcp.rs" && functionName === "dispatch_from_env" && name === "args_os")
    || (relative === "src-tauri/src/credential_commands.rs" && functionName === "start_host" && name === "current_exe")
    || (relative === "src-tauri/src/credential_ipc.rs" && functionName === "verify_peer" && name === "current_exe");
}

// Only the local control action may request interactive access to existing material.
// MCP requests, startup and bridge reconnects must never reach this operation.
export function assertCredentialExplicitAuthorization(relative, structural, functionBody) {
  const references = [...structural.matchAll(/\bauthorize_existing\b/g)];
  if (relative === "src-tauri/src/credential_auth.rs") {
    if (references.length !== 1 || !/\bfn\s+authorize_existing\s*\(/.test(structural)) {
      throw new Error("credential Keychain interactive access must have one adapter definition");
    }
    return;
  }
  if (references.length === 0) return;
  if (relative !== "src-tauri/src/credential_runtime.rs" || references.length !== 1) {
    throw new Error("credential Keychain interactive access is restricted to the explicit local action");
  }
  const expectedAction = '"authorize_access"=>{self.authorize_with(credential_auth::authorize_existing)?;}';
  const control = functionBody("control");
  if (!control.includes(expectedAction) || [...structural.matchAll(/\.\s*authorize_with\s*\(/g)].length !== 1) {
    throw new Error("credential Keychain interactive access requires the exact authorize_access action");
  }
  const expected = `
    self.store.as_ref().ok_or("vault_locked")?;
    self.code = None;
    self.authorization_error = Some("credential_authorization_required");
    self.invalidate(false)?;
    match authorize(&self.vault_id) {
      Ok(code) => { self.code = Some(code); self.authorization_error = None; Ok(()) }
      Err(error) => { self.authorization_error = Some(error); Err(error) }
    }
  `.replace(/\s+/g, "");
  if (functionBody("authorize_with") !== expected) {
    throw new Error("credential Keychain interactive access must require unlock and invalidation while preserving sharing intent");
  }
}
