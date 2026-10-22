//! The product vault has its own schema and never imports the E0 fixture rows.

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, fs, path::Path};

use crate::credential_store::{MAX_FILE, MAX_SECRET};

pub(crate) const MAX_RECORDS: usize = 1000;
const KINDS: [&str; 8] = [
    "website",
    "ssh",
    "tls",
    "database_instance",
    "database_user",
    "email",
    "api_token",
    "generic",
];
const METADATA: [&str; 17] = [
    "url",
    "host",
    "port",
    "username",
    "database",
    "engine",
    "email",
    "service",
    "purpose",
    "domain",
    "imapHost",
    "imapPort",
    "smtpHost",
    "smtpPort",
    "passwordKind",
    "expiresAt",
    "format",
];

pub(crate) struct VaultStore {
    pub(crate) connection: Connection,
}

fn err(_: impl std::fmt::Debug) -> &'static str {
    "vault_storage_failed"
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, &'static str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or("record_fields_invalid")
}

fn id(value: &Value) -> Result<&str, &'static str> {
    let id = text(value, "recordId")?;
    if !crate::credential_auth::valid_id(id) {
        return Err("invalid_record_id");
    }
    Ok(id)
}

fn fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "website" | "database_instance" | "database_user" | "email" => &["password"],
        "ssh" => &["privateKey", "passphrase"],
        "tls" => &["certificate", "privateKey", "chain", "passphrase"],
        "api_token" => &["token"],
        "generic" => &["value", "attachment"],
        _ => &[],
    }
}

fn file_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "ssh" => &["privateKey"],
        "tls" => &["certificate", "privateKey", "chain"],
        "generic" => &["attachment"],
        _ => &[],
    }
}

impl VaultStore {
    pub(crate) fn create(
        path: &Path,
        password: &str,
        vault_id: &str,
    ) -> Result<Self, &'static str> {
        if path.exists() {
            return Err("vault_already_exists");
        }
        let pending = path.with_extension("pending");
        if pending.exists() {
            crate::credential_ipc::private_path(&pending, false)?;
            fs::remove_file(&pending).map_err(err)?;
        }
        drop(crate::credential_ipc::create_private(&pending)?);
        let outcome = (|| {
            let connection = crate::credential_store::keyed(&pending, password)?;
            connection
                .execute_batch(
                    "BEGIN IMMEDIATE;
                CREATE TABLE vault_meta (id TEXT PRIMARY KEY, format INTEGER NOT NULL);
                CREATE TABLE credential_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL,
                    name TEXT NOT NULL, metadata TEXT NOT NULL, note TEXT NOT NULL,
                    secrets TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE credential_files (record_id TEXT NOT NULL, field TEXT NOT NULL,
                    name TEXT NOT NULL, bytes BLOB NOT NULL, text_readable INTEGER NOT NULL,
                    PRIMARY KEY(record_id,field));",
                )
                .map_err(err)?;
            connection
                .execute("INSERT INTO vault_meta VALUES (?1,2)", [vault_id])
                .map_err(err)?;
            connection.execute_batch("COMMIT").map_err(err)?;
            connection.close().map_err(|_| "vault_storage_failed")?;
            fs::rename(&pending, path).map_err(err)?;
            Self::unlock(path, password, vault_id)
        })();
        if outcome.is_err() && pending.exists() {
            crate::credential_ipc::private_path(&pending, false)?;
            fs::remove_file(&pending).map_err(err)?;
        }
        outcome
    }

    pub(crate) fn unlock(
        path: &Path,
        password: &str,
        vault_id: &str,
    ) -> Result<Self, &'static str> {
        let connection = crate::credential_store::keyed(path, password)?;
        let identity: (String, i64) = connection
            .query_row("SELECT id,format FROM vault_meta", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|_| "password_or_vault_invalid")?;
        if identity != (vault_id.to_owned(), 2) {
            return Err("vault_identity_or_format_mismatch");
        }
        Ok(Self { connection })
    }

    pub(crate) fn detail(&self, record_id: &str) -> Result<Value, &'static str> {
        let mut record: Value = self.connection.query_row(
            "SELECT id,kind,name,metadata,note,secrets,version,updated_at FROM credential_records WHERE id=?1",
            [record_id], |row| {
                let metadata: String = row.get(3)?;
                let secrets: String = row.get(5)?;
                Ok(json!({"recordId":row.get::<_,String>(0)?,"type":row.get::<_,String>(1)?,
                    "name":row.get::<_,String>(2)?,"metadata":metadata,"note":row.get::<_,String>(4)?,
                    "secretFields":secrets,"version":row.get::<_,i64>(6)?,"updatedAt":row.get::<_,String>(7)?}))
            }).optional().map_err(err)?.ok_or("record_not_found")?;
        record["metadata"] =
            serde_json::from_str(record["metadata"].as_str().ok_or("vault_data_invalid")?)
                .map_err(|_| "vault_data_invalid")?;
        let secrets: Map<String, Value> = serde_json::from_str(
            record["secretFields"]
                .as_str()
                .ok_or("vault_data_invalid")?,
        )
        .map_err(|_| "vault_data_invalid")?;
        let mut secret_fields: Vec<String> = secrets.keys().cloned().collect();
        let mut statement = self.connection.prepare(
            "SELECT field,name,length(bytes),text_readable,substr(bytes,1,160) FROM credential_files WHERE record_id=?1 ORDER BY field").map_err(err)?;
        let files = statement
            .query_map([record_id], |row| {
                let prefix: Vec<u8> = row.get(4)?;
                Ok(
                    json!({"field":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,
                "size":row.get::<_,u64>(2)?,"textReadable":row.get::<_,bool>(3)?,
                "formatHint":crate::credential_file_inspect::format_hint(&prefix)}),
                )
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        for file in &files {
            let field = file["field"]
                .as_str()
                .ok_or("vault_data_invalid")?
                .to_owned();
            if !secret_fields.contains(&field) {
                secret_fields.push(field);
            }
        }
        record["secretFields"] = json!(secret_fields);
        record["files"] = json!(files);
        Ok(record)
    }

    pub(crate) fn list(&self, request: &Value) -> Result<Value, &'static str> {
        let query = request.get("query").and_then(Value::as_str).unwrap_or("");
        let kind = request.get("type").and_then(Value::as_str).unwrap_or("");
        if query.len() > 512 || (!kind.is_empty() && !KINDS.contains(&kind)) {
            return Err("invalid_search_bounds");
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT id FROM credential_records WHERE (?1='' OR kind=?1)
             ORDER BY updated_at DESC,id LIMIT 1000",
            )
            .map_err(err)?;
        let ids = statement
            .query_map([kind], |row| row.get::<_, String>(0))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        let query = query.to_lowercase();
        let records = ids
            .iter()
            .map(|id| self.detail(id))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|record| {
                [record["name"].as_str(), record["note"].as_str()]
                    .into_iter()
                    .flatten()
                    .any(|value| value.to_lowercase().contains(&query))
                    || record["metadata"].as_object().is_some_and(|metadata| {
                        metadata
                            .values()
                            .filter_map(Value::as_str)
                            .any(|value| value.to_lowercase().contains(&query))
                    })
            })
            .collect::<Vec<_>>();
        Ok(json!({"records":records}))
    }

    pub(crate) fn version(&self, record_id: &str) -> Result<i64, &'static str> {
        self.connection
            .query_row(
                "SELECT version FROM credential_records WHERE id=?1",
                [record_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?
            .ok_or("record_not_found")
    }

    pub(crate) fn require_version<'a>(&self, request: &'a Value) -> Result<&'a str, &'static str> {
        let record_id = id(request)?;
        if request.get("expectedVersion").and_then(Value::as_i64) != Some(self.version(record_id)?)
        {
            return Err("record_version_conflict");
        }
        // Return the ID from the request, not a database borrowed buffer.
        Ok(record_id)
    }

    pub(crate) fn save(&self, request: &Value) -> Result<Value, &'static str> {
        let existing_id = request.get("recordId").and_then(Value::as_str);
        let record_id = if existing_id.is_some() {
            self.require_version(request)?.to_owned()
        } else {
            crate::credential_auth::random_id()?
        };
        let previous = if existing_id.is_some() {
            Some(self.detail(&record_id)?)
        } else {
            None
        };
        if previous.is_none() {
            let count: usize = self
                .connection
                .query_row("SELECT COUNT(*) FROM credential_records", [], |row| {
                    row.get(0)
                })
                .map_err(err)?;
            if count >= MAX_RECORDS {
                return Err("vault_record_limit");
            }
        }
        let kind = text(request, "type")?;
        let name = text(request, "name")?.trim();
        if !KINDS.contains(&kind) || name.is_empty() || name.chars().count() > 200 {
            return Err("record_name_or_type_invalid");
        }
        if previous
            .as_ref()
            .is_some_and(|old| old["type"].as_str() != Some(kind))
        {
            return Err("record_type_immutable");
        }
        let metadata = validate_metadata(request.get("metadata").ok_or("record_fields_invalid")?)?;
        let note = text(request, "note")?;
        if note.len() > 8192 {
            return Err("record_note_too_large");
        }
        let mut secrets: Map<String, Value> = if previous.is_some() {
            let serialized: String = self
                .connection
                .query_row(
                    "SELECT secrets FROM credential_records WHERE id=?1",
                    [&record_id],
                    |row| row.get(0),
                )
                .map_err(err)?;
            serde_json::from_str(&serialized).map_err(|_| "vault_data_invalid")?
        } else {
            Map::new()
        };
        let changes = request
            .get("secrets")
            .and_then(Value::as_object)
            .ok_or("record_fields_invalid")?;
        for (field, value) in changes {
            if !fields(kind).contains(&field.as_str()) {
                return Err("invalid_secret_field");
            }
            if kind == "generic" && field == "attachment" && !value.is_null() {
                return Err("record_files_invalid");
            }
            if value.is_null() {
                secrets.remove(field);
            } else {
                let value = value.as_str().ok_or("invalid_secret_field")?;
                if value.len() > MAX_SECRET {
                    return Err("secret_limit_exceeded");
                }
                secrets.insert(field.clone(), json!(value));
            }
        }
        let files = validate_files(request, kind)?;
        let retained_size: u64 = previous
            .as_ref()
            .and_then(|old| old["files"].as_array())
            .map(|assets| {
                assets
                    .iter()
                    .filter(|asset| {
                        asset["field"].as_str().is_some_and(|field| {
                            !changes.contains_key(field) && !files.contains_key(field)
                        })
                    })
                    .filter_map(|asset| asset["size"].as_u64())
                    .sum()
            })
            .unwrap_or(0);
        let imported_size: usize = files.values().map(|(_, bytes)| bytes.len()).sum();
        if retained_size.saturating_add(imported_size as u64) > MAX_FILE as u64 {
            return Err("file_limit_exceeded");
        }
        let mut present: Vec<String> = secrets
            .iter()
            .filter(|(_, v)| v.as_str().is_some_and(|s| !s.is_empty()))
            .map(|(k, _)| k.clone())
            .collect();
        if let Some(previous) = &previous {
            for file in previous["files"].as_array().ok_or("vault_data_invalid")? {
                let field = text(file, "field")?;
                if !changes.contains_key(field) {
                    present.push(field.to_owned());
                }
            }
        }
        present.extend(files.keys().cloned());
        validate_required(kind, &metadata, &present)?;
        if kind == "ssh"
            && !files.contains_key("privateKey")
            && !previous.as_ref().is_some_and(|old| {
                !changes.contains_key("privateKey")
                    && old["files"].as_array().is_some_and(|assets| {
                        assets.iter().any(|asset| asset["field"] == "privateKey")
                    })
            })
        {
            return Err("ssh_private_key_file_required");
        }
        let version = previous
            .as_ref()
            .and_then(|p| p["version"].as_i64())
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("record_version_exhausted")?;
        let transaction = self.connection.unchecked_transaction().map_err(err)?;
        transaction.execute("INSERT INTO credential_records VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,metadata=excluded.metadata,note=excluded.note,
            secrets=excluded.secrets,version=excluded.version,updated_at=excluded.updated_at",
            params![record_id,kind,name,serde_json::to_string(&metadata).map_err(err)?,note,
                serde_json::to_string(&secrets).map_err(err)?,version,chrono::Utc::now().to_rfc3339()]).map_err(err)?;
        for (field, value) in changes {
            if file_fields(kind).contains(&field.as_str()) && (value.is_null() || value.is_string())
            {
                transaction
                    .execute(
                        "DELETE FROM credential_files WHERE record_id=?1 AND field=?2",
                        params![record_id, field],
                    )
                    .map_err(err)?;
            }
        }
        for (field, (name, bytes)) in files {
            // A field is either a preserved byte asset or text, never two ambiguous values.
            secrets.remove(&field);
            transaction.execute("INSERT INTO credential_files VALUES (?1,?2,?3,?4,?5)
                ON CONFLICT(record_id,field) DO UPDATE SET name=excluded.name,bytes=excluded.bytes,text_readable=excluded.text_readable",
                params![record_id,field,name,bytes,std::str::from_utf8(&bytes).is_ok()]).map_err(err)?;
        }
        transaction
            .execute(
                "UPDATE credential_records SET secrets=?2 WHERE id=?1",
                params![record_id, serde_json::to_string(&secrets).map_err(err)?],
            )
            .map_err(err)?;
        transaction.commit().map_err(err)?;
        self.detail(&record_id)
    }

    pub(crate) fn delete(&self, request: &Value) -> Result<Value, &'static str> {
        let record_id = self.require_version(request)?;
        let transaction = self.connection.unchecked_transaction().map_err(err)?;
        transaction
            .execute(
                "DELETE FROM credential_files WHERE record_id=?1",
                [record_id],
            )
            .map_err(err)?;
        transaction
            .execute("DELETE FROM credential_records WHERE id=?1", [record_id])
            .map_err(err)?;
        transaction.commit().map_err(err)?;
        Ok(json!({"deleted":true}))
    }

    pub(crate) fn read_fields(&self, request: &Value) -> Result<Value, &'static str> {
        let record_id = id(request)?;
        let requested = request
            .get("fields")
            .and_then(Value::as_array)
            .ok_or("fields_required")?;
        if requested.is_empty() || requested.len() > 8 {
            return Err("invalid_field_count");
        }
        let (kind, serialized): (String, String) = self
            .connection
            .query_row(
                "SELECT kind,secrets FROM credential_records WHERE id=?1",
                [record_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(err)?
            .ok_or("record_not_found")?;
        let secrets: Map<String, Value> =
            serde_json::from_str(&serialized).map_err(|_| "vault_data_invalid")?;
        let mut output = Map::new();
        for value in requested {
            let field = value.as_str().ok_or("invalid_secret_field")?;
            if !fields(&kind).contains(&field) {
                return Err("invalid_secret_field");
            }
            let value = match secrets.get(field) {
                Some(value) => value.clone(),
                None => {
                    let bytes: Vec<u8> = self
                        .connection
                        .query_row(
                            "SELECT bytes FROM credential_files WHERE record_id=?1 AND field=?2",
                            params![record_id, field],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(err)?
                        .ok_or("field_not_found")?;
                    json!(String::from_utf8(bytes).map_err(|_| "file_not_text")?)
                }
            };
            output.insert(field.to_owned(), value);
        }
        Ok(json!({"recordId":record_id,"fields":output}))
    }

    #[cfg(test)]
    pub(crate) fn asset(&self, record_id: &str) -> Result<(i64, Vec<u8>), &'static str> {
        let (version, _, _, bytes) = self.asset_named(record_id, None)?;
        Ok((version, bytes))
    }

    pub(crate) fn asset_named(
        &self,
        record_id: &str,
        field: Option<&str>,
    ) -> Result<(i64, String, String, Vec<u8>), &'static str> {
        let version = self.version(record_id)?;
        let mut statement = self
            .connection
            .prepare("SELECT field,name,bytes FROM credential_files WHERE record_id=?1 AND (?2 IS NULL OR field=?2) ORDER BY field")
            .map_err(err)?;
        let files = statement
            .query_map(params![record_id, field], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        if files.len() != 1 {
            return Err(if files.is_empty() {
                "file_not_found"
            } else {
                "file_selection_required"
            });
        }
        let (field, name, bytes) = files.into_iter().next().ok_or("file_not_found")?;
        Ok((version, field, name, bytes))
    }

    pub(crate) fn validate_backup_contents(&self) -> Result<(), &'static str> {
        let mut statement = self
            .connection
            .prepare("SELECT id,kind,name,metadata,note,secrets,version FROM credential_records")
            .map_err(err)?;
        let mut rows = statement.query([]).map_err(err)?;
        while let Some(row) = rows.next().map_err(err)? {
            let id: String = row.get(0).map_err(err)?;
            let kind: String = row.get(1).map_err(err)?;
            let name: String = row.get(2).map_err(err)?;
            let metadata: String = row.get(3).map_err(err)?;
            let note: String = row.get(4).map_err(err)?;
            let serialized: String = row.get(5).map_err(err)?;
            let version: i64 = row.get(6).map_err(err)?;
            if !crate::credential_auth::valid_id(&id)
                || !KINDS.contains(&kind.as_str())
                || name.trim().is_empty()
                || name.chars().count() > 200
                || note.len() > 8192
                || version < 1
                || serialized.len() > 32 * 1024 * 1024
                || metadata.len() > 64 * 1024
            {
                return Err("backup_data_invalid");
            }
            let metadata = validate_metadata(&serde_json::from_str(&metadata).map_err(err)?)?;
            let secrets: Map<String, Value> = serde_json::from_str(&serialized).map_err(err)?;
            let mut present = Vec::new();
            for (field, value) in &secrets {
                let value = value.as_str().ok_or("backup_data_invalid")?;
                if !fields(&kind).contains(&field.as_str()) || value.len() > MAX_SECRET {
                    return Err("backup_data_invalid");
                }
                if !value.is_empty() {
                    present.push(field.clone());
                }
            }
            let detail = self.detail(&id)?;
            let assets = detail["files"].as_array().ok_or("backup_data_invalid")?;
            let mut total = 0u64;
            for asset in assets {
                let field = text(asset, "field")?;
                let name = text(asset, "name")?;
                let size = asset["size"].as_u64().ok_or("backup_data_invalid")?;
                total = total.checked_add(size).ok_or("backup_data_invalid")?;
                if !file_fields(&kind).contains(&field)
                    || secrets.contains_key(field)
                    || name.is_empty()
                    || name.len() > 255
                    || name.contains(['/', '\\', '\0'])
                    || size == 0
                    || total > MAX_FILE as u64
                {
                    return Err("backup_data_invalid");
                }
                present.push(field.to_owned());
            }
            if kind == "ssh" && !assets.iter().any(|asset| asset["field"] == "privateKey") {
                return Err("backup_data_invalid");
            }
            validate_required(&kind, &metadata, &present)?;
        }
        Ok(())
    }
}

fn validate_metadata(value: &Value) -> Result<BTreeMap<String, String>, &'static str> {
    let input = value.as_object().ok_or("record_fields_invalid")?;
    let mut output = BTreeMap::new();
    let mut total = 0usize;
    for (key, value) in input {
        let value = value.as_str().ok_or("record_fields_invalid")?.trim();
        if !METADATA.contains(&key.as_str()) || value.len() > 2048 {
            return Err("record_fields_invalid");
        }
        total = total
            .checked_add(value.len())
            .ok_or("record_fields_invalid")?;
        if total > 8192 {
            return Err("record_fields_invalid");
        }
        if ["port", "imapPort", "smtpPort"].contains(&key.as_str())
            && !value.is_empty()
            && value.parse::<u16>().ok().is_none_or(|port| port == 0)
        {
            return Err("record_port_invalid");
        }
        if ["host", "imapHost", "smtpHost"].contains(&key.as_str())
            && (value.contains(char::is_whitespace) || value.contains(['/', '@', '?', '#']))
        {
            return Err("record_host_invalid");
        }
        output.insert(key.clone(), value.to_owned());
    }
    if let Some(url) = output.get("url").filter(|value| !value.is_empty()) {
        let url = reqwest::Url::parse(url).map_err(|_| "record_url_invalid")?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("record_url_invalid");
        }
    }
    Ok(output)
}

fn validate_required(
    kind: &str,
    metadata: &BTreeMap<String, String>,
    present: &[String],
) -> Result<(), &'static str> {
    let required: &[&str] = match kind {
        "website" => &["url", "username"],
        "database_instance" => &["engine", "host", "port", "username"],
        "database_user" => &["engine", "host", "port", "username", "database"],
        "email" => &["email", "username"],
        _ => &[],
    };
    if required
        .iter()
        .any(|key| metadata.get(*key).is_none_or(|value| value.is_empty()))
    {
        return Err("record_required_fields_missing");
    }
    let required_secrets: &[&str] = match kind {
        "website" | "database_instance" | "database_user" | "email" => &["password"],
        "ssh" => &["privateKey"],
        "api_token" => &["token"],
        _ => &[],
    };
    if required_secrets
        .iter()
        .any(|key| !present.iter().any(|field| field == key))
        || (kind == "tls"
            && !present
                .iter()
                .any(|field| ["certificate", "privateKey"].contains(&field.as_str())))
        || (kind == "generic"
            && !present
                .iter()
                .any(|field| ["value", "attachment"].contains(&field.as_str())))
    {
        return Err("record_required_secret_missing");
    }
    Ok(())
}

fn validate_files(
    request: &Value,
    kind: &str,
) -> Result<BTreeMap<String, (String, Vec<u8>)>, &'static str> {
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    if let Some(input) = request.get("files") {
        let input = input.as_array().ok_or("record_files_invalid")?;
        if input.len() > 3 {
            return Err("record_files_invalid");
        }
        for item in input {
            let field = text(item, "field")?;
            let name = text(item, "name")?;
            let encoded = text(item, "bytesBase64")?;
            if !file_fields(kind).contains(&field)
                || files.contains_key(field)
                || name.is_empty()
                || name.len() > 255
                || name.contains(['/', '\\', '\0'])
            {
                return Err("record_files_invalid");
            }
            if encoded.len() > MAX_FILE.div_ceil(3) * 4 {
                return Err("file_limit_exceeded");
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "record_files_invalid")?;
            total = total
                .checked_add(bytes.len())
                .ok_or("file_limit_exceeded")?;
            if bytes.is_empty() || total > MAX_FILE {
                return Err("file_limit_exceeded");
            }
            files.insert(field.to_owned(), (name.to_owned(), bytes));
        }
    }
    Ok(files)
}

#[cfg(test)]
#[path = "credential_records_tests.rs"]
mod tests;
