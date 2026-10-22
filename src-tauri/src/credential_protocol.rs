//! Private GUI control pipe budget; the public MCP/Unix IPC keeps its 24 MiB limit.

use serde_json::Value;
use std::io::{self, BufRead, Write};

// Seven 1 MiB secret fields plus 16 MiB of attachment bytes fit even under
// JSON's worst six-byte escaping. Input retains its independent business limits.
pub const CONTROL_FRAME_LIMIT: usize = 160 * 1024 * 1024;

pub fn read_line(reader: &mut impl BufRead) -> Result<Option<Value>, &'static str> {
    let mut bytes = Vec::new();
    std::io::Read::take(reader, CONTROL_FRAME_LIMIT as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "credential_host_unavailable")?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() >= CONTROL_FRAME_LIMIT || bytes.last() != Some(&b'\n') {
        return Err("credential_host_protocol_invalid");
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "credential_host_protocol_invalid")
}

pub fn fits_frame(value: &Value) -> bool {
    fits_limit(value, CONTROL_FRAME_LIMIT)
}

pub fn fits_limit(value: &Value, limit: usize) -> bool {
    struct Budget {
        used: usize,
        limit: usize,
    }
    impl Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.used = self
                .used
                .checked_add(bytes.len())
                .ok_or_else(|| io::Error::other("response limit"))?;
            if self.used >= self.limit {
                return Err(io::Error::other("response limit"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Budget { used: 0, limit }, value).is_ok()
}

pub fn write_line(writer: &mut impl Write, value: &Value) -> Result<(), &'static str> {
    if !fits_frame(value) {
        return Err("secret_text_response_too_large");
    }
    serde_json::to_writer(&mut *writer, value).map_err(|_| "credential_host_unavailable")?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|_| "credential_host_unavailable")
}
