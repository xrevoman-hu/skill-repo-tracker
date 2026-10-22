//! Bounded local inspection of already registered file leases. Original bytes
//! are never rewritten. Only public-key output is captured, never private text.

use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::MetadataExt,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(test)]
#[path = "credential_file_inspect_tests.rs"]
mod tests;

const OUTPUT_LIMIT: u64 = 64 * 1024;

pub(crate) fn format_hint(bytes: &[u8]) -> &'static str {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let bytes = &bytes[start..];
    if bytes.starts_with(b"PuTTY-User-Key-File-") {
        return "putty_private_key";
    }
    // Parse the public PEM label only; recognizing a delimiter is not parsing
    // or validating its payload. Original bytes remain untouched.
    let label = bytes
        .split(|byte| matches!(*byte, b'\r' | b'\n'))
        .next()
        .and_then(|line| line.strip_prefix(b"-----BEGIN "))
        .and_then(|line| line.strip_suffix(b"-----"));
    match label {
        Some(b"OPENSSH PRIVATE KEY") => "openssh_private_key",
        Some(b"ENCRYPTED PRIVATE KEY") => "pem_encrypted_private_key",
        Some(b"PRIVATE KEY" | b"RSA PRIVATE KEY" | b"EC PRIVATE KEY" | b"DSA PRIVATE KEY") => {
            "pem_private_key"
        }
        Some(b"CERTIFICATE") => "pem_certificate",
        Some(b"PKCS7") => "pkcs7_certificate",
        _ => "binary_or_unknown",
    }
}

fn inspect_path(path: &Path) -> Result<&'static str, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "file_inspection_unavailable")?;
    // Leases have no symlinks, restrictive permissions, and current-user ownership.
    // SAFETY: geteuid has no arguments or pointer preconditions.
    if !path.is_absolute()
        || !metadata.is_file()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() > 16 * 1024 * 1024
    {
        return Err("file_inspection_unavailable");
    }
    let mut head = [0; 4096];
    let length = File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .map_err(|_| "file_inspection_unavailable")?;
    Ok(format_hint(&head[..length]))
}

struct OwnedChild {
    child: Child,
    reaped: bool,
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn run(
    arguments: &[OsString],
    passphrase: Option<&str>,
    deadline: Instant,
) -> Result<Option<Vec<u8>>, &'static str> {
    if Instant::now() >= deadline {
        return Err("file_inspection_timeout");
    }
    // stdout contains only a derived public key or a verification status. An
    // anonymous file avoids both pipe backpressure and a plaintext named file.
    let mut output = tempfile::tempfile().map_err(|_| "file_inspection_unavailable")?;
    let writer = output
        .try_clone()
        .map_err(|_| "file_inspection_unavailable")?;
    let child = Command::new("/usr/bin/openssl")
        .args(arguments)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::from(writer))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "file_inspection_unavailable")?;
    let mut child = OwnedChild {
        child,
        reaped: false,
    };
    if let Some(mut input) = child.child.stdin.take() {
        if let Some(passphrase) = passphrase {
            if let Err(error) = input
                .write_all(passphrase.as_bytes())
                .and_then(|()| input.write_all(b"\n"))
            {
                // Unencrypted keys can finish without consuming stdin. Still
                // reap and check the actual exit status instead of racing it.
                if error.kind() != std::io::ErrorKind::BrokenPipe {
                    return Err("file_inspection_failed");
                }
            }
        }
    }
    let status = loop {
        match child
            .child
            .try_wait()
            .map_err(|_| "file_inspection_failed")?
        {
            Some(status) => {
                child.reaped = true;
                break status;
            }
            None if Instant::now() >= deadline => return Err("file_inspection_timeout"),
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    if !status.success() {
        return Ok(None);
    }
    if output
        .metadata()
        .map_err(|_| "file_inspection_failed")?
        .len()
        > OUTPUT_LIMIT
    {
        return Err("file_inspection_output_limit");
    }
    output
        .seek(SeekFrom::Start(0))
        .map_err(|_| "file_inspection_failed")?;
    let mut bytes = Vec::new();
    output
        .take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "file_inspection_failed")?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("file_inspection_output_limit");
    }
    Ok(Some(bytes))
}

fn key_arguments(path: &Path) -> Vec<OsString> {
    vec![
        "pkey".into(),
        "-in".into(),
        path.as_os_str().to_owned(),
        "-passin".into(),
        "stdin".into(),
        "-pubout".into(),
    ]
}

fn certificate_arguments(path: &Path) -> Vec<OsString> {
    vec![
        "x509".into(),
        "-in".into(),
        path.as_os_str().to_owned(),
        "-pubkey".into(),
        "-noout".into(),
    ]
}

fn chain_arguments(certificate: &Path, chain: &Path, empty_store: &Path) -> Vec<OsString> {
    vec![
        "verify".into(),
        "-CAfile".into(),
        chain.as_os_str().to_owned(),
        "-CApath".into(),
        empty_store.as_os_str().to_owned(),
        "-check_ss_sig".into(),
        certificate.as_os_str().to_owned(),
    ]
}

pub(crate) fn inspect(
    key_path: Option<&Path>,
    certificate_path: Option<&Path>,
    chain_path: Option<&Path>,
    passphrase: Option<&str>,
) -> Result<Value, &'static str> {
    if passphrase.is_some_and(|value| value.len() > 1024 || value.contains(['\r', '\n', '\0'])) {
        return Err("file_passphrase_unsupported");
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut limitations = vec!["no_hostname_or_revocation_check"];
    let mut key_parsed = None;
    let mut certificate_parsed = None;
    let mut key_public = None;
    let mut certificate_public = None;
    if let Some(path) = key_path {
        if matches!(
            inspect_path(path)?,
            "pem_private_key" | "pem_encrypted_private_key"
        ) {
            key_public = run(
                &key_arguments(path),
                Some(passphrase.unwrap_or("")),
                deadline,
            )?;
            key_parsed = Some(key_public.is_some());
        } else {
            limitations.push("key_format_unsupported");
        }
    }
    if let Some(path) = certificate_path {
        if inspect_path(path)? == "pem_certificate" {
            certificate_public = run(&certificate_arguments(path), None, deadline)?;
            certificate_parsed = Some(certificate_public.is_some());
        } else {
            limitations.push("certificate_format_unsupported");
        }
    }
    let pair_matches = key_public
        .as_ref()
        .zip(certificate_public.as_ref())
        .map(|(key, certificate)| key == certificate);
    let mut chain_status = "not_provided";
    if let Some(chain) = chain_path {
        limitations.push("chain_trust_is_user_supplied");
        if inspect_path(chain)? != "pem_certificate" {
            limitations.push("chain_format_unsupported");
            chain_status = "not_verified";
        } else if let Some(certificate) =
            certificate_path.filter(|_| certificate_parsed == Some(true))
        {
            // Explicit CAfile plus an empty CApath excludes ambient/system CAs.
            // This says only that this supplied local trust material verifies
            // the leaf; it is not public-CA, hostname, or revocation validation.
            let empty_store = tempfile::tempdir().map_err(|_| "file_inspection_unavailable")?;
            chain_status = if run(
                &chain_arguments(certificate, chain, empty_store.path()),
                None,
                deadline,
            )?
            .is_some()
            {
                "verified_against_supplied_chain"
            } else {
                "not_verified"
            };
        } else {
            chain_status = "certificate_required";
        }
    }
    Ok(
        json!({"keyParsed":key_parsed,"certificateParsed":certificate_parsed,
        "pairMatches":pair_matches,"chainStatus":chain_status,
        "verificationScope":"local_files_only","limitations":limitations}),
    )
}
