//! E0 encrypted fixture store. It never opens the application's ordinary DB.

use base64::Engine;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) const MAX_FILE: usize = 16 * 1024 * 1024;
pub(crate) const MAX_SECRET: usize = 1024 * 1024;
pub(crate) const MAX_PASSWORD: usize = 1024;

pub(crate) struct Store {
    connection: Connection,
}

fn password_valid(password: &str) -> bool {
    password.len() <= MAX_PASSWORD && password.chars().count() >= 12
}

fn keyed(path: &Path, password: &str) -> Result<Connection, &'static str> {
    if !password_valid(password) {
        return Err("password_length_invalid");
    }
    crate::credential_ipc::private_path(path, false)?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| "vault_unavailable")?;
    connection
        .pragma_update(None, "key", password)
        .map_err(|_| "vault_key_failed")?;
    // SQLCipher >=4.7 requires key before every other operation.
    let cipher: String = connection
        .pragma_query_value(None, "cipher_version", |r| r.get(0))
        .map_err(|_| "encryption_engine_unavailable")?;
    if cipher.is_empty() {
        return Err("encryption_engine_unavailable");
    }
    connection
        .pragma_update(None, "temp_store", "MEMORY")
        .map_err(|_| "vault_unavailable")?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "vault_unavailable")?;
    Ok(connection)
}

impl Store {
    pub(crate) fn create(
        path: &Path,
        password: &str,
        vault_id: &str,
    ) -> Result<Self, &'static str> {
        if !password_valid(password) {
            return Err("password_length_invalid");
        }
        drop(crate::credential_ipc::create_private(path)?);
        let connection = keyed(path, password)?;
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
            CREATE TABLE vault_meta (id TEXT PRIMARY KEY, format INTEGER NOT NULL);
            CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
                location TEXT NOT NULL, username TEXT NOT NULL, secrets TEXT NOT NULL);
            CREATE TABLE assets (record_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
                bytes BLOB NOT NULL CHECK(length(bytes)>0));",
            )
            .map_err(|_| "vault_create_failed")?;
        connection
            .execute("INSERT INTO vault_meta VALUES (?1, 1)", [vault_id])
            .map_err(|_| "vault_create_failed")?;
        for (kind, id, field, value) in [
            (
                "website",
                "website-001",
                "password",
                "e0-website-value-only",
            ),
            ("ssh", "ssh-001", "passphrase", "e0-ssh-passphrase-only"),
            ("tls", "tls-001", "passphrase", "e0-tls-passphrase-only"),
            (
                "database_instance",
                "database-instance-001",
                "password",
                "e0-instance-value-only",
            ),
            (
                "database_user",
                "database-user-001",
                "password",
                "e0-database-user-value-only",
            ),
            ("email", "email-001", "password", "e0-email-value-only"),
            ("api_token", "api-token-001", "token", "e0-api-value-only"),
            ("generic", "generic-001", "value", "e0-generic-value-only"),
        ] {
            let secrets = json!({field: value}).to_string();
            connection
                .execute(
                    "INSERT INTO records VALUES (?1,?2,?3,?4,?5,?6)",
                    params![
                        id,
                        kind,
                        format!("E0 {kind}"),
                        "example.test",
                        "e0-user",
                        secrets
                    ],
                )
                .map_err(|_| "vault_create_failed")?;
        }
        connection
            .execute_batch("COMMIT")
            .map_err(|_| "vault_create_failed")?;
        Ok(Self { connection })
    }

    pub(crate) fn unlock(
        path: &Path,
        password: &str,
        vault_id: &str,
    ) -> Result<Self, &'static str> {
        let connection = keyed(path, password)?;
        let (id, format): (String, i64) = connection
            .query_row("SELECT id,format FROM vault_meta", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|_| "password_or_vault_invalid")?;
        if id != vault_id || format != 1 {
            return Err("vault_identity_or_format_mismatch");
        }
        Ok(Self { connection })
    }

    pub(crate) fn search(&self, arguments: &Value) -> Result<Value, &'static str> {
        let query = arguments.get("query").and_then(Value::as_str).unwrap_or("");
        let limit = arguments.get("limit").and_then(Value::as_u64).unwrap_or(50);
        if query.len() > 512 || !(1..=100).contains(&limit) {
            return Err("invalid_search_bounds");
        }
        let mut stmt = self
            .connection
            .prepare(
                "SELECT id,kind,name,location,username FROM records
             WHERE name LIKE ?1 OR location LIKE ?1 OR username LIKE ?1
             ORDER BY id LIMIT ?2",
            )
            .map_err(|_| "vault_read_failed")?;
        let rows = stmt
            .query_map(params![format!("%{query}%"), limit], |r| {
                Ok(
                    json!({"recordId":r.get::<_,String>(0)?, "type":r.get::<_,String>(1)?,
                "name":r.get::<_,String>(2)?, "location":r.get::<_,String>(3)?,
                "username":r.get::<_,String>(4)?}),
                )
            })
            .map_err(|_| "vault_read_failed")?;
        let records = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "vault_read_failed")?;
        Ok(json!({"records":records}))
    }

    pub(crate) fn read_fields(&self, arguments: &Value) -> Result<Value, &'static str> {
        let id = record_id(arguments)?;
        let fields = arguments
            .get("fields")
            .and_then(Value::as_array)
            .ok_or("fields_required")?;
        if fields.is_empty() || fields.len() > 8 {
            return Err("invalid_field_count");
        }
        let serialized: String = self
            .connection
            .query_row("SELECT secrets FROM records WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| "vault_read_failed")?
            .ok_or("record_not_found")?;
        let secrets: Value = serde_json::from_str(&serialized).map_err(|_| "vault_data_invalid")?;
        let mut output = serde_json::Map::new();
        for field in fields {
            let field = field.as_str().ok_or("invalid_field")?;
            if field.len() > 64 {
                return Err("invalid_field");
            }
            let value = secrets.get(field).ok_or("field_not_found")?;
            if value.as_str().is_none_or(|s| s.len() > MAX_SECRET) {
                return Err("secret_limit_exceeded");
            }
            output.insert(field.to_owned(), value.clone());
        }
        Ok(json!({"recordId":id,"fields":output}))
    }

    pub(crate) fn fixture_file(&self, encoded: &str) -> Result<(), &'static str> {
        if encoded.len() > MAX_FILE.div_ceil(3) * 4 {
            return Err("file_limit_exceeded");
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "invalid_fixture_file")?;
        if bytes.is_empty() || bytes.len() > MAX_FILE {
            return Err("file_limit_exceeded");
        }
        self.connection
            .execute(
                "INSERT INTO assets VALUES ('ssh-001',1,?1)
             ON CONFLICT(record_id) DO UPDATE SET version=version+1,bytes=excluded.bytes",
                [bytes],
            )
            .map_err(|_| "vault_write_failed")?;
        Ok(())
    }

    pub(crate) fn asset(&self, id: &str) -> Result<(i64, Vec<u8>), &'static str> {
        let result = self
            .connection
            .query_row(
                "SELECT version,bytes FROM assets WHERE record_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get::<_, Vec<u8>>(1)?)),
            )
            .optional()
            .map_err(|_| "vault_read_failed")?
            .ok_or("file_not_found")?;
        if result.1.is_empty() || result.1.len() > MAX_FILE {
            return Err("file_limit_exceeded");
        }
        Ok(result)
    }

    pub(crate) fn engine(&self) -> Result<Value, &'static str> {
        let cipher: String = self
            .connection
            .pragma_query_value(None, "cipher_version", |r| r.get(0))
            .map_err(|_| "encryption_engine_unavailable")?;
        Ok(json!({"sqlcipher":cipher,"sqlite":rusqlite::version()}))
    }
}

pub(crate) fn record_id(arguments: &Value) -> Result<&str, &'static str> {
    let id = arguments
        .get("recordId")
        .and_then(Value::as_str)
        .ok_or("record_id_required")?;
    if !crate::credential_auth::valid_id(id) {
        return Err("invalid_record_id");
    }
    Ok(id)
}
