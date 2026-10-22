// ADR 0012: only the GUI's private, same-executable credential host is allowed.
// The ordinary browser-opening process policy remains independent.
export function credentialHostSpawn(relative, source, position, owner) {
  if (relative !== "src-tauri/src/credential_commands.rs" || owner !== "start_host") return false;
  const expected = 'Command::new(&executable).arg("--credential-host").arg("--root").arg(&self.root)' +
    '.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()';
  const candidate = source.slice(position).match(/^Command\s*::\s*new[\s\S]*?\.\s*spawn\s*\(\s*\)/)?.[0];
  return candidate?.replace(/\s+/g, "") === expected;
}

export function assertProductExplicitAuthorization(relative, structural, functionBody) {
  const refs = [...structural.matchAll(/\bproduction_authorize\b/g)];
  if (refs.length === 0) return;
  if (relative === "src-tauri/src/credential_auth.rs") {
    if (refs.length !== 1 || !/\bfn\s+production_authorize\s*\(/.test(structural)) {
      throw new Error("credential product authorization requires one adapter definition");
    }
    return;
  }
  if (relative !== "src-tauri/src/credential_product.rs" || refs.length !== 1) {
    throw new Error("credential product authorization is restricted to its local control action");
  }
  const expected = `"authorize_access" => {
    self.store()?;
    self.code=None; self.authorization_error=Some("credential_authorization_required");
    self.invalidate(false)?;
    match credential_auth::production_authorize(&self.vault_id) {
      Ok(code)=>{self.code=Some(code);self.authorization_error=None;}
      Err(error)=>{self.authorization_error=Some(error);return Err(error);}
    }
  }`.replace(/\s+/g, "");
  if (!functionBody("control").includes(expected)) {
    throw new Error("credential product authorization must require unlock and invalidate without enabling sharing");
  }
}

export function credentialSpawnMask(relative, source, masked, ownerAt) {
  const output = [...masked];
  const sites = [];
  const blankSpawn = (position) => {
    for (let index = position; index < position + 5; index += 1) output[index] = " ";
  };
  for (const call of masked.matchAll(/\bCommand\s*::\s*new\s*\(/g)) {
    if (!credentialHostSpawn(relative, source, call.index, ownerAt(call.index))) continue;
    const tail = masked.slice(call.index).match(/\.\s*(spawn)\s*\(/);
    if (tail) blankSpawn(call.index + tail.index + tail[0].indexOf("spawn"));
  }
  for (const call of masked.matchAll(/\bstd\s*::\s*thread\s*::\s*Builder\s*::\s*new\s*\(/g)) {
    const expected = 'std::thread::Builder::new().name("credential-clipboard".into()).spawn(move||cleanup_worker(shared))';
    const tail = source.slice(call.index).match(/^[\s\S]*?\.\s*spawn\s*\(\s*move\s*\|\s*\|\s*cleanup_worker\s*\(\s*shared\s*\)\s*\)/)?.[0];
    if (relative !== "src-tauri/src/credential_clipboard.rs" || ownerAt(call.index) !== "start_worker" ||
        tail?.replace(/\s+/g, "") !== expected) {
      throw new Error(`${relative} clipboard thread Builder requires its exact bounded worker`);
    }
    const spawn = masked.slice(call.index).match(/\.\s*(spawn)\s*\(/);
    blankSpawn(call.index + spawn.index + spawn[0].indexOf("spawn"));
    sites.push(`${relative}:std::thread::Builder::spawn:start_worker#${sites.length + 1}`);
  }
  return { masked: output.join(""), sites };
}

export function credentialClipboardSurface(relative, masked, ownerAt) {
  const framework = /\b(?:objc2|objc2_app_kit|objc2_foundation|NSPasteboard|NSPasteboardTypeString)\b/;
  if (!framework.test(masked)) return [];
  if (relative !== "src-tauri/src/credential_clipboard.rs") {
    throw new Error(`${relative} native clipboard frameworks are restricted to the credential adapter`);
  }
  const allowed = new Set([
    "objc2::rc::autoreleasepool", "objc2_app_kit::NSPasteboard::generalPasteboard",
    "objc2_app_kit::NSPasteboardTypeString", "objc2_foundation::NSString::from_str",
  ]);
  const refs = /\b(?:objc2|objc2_app_kit|objc2_foundation)(?:\s*::\s*\w+)+/g;
  const counts = new Map();
  const sites = [];
  const remainder = masked.replace(refs, (reference, offset) => {
    const api = reference.replace(/\s+/g, "");
    if (!allowed.has(api)) throw new Error(`${relative} native clipboard API is not reviewed: ${api}`);
    const owner = ownerAt(offset);
    if (!["change_count", "text_digest", "clear", "set_text"].includes(owner)) {
      throw new Error(`${relative} native clipboard API is outside its adapter methods`);
    }
    const key = `${api}:${owner}`;
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    sites.push(`${relative}:${key}#${count}`);
    return " ".repeat(reference.length);
  });
  if (framework.test(remainder)) throw new Error(`${relative} native clipboard aliases are forbidden`);
  return sites;
}

export function credentialFocusHook(relative, source, masked) {
  if (relative !== "src-tauri/src/credential_commands.rs") return 0;
  if (/\bhandle_exit\b/.test(masked)) {
    const expected = `pub(crate) fn handle_exit(app: &tauri::AppHandle, event: tauri::RunEvent) {
      if matches!(event, tauri::RunEvent::Exit) {
        app.state::<AppState>().credentials.clear_on_exit();
      }
    }`.replace(/\s+/g, "");
    if (!source.replace(/\s+/g, "").includes(expected) ||
        [...masked.matchAll(/\bhandle_exit\b/g)].length !== 1 ||
        [...masked.matchAll(/tauri\s*::\s*RunEvent\b/g)].length !== 2) {
      throw new Error("credential exit hook must only clear owned secrets on actual application exit");
    }
  }
  const functions = [...masked.matchAll(/\bfn\s+register_focus\s*\(/g)];
  const hooks = [...masked.matchAll(/\.\s*on_window_event\s*\(/g)];
  if (hooks.length === 0) return 0;
  if (functions.length !== 1 || hooks.length !== 1) throw new Error("credential native focus hook must be unique");
  const opening = masked.indexOf("{", functions[0].index);
  let depth = 1; let end = opening + 1;
  for (; end < masked.length && depth > 0; end += 1) {
    if (masked[end] === "{") depth += 1;
    if (masked[end] === "}") depth -= 1;
  }
  const expected = `let client=Arc::clone(client);
    if let Some(window)=app.get_webview_window("main") {
      window.on_window_event(move|event| {
        if matches!(event,tauri::WindowEvent::Focused(false)) { client.invalidate_focus(); }
      });
    }`.replace(/\s+/g, "");
  if (source.slice(opening + 1, end - 1).replace(/\s+/g, "") !== expected) {
    throw new Error("credential native focus hook must only invalidate the main window session");
  }
  return 1;
}

export function credentialParentWatcher(relative, source, masked) {
  if (relative !== "src-tauri/src/credential_product.rs") return [];
  const functions = [...masked.matchAll(/\bfn\s+watch_parent\s*\(/g)];
  if (functions.length !== 1) throw new Error("credential parent watcher must be unique");
  const opening = masked.indexOf("{", functions[0].index);
  let depth = 1; let end = opening + 1;
  for (; end < masked.length && depth > 0; end += 1) {
    if (masked[end] === "{") depth += 1;
    if (masked[end] === "}") depth -= 1;
  }
  const expected = `let parent=unsafe { libc::getppid() };
    if parent<=1 { return Err("credential_parent_unavailable"); }
    Ok(std::thread::spawn(move|| {
      while !stopping.load(Ordering::Acquire) {
        if unsafe { libc::getppid() }!=parent { std::process::exit(1); }
        std::thread::sleep(Duration::from_millis(250));
      }
    }))`.replace(/\s+/g, "");
  const actual = source.slice(opening + 1, end - 1).replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");
  if (actual !== expected || [...masked.matchAll(/libc\s*::\s*getppid\s*\(/g)].length !== 2 ||
      [...masked.matchAll(/std\s*::\s*process\s*::\s*exit\s*\(/g)].length !== 1) {
    throw new Error("credential parent watcher must only exit its own orphaned host with a bounded interval");
  }
  return [`${relative}:std::process::exit:watch_parent#1`];
}
