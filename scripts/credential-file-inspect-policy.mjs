// ADR 0013: one bounded OpenSSL inspection process, never a general command seam.
const FILE = "src-tauri/src/credential_file_inspect.rs";
const PROCESS = 'Command::new("/usr/bin/openssl").args(arguments).env_clear()' +
  '.stdin(Stdio::piped()).stdout(Stdio::from(writer)).stderr(Stdio::null()).spawn()';

// Ignore layout and comments while preserving string bytes. In particular,
// whitespace inside an executable path must not normalize into an allowed path.
function compact(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    if (/\s/.test(source[index])) { index += 1; continue; }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) { depth += 1; index += 2; }
        else if (source.startsWith("*/", index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth !== 0) throw new Error("credential inspector contains an unterminated comment");
      continue;
    }
    if (source[index] === '"') {
      const start = index++;
      while (index < source.length && source[index] !== '"') {
        index += source[index] === "\\" ? 2 : 1;
      }
      if (source[index] !== '"') throw new Error("credential inspector contains an unterminated string");
      tokens.push(source.slice(start, ++index));
      continue;
    }
    tokens.push(source[index++]);
  }
  return tokens.filter((token, index) => token !== "," || !["}", ")", "]"].includes(tokens[index + 1])).join("");
}

function balancedEnd(masked, opening, left, right) {
  let depth = 1;
  for (let index = opening + 1; index < masked.length; index += 1) {
    if (masked[index] === left) depth += 1;
    if (masked[index] === right && --depth === 0) return index;
  }
  throw new Error("credential inspector has an unbalanced reviewed expression");
}

function functionSource(source, masked, name, { privateOnly = true } = {}) {
  const refs = [...masked.matchAll(new RegExp(`\\bfn\\s+${name}\\s*\\(`, "g"))];
  if (refs.length !== 1) throw new Error(`credential inspector requires one ${name} definition`);
  const start = refs[0].index;
  if (privateOnly && /\bpub(?:\s*\([^)]*\))?\s*$/.test(masked.slice(0, start))) {
    throw new Error(`credential inspector ${name} must remain private`);
  }
  const opening = masked.indexOf("{", start);
  const closing = balancedEnd(masked, opening, "{", "}");
  return source.slice(start, closing + 1);
}

const RUN = String.raw`fn run(arguments: &[OsString], passphrase: Option<&str>, deadline: Instant)
  -> Result<Option<Vec<u8>>, &'static str> {
    if Instant::now() >= deadline { return Err("file_inspection_timeout"); }
    let mut output = tempfile::tempfile().map_err(|_| "file_inspection_unavailable")?;
    let writer = output.try_clone().map_err(|_| "file_inspection_unavailable")?;
    let child = Command::new("/usr/bin/openssl").args(arguments).env_clear()
        .stdin(Stdio::piped()).stdout(Stdio::from(writer)).stderr(Stdio::null())
        .spawn().map_err(|_| "file_inspection_unavailable")?;
    let mut child = OwnedChild { child, reaped: false };
    if let Some(mut input) = child.child.stdin.take() {
        if let Some(passphrase) = passphrase {
            if let Err(error) = input.write_all(passphrase.as_bytes()).and_then(|()| input.write_all(b"\n")) {
                if error.kind() != std::io::ErrorKind::BrokenPipe { return Err("file_inspection_failed"); }
            }
        }
    }
    let status = loop {
        match child.child.try_wait().map_err(|_| "file_inspection_failed")? {
            Some(status) => { child.reaped = true; break status; }
            None if Instant::now() >= deadline => return Err("file_inspection_timeout"),
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    if !status.success() { return Ok(None); }
    if output.metadata().map_err(|_| "file_inspection_failed")?.len() > OUTPUT_LIMIT {
        return Err("file_inspection_output_limit");
    }
    output.seek(SeekFrom::Start(0)).map_err(|_| "file_inspection_failed")?;
    let mut bytes = Vec::new();
    output.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes).map_err(|_| "file_inspection_failed")?;
    if bytes.len() as u64 > OUTPUT_LIMIT { return Err("file_inspection_output_limit"); }
    Ok(Some(bytes))
}`;

const HELPERS = {
  key_arguments: `fn key_arguments(path: &Path) -> Vec<OsString> {
    vec!["pkey".into(), "-in".into(), path.as_os_str().to_owned(), "-passin".into(), "stdin".into(), "-pubout".into()]
  }`,
  certificate_arguments: `fn certificate_arguments(path: &Path) -> Vec<OsString> {
    vec!["x509".into(), "-in".into(), path.as_os_str().to_owned(), "-pubkey".into(), "-noout".into()]
  }`,
  chain_arguments: `fn chain_arguments(certificate: &Path, chain: &Path, empty_store: &Path) -> Vec<OsString> {
    vec!["verify".into(), "-CAfile".into(), chain.as_os_str().to_owned(), "-CApath".into(),
      empty_store.as_os_str().to_owned(), "-check_ss_sig".into(), certificate.as_os_str().to_owned()]
  }`,
  drop: `fn drop(&mut self) {
    if !self.reaped { let _ = self.child.kill(); let _ = self.child.wait(); }
  }`,
};

export function credentialInspectorSpawn(relative, source, position, owner) {
  if (relative !== FILE || owner !== "run") return false;
  const candidate = source.slice(position).match(/^Command\s*::\s*new[\s\S]*?\.\s*spawn\s*\(\s*\)/)?.[0];
  return candidate !== undefined && compact(candidate) === compact(PROCESS);
}

export function credentialInspectorMask(relative, source, masked, ownerAt) {
  if (relative !== FILE) return masked;
  for (const [name, expected] of Object.entries({ run: RUN, ...HELPERS })) {
    if (compact(functionSource(source, masked, name)) !== compact(expected)) {
      throw new Error(`credential inspector ${name} must retain its fixed bounded process contract`);
    }
  }
  const commands = [...masked.matchAll(/\bCommand\s*::\s*new\s*\(/g)];
  if (commands.length !== 1 || !credentialInspectorSpawn(relative, source, commands[0].index, ownerAt(commands[0].index))) {
    throw new Error("credential inspector must contain exactly one fixed OpenSSL process");
  }
  const calls = [...masked.matchAll(/\brun\s*\(/g)].filter((match) => !/\bfn\s*$/.test(masked.slice(0, match.index)));
  const expectedCalls = [
    'run(&key_arguments(path),Some(passphrase.unwrap_or("")),deadline)',
    "run(&certificate_arguments(path),None,deadline)",
    "run(&chain_arguments(certificate,chain,empty_store.path()),None,deadline)",
  ];
  const actualCalls = calls.map((call) => {
    if (ownerAt(call.index) !== "inspect") throw new Error("credential inspector run calls must stay inside inspect");
    const opening = masked.indexOf("(", call.index);
    return compact(source.slice(call.index, balancedEnd(masked, opening, "(", ")") + 1));
  });
  if (JSON.stringify(actualCalls) !== JSON.stringify(expectedCalls.map(compact)) ||
      [...masked.matchAll(/\brun\b/g)].length !== 4) {
    throw new Error("credential inspector must only call its three fixed argument helpers");
  }
  for (const name of ["key_arguments", "certificate_arguments", "chain_arguments"]) {
    if ([...masked.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length !== 2) {
      throw new Error(`credential inspector ${name} cannot be aliased or reused`);
    }
  }
  const inspect = compact(functionSource(source, masked, "inspect", { privateOnly: false }));
  const guard = String.raw`if passphrase.is_some_and(|value| value.len() > 1024 || value.contains(['\r', '\n', '\0'])) {
    return Err("file_passphrase_unsupported"); }`;
  if (!inspect.includes(compact(guard)) ||
      !inspect.includes(compact("let deadline = Instant::now() + Duration::from_secs(5);")) ||
      !compact(source).includes(compact("const OUTPUT_LIMIT: u64 = 64 * 1024;")) ||
      !compact(source).includes(compact("struct OwnedChild { child: Child, reaped: bool }")) ||
      !compact(source).includes(compact("impl Drop for OwnedChild {")) ||
      [...masked.matchAll(/\bdeadline\b/g)].length !== 7 ||
      [...masked.matchAll(/\bOUTPUT_LIMIT\b/g)].length !== 4 ||
      [...masked.matchAll(/\benv_clear\b/g)].length !== 1 ||
      [...masked.matchAll(/\b(?:env|envs|env_remove)\s*\(/g)].length !== 0) {
    throw new Error("credential inspector must retain its passphrase, environment and time/output limits");
  }
  const output = [...masked];
  const spawn = masked.slice(commands[0].index).match(/\.\s*(spawn)\s*\(/);
  const start = commands[0].index + spawn.index + spawn[0].indexOf("spawn");
  for (let index = start; index < start + 5; index += 1) output[index] = " ";
  return output.join("");
}
