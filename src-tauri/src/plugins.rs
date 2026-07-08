use rusqlite::{params, Connection};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read},
    path::Path,
};
use walkdir::WalkDir;
use zip::ZipArchive;

use super::{skill_id, utc_now, AppError, SkillScan};

#[derive(Debug, Clone)]
pub(crate) struct PluginScan {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) kind: String,
    pub(crate) install_command: String,
    pub(crate) update_command: Option<String>,
    pub(crate) source_path: String,
    pub(crate) source_excerpt: String,
    pub(crate) linked_skill_paths: Vec<String>,
}

pub(crate) fn scan_plugins_from_zip(
    bytes: &[u8],
    repo_name: &str,
    skills: &[SkillScan],
) -> Result<Vec<PluginScan>, AppError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader)?;
    let mut plugins = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if !file.is_file() {
            continue;
        }
        let relative = strip_zip_root(file.name());
        if !is_plugin_source_candidate(&relative) {
            continue;
        }
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        if contents.trim().is_empty() {
            continue;
        }
        plugins.extend(scan_plugins_from_source(
            &contents, &relative, repo_name, skills,
        )?);
    }
    Ok(dedupe_plugin_scans(plugins))
}

pub(crate) fn scan_plugins_from_directory(
    root: &Path,
    repo_name: &str,
    skills: &[SkillScan],
) -> Result<Vec<PluginScan>, AppError> {
    if !root.exists() || !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut plugins = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();
        if !is_plugin_source_candidate(&relative) {
            continue;
        }
        let contents = fs::read_to_string(entry.path())?;
        if contents.trim().is_empty() {
            continue;
        }
        plugins.extend(scan_plugins_from_source(
            &contents, &relative, repo_name, skills,
        )?);
    }
    Ok(dedupe_plugin_scans(plugins))
}

pub(crate) fn sync_plugins(
    conn: &Connection,
    repo_id: &str,
    repo_name: &str,
    detected_sha: &str,
    skills: &[SkillScan],
    plugins: &[PluginScan],
) -> Result<(), AppError> {
    let now = utc_now();
    let mut existing_stmt = conn.prepare("SELECT id FROM plugins WHERE repo_id = ?1")?;
    let existing_rows = existing_stmt.query_map(params![repo_id], |row| row.get::<_, String>(0))?;
    let mut existing_ids = HashSet::new();
    for row in existing_rows {
        existing_ids.insert(row?);
    }
    drop(existing_stmt);

    let mut seen_ids = HashSet::new();
    for scan in plugins {
        let id = plugin_id(repo_id, &scan.kind, &scan.name);
        seen_ids.insert(id.clone());
        conn.execute(
            "INSERT INTO plugins
             (id, repo_id, name, description, kind, install_command, update_command,
              source_path, source_excerpt, status, detected_sha, created_at, updated_at, search_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'detected', ?10, ?11, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              description = excluded.description,
              kind = excluded.kind,
              install_command = excluded.install_command,
              update_command = excluded.update_command,
              source_path = excluded.source_path,
              source_excerpt = excluded.source_excerpt,
              status = 'detected',
              detected_sha = excluded.detected_sha,
              search_text = excluded.search_text,
              updated_at = excluded.updated_at",
            params![
                id,
                repo_id,
                scan.name,
                if scan.description.trim().is_empty() {
                    format!("Plugin install entry detected in {repo_name}")
                } else {
                    scan.description.clone()
                },
                scan.kind,
                scan.install_command,
                scan.update_command,
                scan.source_path,
                scan.source_excerpt,
                detected_sha,
                now,
                scan.source_excerpt,
            ],
        )?;
        conn.execute(
            "DELETE FROM plugin_skill_links WHERE plugin_id = ?1",
            params![id],
        )?;
        let linked_paths = if scan.linked_skill_paths.is_empty() && scan.kind != "clawhub-skill" {
            skills.iter().map(|skill| skill.path.clone()).collect()
        } else {
            scan.linked_skill_paths.clone()
        };
        for path in linked_paths {
            let skill_id_value = skill_id(repo_id, &path);
            conn.execute(
                "INSERT OR IGNORE INTO plugin_skill_links (plugin_id, skill_id)
                 VALUES (?1, ?2)",
                params![id, skill_id_value],
            )?;
        }
    }

    for stale_id in existing_ids.difference(&seen_ids) {
        conn.execute(
            "UPDATE plugins
             SET status = 'source-unavailable',
                 updated_at = ?2
             WHERE id = ?1",
            params![stale_id, now],
        )?;
        conn.execute(
            "DELETE FROM plugin_skill_links WHERE plugin_id = ?1",
            params![stale_id],
        )?;
    }
    Ok(())
}

fn is_plugin_source_candidate(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let file_name = lower.rsplit('/').next().unwrap_or(lower.as_str());
    file_name.starts_with("readme.")
        || file_name == "plugin.json"
        || file_name == "plugins.json"
        || file_name == "marketplace.json"
        || (file_name.ends_with(".json")
            && (file_name.contains("plugin") || file_name.contains("marketplace")))
}

fn scan_plugins_from_source(
    contents: &str,
    source_path: &str,
    repo_name: &str,
    skills: &[SkillScan],
) -> Result<Vec<PluginScan>, AppError> {
    let mut plugins = if source_path.to_ascii_lowercase().ends_with(".json") {
        scan_structured_plugin_source(contents, source_path, repo_name, skills)?
    } else {
        Vec::new()
    };
    plugins.extend(scan_readme_plugin_commands(contents, source_path, skills));
    Ok(dedupe_plugin_scans(plugins))
}

fn scan_structured_plugin_source(
    contents: &str,
    source_path: &str,
    repo_name: &str,
    skills: &[SkillScan],
) -> Result<Vec<PluginScan>, AppError> {
    let json = serde_json::from_str::<Value>(contents).map_err(|err| {
        AppError::with_details(
            "plugin_manifest_invalid",
            "插件清单解析失败。",
            format!("{source_path}: {err}"),
        )
    })?;
    let values = if let Some(items) = json.as_array() {
        items.clone()
    } else if let Some(items) = json.get("plugins").and_then(|value| value.as_array()) {
        items.clone()
    } else {
        vec![json]
    };
    Ok(values
        .into_iter()
        .filter_map(|value| {
            let name = json_string_any(&value, &["name", "id", "pluginName"])
                .unwrap_or_else(|| repo_slug(repo_name));
            let install_command = json_string_any(
                &value,
                &["installCommand", "install_command", "install", "command"],
            )?;
            let description =
                json_string_any(&value, &["description", "summary"]).unwrap_or_default();
            let kind = json_string_any(&value, &["kind", "type", "provider"])
                .unwrap_or_else(|| "structured-plugin".to_string());
            Some(PluginScan {
                name,
                description,
                kind,
                install_command,
                update_command: json_string_any(
                    &value,
                    &["updateCommand", "update_command", "update"],
                ),
                source_path: source_path.to_string(),
                source_excerpt: concise_excerpt(contents, 0),
                linked_skill_paths: skills.iter().map(|skill| skill.path.clone()).collect(),
            })
        })
        .collect())
}

fn json_string_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
    })
}

pub(crate) fn scan_readme_plugin_commands(
    contents: &str,
    source_path: &str,
    skills: &[SkillScan],
) -> Vec<PluginScan> {
    let mut plugins: HashMap<(String, String), PluginScan> = HashMap::new();
    let lines: Vec<&str> = contents.lines().collect();
    for (index, raw_line) in lines.iter().enumerate() {
        let command = normalize_command_line(raw_line);
        if command.is_empty() {
            continue;
        }
        if command.starts_with("/plugin marketplace add ") {
            let repo = command
                .trim_start_matches("/plugin marketplace add ")
                .trim();
            let name = repo_slug(repo);
            upsert_plugin_scan(
                &mut plugins,
                PluginScan {
                    name,
                    description: "Codex plugin marketplace entry".into(),
                    kind: "codex-marketplace".into(),
                    install_command: command.clone(),
                    update_command: None,
                    source_path: source_path.to_string(),
                    source_excerpt: excerpt_around(&lines, index),
                    linked_skill_paths: skills.iter().map(|skill| skill.path.clone()).collect(),
                },
            );
        } else if command.starts_with("/plugin install ") {
            let target = command.trim_start_matches("/plugin install ").trim();
            let name = target
                .split('@')
                .next()
                .filter(|value| !value.is_empty())
                .unwrap_or(target)
                .to_string();
            upsert_plugin_scan(
                &mut plugins,
                PluginScan {
                    name,
                    description: "Codex plugin install entry".into(),
                    kind: "codex-marketplace".into(),
                    install_command: command.clone(),
                    update_command: None,
                    source_path: source_path.to_string(),
                    source_excerpt: excerpt_around(&lines, index),
                    linked_skill_paths: skills.iter().map(|skill| skill.path.clone()).collect(),
                },
            );
        } else if command.starts_with("npx skills add ") {
            let target = command.trim_start_matches("npx skills add ").trim();
            upsert_plugin_scan(
                &mut plugins,
                PluginScan {
                    name: repo_slug(target),
                    description: "Skills CLI repository install entry".into(),
                    kind: "skills-cli".into(),
                    install_command: command.clone(),
                    update_command: None,
                    source_path: source_path.to_string(),
                    source_excerpt: excerpt_around(&lines, index),
                    linked_skill_paths: skills.iter().map(|skill| skill.path.clone()).collect(),
                },
            );
        } else if command.starts_with("clawhub install ") {
            let package = command.trim_start_matches("clawhub install ").trim();
            let linked_skill_paths = match_skill_paths_for_package(package, skills);
            upsert_plugin_scan(
                &mut plugins,
                PluginScan {
                    name: package.to_string(),
                    description: "ClawHub single-Skill install entry".into(),
                    kind: "clawhub-skill".into(),
                    install_command: command.clone(),
                    update_command: None,
                    source_path: source_path.to_string(),
                    source_excerpt: excerpt_around(&lines, index),
                    linked_skill_paths,
                },
            );
        }
    }
    plugins.into_values().collect()
}

fn normalize_command_line(line: &str) -> String {
    let trimmed = line
        .trim()
        .trim_start_matches('#')
        .trim()
        .trim_start_matches('$')
        .trim();
    if trimmed.starts_with('`') && trimmed.ends_with('`') && trimmed.len() > 1 {
        trimmed.trim_matches('`').trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn upsert_plugin_scan(plugins: &mut HashMap<(String, String), PluginScan>, next: PluginScan) {
    let key = (next.kind.clone(), next.name.clone());
    if let Some(existing) = plugins.get_mut(&key) {
        if next.install_command.starts_with("/plugin install ") {
            existing.install_command = next.install_command;
        }
        if existing.source_excerpt.len() < next.source_excerpt.len() {
            existing.source_excerpt = next.source_excerpt;
        }
        merge_skill_paths(&mut existing.linked_skill_paths, &next.linked_skill_paths);
        if existing.description.is_empty() {
            existing.description = next.description;
        }
    } else {
        plugins.insert(key, next);
    }
}

fn merge_skill_paths(target: &mut Vec<String>, source: &[String]) {
    for path in source {
        if !target.contains(path) {
            target.push(path.clone());
        }
    }
}

fn dedupe_plugin_scans(scans: Vec<PluginScan>) -> Vec<PluginScan> {
    let mut plugins: HashMap<(String, String), PluginScan> = HashMap::new();
    for scan in scans {
        upsert_plugin_scan(&mut plugins, scan);
    }
    let mut items: Vec<PluginScan> = plugins.into_values().collect();
    items.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.name.cmp(&right.name))
    });
    items
}

fn match_skill_paths_for_package(package: &str, skills: &[SkillScan]) -> Vec<String> {
    let normalized_package = normalize_identifier(package);
    skills
        .iter()
        .filter(|skill| {
            normalize_identifier(&skill.name) == normalized_package
                || normalize_identifier(skill.path.rsplit('/').next().unwrap_or(&skill.path))
                    == normalized_package
        })
        .map(|skill| skill.path.clone())
        .collect()
}

fn plugin_id(repo_id: &str, kind: &str, name: &str) -> String {
    format!("{repo_id}:plugin:{}:{}", slugify(kind), slugify(name))
}

fn slugify(value: &str) -> String {
    let slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        "local".into()
    } else {
        slug
    }
}

fn normalize_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn repo_slug(value: &str) -> String {
    value
        .trim()
        .trim_end_matches(".git")
        .trim_start_matches("https://github.com/")
        .trim_start_matches("http://github.com/")
        .trim_start_matches("github.com/")
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .last()
        .unwrap_or(value)
        .trim()
        .to_string()
}

fn excerpt_around(lines: &[&str], index: usize) -> String {
    let start = index.saturating_sub(2);
    let end = (index + 3).min(lines.len());
    lines[start..end]
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn concise_excerpt(contents: &str, index: usize) -> String {
    let lines: Vec<&str> = contents.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    excerpt_around(&lines, index.min(lines.len() - 1))
}

fn strip_zip_root(name: &str) -> String {
    name.split_once('/')
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_else(|| name.to_string())
}
