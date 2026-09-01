use crate::plugins::{scan_plugins_from_zip, scan_readme_plugin_commands};

use super::*;
use std::{
    fs,
    io::{Cursor, Write},
};
use zip::{write::SimpleFileOptions, ZipWriter};

fn zip_with_file(path: &str, bytes: &[u8]) -> Vec<u8> {
    zip_with_files(&[(path, bytes)])
}

#[test]
fn gate_probe_clippy_warning() {
    let gate_is_open = true;
    let observed = if gate_is_open { true } else { false };
    assert!(observed);
}

fn zip_with_files(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut buffer);
        for (path, bytes) in files {
            writer
                .start_file(*path, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }
    buffer.into_inner()
}

fn verified_conflict_for_confirmation() -> SkillUpdateConflict {
    SkillUpdateConflict {
        id: "conflict-confirm".into(),
        skill_id: "skill-confirm".into(),
        task_id: "task-confirm".into(),
        status: "pending".into(),
        local_hash: "local-at-detection".into(),
        installed_hash: Some("installed-before-conflict".into()),
        remote_sha: "remote-sha".into(),
        remote_hash: "remote-hash".into(),
        verification_state: "customized".into(),
        verified_local_hash: Some("verified-local-hash".into()),
        created_at: "2026-08-28T00:00:00Z".into(),
        updated_at: "2026-08-28T00:00:00Z".into(),
        verified_at: Some("2026-08-28T00:00:00Z".into()),
        resolved_at: None,
    }
}

#[test]
fn parses_github_urls() {
    let parsed = parse_repo_input("https://github.com/openai/openai-cookbook.git").unwrap();
    assert_eq!(
        parsed,
        ("openai".to_string(), "openai-cookbook".to_string())
    );
}

#[test]
fn builds_repo_id_from_ref() {
    assert_eq!(
        repo_id("openai", "openai-cookbook", "main"),
        "github:openai/openai-cookbook:main"
    );
}

#[test]
fn hashes_empty_missing_directory_as_missing() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("none");
    assert_eq!(hash_directory(&missing).unwrap(), "missing");
}

#[cfg(unix)]
#[test]
fn skill_hash_rejects_root_and_nested_symlinks() {
    use std::os::unix::fs::symlink;

    let sandbox = tempfile::tempdir().unwrap();
    let real = sandbox.path().join("real-skill");
    fs::create_dir_all(&real).unwrap();
    fs::write(real.join("SKILL.md"), "name: real-skill").unwrap();

    let root_link = sandbox.path().join("root-link");
    symlink(&real, &root_link).unwrap();
    let root_error = hash_directory(&root_link).unwrap_err();
    assert_eq!(root_error.code, "skill_hash_symlink_unsupported");

    let nested_target = sandbox.path().join("outside.txt");
    fs::write(&nested_target, "outside").unwrap();
    symlink(&nested_target, real.join("linked.txt")).unwrap();
    let nested_error = hash_directory(&real).unwrap_err();
    assert_eq!(nested_error.code, "skill_hash_symlink_unsupported");
}

#[cfg(unix)]
#[test]
fn skill_hash_propagates_walkdir_errors_instead_of_hashing_partial_tree() {
    use std::os::unix::fs::PermissionsExt;

    let sandbox = tempfile::tempdir().unwrap();
    let skill = sandbox.path().join("skill");
    let unreadable = skill.join("unreadable");
    fs::create_dir_all(&unreadable).unwrap();
    fs::write(skill.join("SKILL.md"), "name: skill").unwrap();
    fs::write(unreadable.join("secret.txt"), "must not be skipped").unwrap();
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();

    let result = hash_directory(&skill);

    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o700)).unwrap();
    let error = result.expect_err("an unreadable subtree must fail the whole hash");
    assert_eq!(error.code, "skill_hash_walk_failed");
}

#[test]
fn skill_zip_content_hash_matches_extracted_directory_hash() {
    let zip = zip_with_files(&[
        (
            "example-demo/skills/demo/SKILL.md",
            b"name: demo-skill\ndescription: Demo\nversion: v1.0.0",
        ),
        ("example-demo/skills/demo/assets/prompt.md", b"prompt"),
        ("example-demo/README.md", b"repo readme"),
    ]);
    let scans = scan_skills_from_zip(&zip, "example/demo").unwrap();
    let root = tempfile::tempdir().unwrap();
    let dest = root.path().join("demo");
    let registry = TempArtifactRegistry::open(&root.path().join("registry.sqlite")).unwrap();
    let prepared =
        extract_skill_to_registered_temp(&zip, "skills/demo", &dest, "demo", &registry).unwrap();
    begin_registered_temp_replacement(prepared, &dest, &scans[0].content_hash)
        .unwrap()
        .commit()
        .unwrap();

    assert_eq!(scans.len(), 1);
    assert_eq!(scans[0].content_hash, hash_directory(&dest).unwrap());
}

#[test]
fn registered_zip_extract_replaces_atomically_and_rejects_archive_escape() {
    let sandbox = tempfile::tempdir().unwrap();
    let library = sandbox.path().join("library");
    let destination = library.join("demo-skill");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("old.txt"), "old").unwrap();
    let registry = TempArtifactRegistry::open(&sandbox.path().join("registry.sqlite")).unwrap();
    let zip = zip_with_files(&[
        (
            "example-demo/skills/demo/SKILL.md",
            b"name: demo-skill\ndescription: Demo\nversion: v1.0.0",
        ),
        ("example-demo/skills/demo/assets/prompt.md", b"prompt"),
    ]);

    let expected_hash = hash_skill_from_zip(&zip, "skills/demo").unwrap();
    let prepared = extract_skill_to_registered_temp(
        &zip,
        "skills/demo",
        &destination,
        "demo-skill",
        &registry,
    )
    .unwrap();
    let registered_container = prepared.path().to_path_buf();
    let installed_hash = begin_registered_temp_replacement(prepared, &destination, &expected_hash)
        .unwrap()
        .commit()
        .unwrap();

    assert!(destination.join("SKILL.md").is_file());
    assert!(destination.join("assets/prompt.md").is_file());
    assert!(!destination.join("old.txt").exists());
    assert!(!registered_container.exists());
    assert_eq!(installed_hash, expected_hash);

    let escape_zip = zip_with_file("example-demo/skills/demo/../../../../escape.txt", b"escape");
    let error = match extract_skill_to_registered_temp(
        &escape_zip,
        "skills/demo",
        &destination,
        "demo-skill",
        &registry,
    ) {
        Ok(_) => panic!("archive traversal must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.code, "zip_path_unsafe");
    assert!(!sandbox.path().join("escape.txt").exists());
    assert!(fs::read_dir(&library)
        .unwrap()
        .filter_map(Result::ok)
        .all(|entry| !entry.file_name().to_string_lossy().contains("install-tmp")));
}

#[test]
fn pending_replacement_rolls_back_files_when_main_database_commit_fails() {
    let sandbox = tempfile::tempdir().unwrap();
    let database_path = sandbox.path().join("tracker.sqlite");
    let registry = TempArtifactRegistry::open(&database_path).unwrap();
    let conn = Connection::open(&database_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE commit_gate (value TEXT);
             CREATE TRIGGER reject_commit_gate
             BEFORE INSERT ON commit_gate
             BEGIN SELECT RAISE(FAIL, 'forced main database failure'); END;",
    )
    .unwrap();
    let library = sandbox.path().join("library");
    let destination = library.join("demo-skill");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("SKILL.md"), "old").unwrap();
    let zip = zip_with_file("repo/skills/demo/SKILL.md", b"new");
    let expected_hash = hash_skill_from_zip(&zip, "skills/demo").unwrap();
    let prepared = extract_skill_to_registered_temp(
        &zip,
        "skills/demo",
        &destination,
        "demo-skill",
        &registry,
    )
    .unwrap();
    let temp_path = prepared.path().to_path_buf();
    let pending =
        begin_registered_temp_replacement(prepared, &destination, &expected_hash).unwrap();

    let error = commit_replacement_after_database(pending, || {
        let transaction = conn.unchecked_transaction()?;
        transaction.execute("INSERT INTO commit_gate (value) VALUES ('reject')", [])?;
        transaction.commit()?;
        Ok(())
    })
    .unwrap_err();

    assert_eq!(error.code, "sqlite_error");
    assert_eq!(
        fs::read_to_string(destination.join("SKILL.md")).unwrap(),
        "old"
    );
    assert!(!temp_path.exists());
    let registry_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM temp_artifacts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(registry_rows, 0);
}

#[test]
fn dropped_pending_replacement_preserves_registry_and_recovery_materials() {
    let sandbox = tempfile::tempdir().unwrap();
    let database_path = sandbox.path().join("tracker.sqlite");
    let registry = TempArtifactRegistry::open(&database_path).unwrap();
    let conn = Connection::open(&database_path).unwrap();
    let library = sandbox.path().join("library");
    let destination = library.join("demo-skill");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("SKILL.md"), "old").unwrap();
    let zip = zip_with_file("repo/skills/demo/SKILL.md", b"new");
    let expected_hash = hash_skill_from_zip(&zip, "skills/demo").unwrap();
    let prepared = extract_skill_to_registered_temp(
        &zip,
        "skills/demo",
        &destination,
        "demo-skill",
        &registry,
    )
    .unwrap();
    let temp_path = prepared.path().to_path_buf();
    let pending =
        begin_registered_temp_replacement(prepared, &destination, &expected_hash).unwrap();

    drop(pending);

    assert_eq!(
        fs::read_to_string(destination.join("SKILL.md")).unwrap(),
        "new"
    );
    assert_eq!(
        fs::read_to_string(temp_path.join("original/SKILL.md")).unwrap(),
        "old"
    );
    let state: String = conn
        .query_row(
            "SELECT state FROM temp_artifacts WHERE temp_path = ?1",
            params![path_string(&temp_path)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "recovery_required");
}

#[test]
fn sync_replacement_rolls_back_when_sync_record_transaction_fails() {
    let sandbox = tempfile::tempdir().unwrap();
    let database_path = sandbox.path().join("tracker.sqlite");
    let conn = Connection::open(&database_path).unwrap();
    migrate(&conn).unwrap();
    let registry = TempArtifactRegistry::open(&database_path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_sync_record
             BEFORE INSERT ON skill_sync_records
             BEGIN SELECT RAISE(FAIL, 'forced sync record failure'); END;",
    )
    .unwrap();
    let source = sandbox.path().join("source");
    let target_root = sandbox.path().join("target");
    let destination = target_root.join("demo-skill");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("SKILL.md"), "new sync content").unwrap();
    let source_hash = hash_directory(&source).unwrap();
    let prepared = prepare_dir_replacement_from_source(
        &source,
        &destination,
        "codex",
        "demo-skill",
        5,
        &registry,
    )
    .unwrap();

    let error = commit_prepared_sync_replacement(
        &conn,
        prepared,
        "skill-sync-failure",
        "codex",
        &target_root,
        &destination,
        &source_hash,
    )
    .unwrap_err();

    assert_eq!(error.code, "sqlite_error");
    assert!(!destination.exists());
    let registry_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM temp_artifacts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(registry_rows, 0);
}

#[test]
fn strips_zip_root() {
    assert_eq!(
        strip_zip_root("owner-repo-sha/skills/demo/SKILL.md"),
        "skills/demo/SKILL.md"
    );
}

#[test]
fn extracts_markdown_metadata() {
    let contents = "---\nname: demo-skill\ndescription: Demo skill\n---";
    assert_eq!(
        extract_markdown_field(contents, "name"),
        Some("demo-skill".to_string())
    );
    assert_eq!(
        extract_markdown_field(contents, "description"),
        Some("Demo skill".to_string())
    );
}

#[test]
fn uses_skill_repo_tracker_default_library_root() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        default_skill_library_root(home.path()),
        home.path().join("SkillRepoTracker").join("skills")
    );
}

#[test]
fn migrates_legacy_auto_sync_targets_to_claude_and_codex() {
    let home = tempfile::tempdir().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    fs::create_dir_all(home.path().join(".gemini").join("skills")).unwrap();
    fs::create_dir_all(home.path().join(".hermes").join("skills")).unwrap();
    set_setting(
        &conn,
        "default_sync_targets",
        serialize_sync_targets(&["gemini".to_string(), "hermes".to_string()]),
    )
    .unwrap();

    migrate_default_sync_targets(&conn, home.path()).unwrap();

    assert_eq!(
        sync_targets_from_db(&conn).unwrap(),
        vec!["claude".to_string(), "codex".to_string()]
    );
    assert_eq!(
        get_setting(&conn, "default_sync_targets_v111").unwrap(),
        Some("true".to_string())
    );
}

#[test]
fn preserves_explicit_sync_targets_during_v111_migration() {
    let home = tempfile::tempdir().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    fs::create_dir_all(home.path().join(".gemini").join("skills")).unwrap();
    set_setting(
        &conn,
        "default_sync_targets",
        serialize_sync_targets(&["claude".to_string(), "gemini".to_string()]),
    )
    .unwrap();

    migrate_default_sync_targets(&conn, home.path()).unwrap();

    assert_eq!(
        sync_targets_from_db(&conn).unwrap(),
        vec!["claude".to_string(), "gemini".to_string()]
    );
}

fn repo_record_with_source(source_type: &str) -> RepoRecord {
    RepoRecord {
        id: format!("{source_type}:repo"),
        name: LOCAL_SKILLS_LIBRARY_NAME.into(),
        owner: "local".into(),
        repo: "skills".into(),
        ref_name: "local".into(),
        repo_type: "skill".into(),
        skills_count: 0,
        remote_sha: "local".into(),
        last_backup_sha: None,
        last_checked: None,
        backup_status: "local-only".into(),
        check_status: "success".into(),
        url: "file:///tmp/skills".into(),
        branch: "local".into(),
        backup_path: None,
        snapshot_time: None,
        source_type: source_type.into(),
        local_path: Some("/tmp/skills".into()),
        github_account_id: None,
        created_at: "2026-07-01T00:00:00Z".into(),
        readme_search_text: String::new(),
    }
}

#[test]
fn remote_check_skips_local_repositories() {
    let local_repo = repo_record_with_source("local");
    let github_repo = repo_record_with_source("github");

    assert!(!should_check_remote_repo(&local_repo, None));
    assert!(should_check_remote_repo(&github_repo, None));

    let selected = vec![local_repo.id.clone(), github_repo.id.clone()];
    assert!(!should_check_remote_repo(&local_repo, Some(&selected)));
    assert!(should_check_remote_repo(&github_repo, Some(&selected)));
}

#[test]
fn copies_legacy_skills_root_to_independent_library() {
    let home = tempfile::tempdir().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let backup_root = home.path().join("SkillRepoBackups");
    let legacy_root = home.path().join(".codex").join("skills");
    let target_root = home.path().join("SkillRepoTracker").join("skills");
    let legacy_skill = legacy_root.join("demo-skill");
    fs::create_dir_all(&legacy_skill).unwrap();
    fs::write(legacy_skill.join("SKILL.md"), "name: demo-skill").unwrap();
    seed_settings(&conn, home.path(), &backup_root, &target_root).unwrap();
    set_setting(&conn, "skills_root", path_string(&legacy_root)).unwrap();
    conn.execute(
        "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
              backup_status, check_status, url, branch, source_type, created_at, updated_at)
             VALUES ('local:installed:test', 'Local Skills Library', 'local', 'skills', 'local',
              'skill repo', 1, 'local', 'local-only', 'success', 'file:///tmp/skills',
              'local', 'local', ?1, ?1)",
        params![utc_now()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, local_version,
              remote_version, status, installed, updated_at, source_type, install_path)
             VALUES ('skill-1', 'local:installed:test', 'demo-skill', '', 'Local Skills Library',
              'demo-skill', 'local', 'local', 'local', 'installed-latest', 1, ?1,
              'installed_local', ?2)",
        params![utc_now(), path_string(&legacy_skill)],
    )
    .unwrap();

    migrate_independent_skill_library(
        &conn,
        home.path(),
        &target_root,
        Some(&path_string(&legacy_root)),
        false,
    )
    .unwrap();

    assert_eq!(
        get_setting(&conn, "skill_library_root").unwrap(),
        Some(path_string(&target_root))
    );
    assert!(legacy_skill.exists());
    assert!(target_root.join("demo-skill").join("SKILL.md").exists());
    let expected_install_path = path_string(&target_root.join("demo-skill"));
    assert_eq!(
        load_ui_skills(&conn).unwrap()[0].install_path.as_deref(),
        Some(expected_install_path.as_str())
    );
}

#[test]
fn keeps_existing_library_setting_during_migration() {
    let home = tempfile::tempdir().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let existing_library = home.path().join("ExistingLibrary");
    set_setting(&conn, "skill_library_root", path_string(&existing_library)).unwrap();

    migrate_independent_skill_library(
        &conn,
        home.path(),
        &home.path().join("SkillRepoTracker").join("skills"),
        Some(&path_string(&home.path().join("LegacySkills"))),
        true,
    )
    .unwrap();

    assert_eq!(
        get_setting(&conn, "skill_library_root").unwrap(),
        Some(path_string(&existing_library))
    );
}

#[test]
fn validates_and_creates_writable_directory() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("backup-root");
    let validation = validate_directory_path("backupRoot", &path_string(&target));
    assert!(validation.writable);
    assert!(target.is_dir());
}

#[test]
fn scans_local_skill_directories() {
    let root = tempfile::tempdir().unwrap();
    let skill_dir = root.path().join("demo-skill");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo-skill\ndescription: Local demo\nversion: v1.2.3\n---",
    )
    .unwrap();
    fs::write(root.path().join("README.md"), "Repository README marker").unwrap();
    assert!(read_local_readme_search(root.path()).contains("Repository README marker"));
    let scans = scan_skills_from_directory(root.path(), "Local Skills").unwrap();
    assert_eq!(scans.len(), 1);
    assert_eq!(scans[0].name, "demo-skill");
    assert_eq!(scans[0].path, "demo-skill");
    assert_eq!(scans[0].version, "v1.2.3");
}

#[test]
fn detects_baoyu_style_plugin_entries_from_readme() {
    let skills = vec![
        SkillScan {
            name: "baoyu-image-gen".into(),
            description: "image".into(),
            path: "skills/baoyu-image-gen".into(),
            version: "v1.0.0".into(),
            content_hash: "hash-baoyu-image-gen".into(),
            search_text: "image".into(),
        },
        SkillScan {
            name: "baoyu-research".into(),
            description: "research".into(),
            path: "skills/baoyu-research".into(),
            version: "v1.0.0".into(),
            content_hash: "hash-baoyu-research".into(),
            search_text: "research".into(),
        },
    ];
    let readme = r#"
# Baoyu Skills

```bash
npx skills add jimliu/baoyu-skills
/plugin marketplace add JimLiu/baoyu-skills
/plugin install baoyu-skills@baoyu-skills
clawhub install baoyu-image-gen
```
"#;

    let plugins = scan_readme_plugin_commands(readme, "README.zh.md", &skills);

    assert_eq!(
        plugins
            .iter()
            .filter(|plugin| plugin.kind == "codex-marketplace")
            .count(),
        1
    );
    let marketplace = plugins
        .iter()
        .find(|plugin| plugin.kind == "codex-marketplace")
        .unwrap();
    assert_eq!(marketplace.name, "baoyu-skills");
    assert_eq!(
        marketplace.install_command,
        "/plugin install baoyu-skills@baoyu-skills"
    );
    assert_eq!(marketplace.linked_skill_paths.len(), 2);

    let clawhub = plugins
        .iter()
        .find(|plugin| plugin.kind == "clawhub-skill")
        .unwrap();
    assert_eq!(clawhub.name, "baoyu-image-gen");
    assert_eq!(
        clawhub.linked_skill_paths,
        vec!["skills/baoyu-image-gen".to_string()]
    );
    assert!(plugins.iter().any(|plugin| plugin.kind == "skills-cli"));
}

#[test]
fn plain_readme_without_plugin_commands_does_not_create_plugins() {
    let plugins = scan_readme_plugin_commands(
        "# Demo\n\nThis repository contains one SKILL.md file.",
        "README.md",
        &[],
    );

    assert!(plugins.is_empty());
}

#[test]
fn invalid_zip_does_not_become_empty_plugin_scan() {
    let scans = vec![SkillScan {
        name: "demo-skill".into(),
        description: "demo".into(),
        path: "skills/demo-skill".into(),
        version: "v1.0.0".into(),
        content_hash: "hash-demo-skill".into(),
        search_text: "demo".into(),
    }];
    assert!(scan_plugins_from_zip(b"not a zip", "example/demo", &scans).is_err());
}

#[test]
fn invalid_plugin_manifest_does_not_become_empty_plugin_scan() {
    let zip = zip_with_file("example-demo/plugin.json", br#"{"plugins": ["#);
    let error = scan_plugins_from_zip(&zip, "example/demo", &[]).unwrap_err();
    assert_eq!(error.code, "plugin_manifest_invalid");
}

#[test]
fn invalid_skill_markdown_in_zip_does_not_become_fallback_skill() {
    let zip = zip_with_file("example-demo/skills/demo/SKILL.md", &[0xff, 0xfe, 0xfd]);
    assert!(scan_skills_from_zip(&zip, "example/demo").is_err());
}

#[test]
fn extracts_readme_search_text_from_zip() {
    let zip = zip_with_file(
        "example-demo/README.md",
        b"# Demo\n\nUnique README search marker.",
    );
    assert!(readme_search_from_zip(&zip).contains("Unique README search marker"));
}

#[test]
fn saves_plugin_entries_and_skill_links() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = RemoteInfo {
        owner: "JimLiu".into(),
        repo: "baoyu-skills".into(),
        full_name: "JimLiu/baoyu-skills".into(),
        default_branch: "main".into(),
        resolved_ref: "main".into(),
        sha: "bf4e9ac4d4428bda261afcfe981871ceb92d94e6".into(),
    };
    let scans = vec![SkillScan {
        name: "baoyu-image-gen".into(),
        description: "image".into(),
        path: "skills/baoyu-image-gen".into(),
        version: "v1.0.0".into(),
        content_hash: "hash-baoyu-image-gen".into(),
        search_text: "image".into(),
    }];
    let plugins = vec![PluginScan {
        name: "baoyu-skills".into(),
        description: "Codex plugin marketplace entry".into(),
        kind: "codex-marketplace".into(),
        install_command: "/plugin install baoyu-skills@baoyu-skills".into(),
        update_command: None,
        source_path: "README.zh.md".into(),
        source_excerpt: "/plugin install baoyu-skills@baoyu-skills".into(),
        linked_skill_paths: vec!["skills/baoyu-image-gen".into()],
    }];

    let repo_id_value =
        save_repository_with_plugins(&conn, &remote, &scans, &plugins, None, "").unwrap();
    let repo = load_ui_repositories(&conn)
        .unwrap()
        .into_iter()
        .find(|item| item.id == repo_id_value)
        .unwrap();
    assert_eq!(repo.recognized_plugins.len(), 1);
    assert_eq!(repo.recognized_plugins[0].skill_count, 1);

    let plugin = load_ui_plugins(&conn).unwrap().pop().unwrap();
    assert_eq!(plugin.name, "baoyu-skills");
    assert_eq!(plugin.skill_count, 1);
    let linked = plugin_linked_skills(&conn, &plugin.id).unwrap();
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].name, "baoyu-image-gen");
    let skill_plugins =
        plugin_references_for_skill(&conn, &skill_id(&repo_id_value, "skills/baoyu-image-gen"))
            .unwrap();
    assert_eq!(skill_plugins.len(), 1);
}

#[test]
fn saves_installed_local_skills_as_deletable() {
    let root = tempfile::tempdir().unwrap();
    let skill_dir = root.path().join("demo-skill");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), "name: demo-skill").unwrap();
    let scans = scan_skills_from_directory(root.path(), "Local Skills").unwrap();
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    save_local_repository(&conn, root.path(), &scans, true).unwrap();
    let skills = load_ui_skills(&conn).unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].source_type, "installed_local");
    assert!(skills[0].installed);
    assert!(skills[0].can_delete);
    let expected_install_path = path_string(&skill_dir.canonicalize().unwrap());
    assert_eq!(
        skills[0].install_path.as_deref(),
        Some(expected_install_path.as_str())
    );
}

#[test]
fn recognized_skills_excludes_stale_skills_after_rescan() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = RemoteInfo {
        owner: "example-org".into(),
        repo: "icon-generator-skill".into(),
        full_name: "example-org/icon-generator-skill".into(),
        default_branch: "main".into(),
        resolved_ref: "main".into(),
        sha: "bf4e9ac4d4428bda261afcfe981871ceb92d94e6".into(),
    };
    let initial_scans = vec![
        SkillScan {
            name: "stale-example-skill".into(),
            description: "stale duplicate from previous scan".into(),
            path: "skills/stale-example-skill".into(),
            version: "0.2.0".into(),
            content_hash: "hash-stale-example-skill".into(),
            search_text: "stale duplicate from previous scan".into(),
        },
        SkillScan {
            name: "icon-generator".into(),
            description: "current skill".into(),
            path: ".".into(),
            version: "v0.1.0".into(),
            content_hash: "hash-icon-generator".into(),
            search_text: "current skill".into(),
        },
    ];
    let current_scans = vec![SkillScan {
        name: "icon-generator".into(),
        description: "current skill".into(),
        path: ".".into(),
        version: "v0.1.0".into(),
        content_hash: "hash-icon-generator".into(),
        search_text: "current skill".into(),
    }];

    save_repository_with_account(&conn, &remote, &initial_scans, None, "").unwrap();
    save_repository_with_account(&conn, &remote, &current_scans, None, "").unwrap();

    let repos = load_ui_repositories(&conn).unwrap();
    let repo = repos
        .iter()
        .find(|item| item.id == repo_id("example-org", "icon-generator-skill", "main"))
        .unwrap();
    assert_eq!(repo.skills, 1);
    assert_eq!(repo.recognized_skills.len(), 1);
    assert_eq!(repo.recognized_skills[0].name, "icon-generator");
    assert_eq!(repo.recognized_skills[0].path, ".");

    let skills = load_ui_skills(&conn).unwrap();
    assert!(skills
        .iter()
        .any(|skill| skill.name == "stale-example-skill" && skill.status == "source-unavailable"));
}

fn remote_for_skill_sync_status() -> RemoteInfo {
    RemoteInfo {
        owner: "example-org".into(),
        repo: "demo-skills".into(),
        full_name: "example-org/demo-skills".into(),
        default_branch: "main".into(),
        resolved_ref: "main".into(),
        sha: "bf4e9ac4d4428bda261afcfe981871ceb92d94e6".into(),
    }
}

fn sync_status_scan(version: &str, content_hash: &str) -> Vec<SkillScan> {
    vec![SkillScan {
        name: "demo-skill".into(),
        description: "current skill".into(),
        path: "skills/demo-skill".into(),
        version: version.into(),
        content_hash: content_hash.into(),
        search_text: "current skill".into(),
    }]
}

#[test]
fn sync_skills_marks_installed_latest_when_remote_hash_matches() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = remote_for_skill_sync_status();
    let scans = sync_status_scan("v1.0.0", "hash-current");
    let repo_id_value = save_repository_with_account(&conn, &remote, &scans, None, "").unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'update-available',
                 local_version = 'v1.0.0',
                 remote_version = 'v1.0.0',
                 installed_hash = 'hash-current'
             WHERE id = ?1",
        params![id],
    )
    .unwrap();

    save_repository_with_account(&conn, &remote, &scans, None, "").unwrap();

    let skill = load_ui_skills(&conn)
        .unwrap()
        .into_iter()
        .find(|skill| skill.id == id)
        .unwrap();
    assert_eq!(skill.status, "installed-latest");
    assert_eq!(skill.local_version, "v1.0.0");
}

#[test]
fn sync_skills_marks_update_available_only_when_remote_hash_differs() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = remote_for_skill_sync_status();
    let initial_scans = sync_status_scan("v1.0.0", "hash-old");
    let repo_id_value =
        save_repository_with_account(&conn, &remote, &initial_scans, None, "").unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'installed-latest',
                 local_version = 'v1.0.0',
                 remote_version = 'v1.0.0',
                 installed_hash = 'hash-old'
             WHERE id = ?1",
        params![id],
    )
    .unwrap();
    let changed_scans = sync_status_scan("v2.0.0", "hash-new");

    save_repository_with_account(&conn, &remote, &changed_scans, None, "").unwrap();

    let skill = load_ui_skills(&conn)
        .unwrap()
        .into_iter()
        .find(|skill| skill.id == id)
        .unwrap();
    assert_eq!(skill.status, "update-available");
    assert_eq!(skill.local_version, "v1.0.0");
    assert_eq!(skill.remote_version, "v2.0.0");
}

#[test]
fn sync_skills_preserves_local_modified_status() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = remote_for_skill_sync_status();
    let initial_scans = sync_status_scan("v1.0.0", "hash-old");
    let repo_id_value =
        save_repository_with_account(&conn, &remote, &initial_scans, None, "").unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'local-modified',
                 local_version = 'v1.0.0',
                 remote_version = 'v1.0.0',
                 installed_hash = 'hash-old'
             WHERE id = ?1",
        params![id],
    )
    .unwrap();
    let changed_scans = sync_status_scan("v2.0.0", "hash-new");

    save_repository_with_account(&conn, &remote, &changed_scans, None, "").unwrap();

    let skill = load_ui_skills(&conn)
        .unwrap()
        .into_iter()
        .find(|skill| skill.id == id)
        .unwrap();
    assert_eq!(skill.status, "local-modified");
    assert_eq!(skill.local_version, "v1.0.0");
    assert_eq!(skill.remote_version, "v2.0.0");
}

#[test]
fn sync_skills_records_remote_hash_and_preserves_update_conflict() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = remote_for_skill_sync_status();
    let initial_scans = sync_status_scan("v1.0.0", "hash-old");
    let repo_id_value =
        save_repository_with_account(&conn, &remote, &initial_scans, None, "").unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'update-conflict',
                 installed_hash = 'installed-hash',
                 handled_remote_sha = 'handled-sha',
                 handled_remote_hash = 'handled-hash'
             WHERE id = ?1",
        params![id],
    )
    .unwrap();

    let changed_scans = sync_status_scan("v2.0.0", "hash-new");
    save_repository_with_account(&conn, &remote, &changed_scans, None, "").unwrap();

    let skill = load_ui_skills(&conn)
        .unwrap()
        .into_iter()
        .find(|skill| skill.id == id)
        .unwrap();
    assert_eq!(skill.status, "update-conflict");
    assert_eq!(skill.remote_hash.as_deref(), Some("hash-new"));
    assert_eq!(skill.handled_remote_sha.as_deref(), Some("handled-sha"));
    assert_eq!(skill.handled_remote_hash.as_deref(), Some("handled-hash"));
}

#[test]
fn sync_skills_preserves_handled_customization_and_conflicts_on_new_remote() {
    struct Case {
        name: &'static str,
        initial_status: &'static str,
        installed_hash: &'static str,
        handled_sha: &'static str,
        handled_hash: &'static str,
        incoming_sha: &'static str,
        incoming_hash: &'static str,
        expected_status: &'static str,
    }
    let cases = [
        Case {
            name: "same handled latest",
            initial_status: "installed-latest",
            installed_hash: "remote-v1",
            handled_sha: "sha-v1",
            handled_hash: "remote-v1",
            incoming_sha: "sha-v1",
            incoming_hash: "remote-v1",
            expected_status: "installed-latest",
        },
        Case {
            name: "same handled customized",
            initial_status: "installed-customized",
            installed_hash: "custom-baseline",
            handled_sha: "sha-v1",
            handled_hash: "remote-v1",
            incoming_sha: "sha-v1",
            incoming_hash: "remote-v1",
            expected_status: "installed-customized",
        },
        Case {
            name: "new remote customized",
            initial_status: "installed-customized",
            installed_hash: "custom-baseline",
            handled_sha: "sha-v1",
            handled_hash: "remote-v1",
            incoming_sha: "sha-v2",
            incoming_hash: "remote-v2",
            expected_status: "update-conflict",
        },
        Case {
            name: "new remote adopts customized baseline",
            initial_status: "installed-customized",
            installed_hash: "custom-baseline",
            handled_sha: "sha-v1",
            handled_hash: "remote-v1",
            incoming_sha: "sha-v2",
            incoming_hash: "custom-baseline",
            expected_status: "installed-latest",
        },
        Case {
            name: "new remote clean latest",
            initial_status: "installed-latest",
            installed_hash: "remote-v1",
            handled_sha: "sha-v1",
            handled_hash: "remote-v1",
            incoming_sha: "sha-v2",
            incoming_hash: "remote-v2",
            expected_status: "update-available",
        },
    ];

    for case in cases {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let mut initial_remote = remote_for_skill_sync_status();
        initial_remote.sha = "sha-v1".into();
        let repo_id_value = save_repository_with_account(
            &conn,
            &initial_remote,
            &sync_status_scan("v1.0.0", "remote-v1"),
            None,
            "",
        )
        .unwrap();
        let id = skill_id(&repo_id_value, "skills/demo-skill");
        conn.execute(
            "UPDATE skills
                 SET installed = 1,
                     status = ?2,
                     installed_hash = ?3,
                     handled_remote_sha = ?4,
                     handled_remote_hash = ?5
                 WHERE id = ?1",
            params![
                id,
                case.initial_status,
                case.installed_hash,
                case.handled_sha,
                case.handled_hash
            ],
        )
        .unwrap();
        let mut incoming = initial_remote.clone();
        incoming.sha = case.incoming_sha.into();

        sync_skills(
            &conn,
            &incoming,
            &repo_id_value,
            &sync_status_scan("v2.0.0", case.incoming_hash),
        )
        .unwrap();

        let status: String = conn
            .query_row(
                "SELECT status FROM skills WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, case.expected_status, "{}", case.name);
    }
}

#[test]
fn conflict_detection_persists_waiting_user_state_before_update_side_effects() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = remote_for_skill_sync_status();
    let scans = sync_status_scan("v2.0.0", "remote-hash");
    let repo_id_value = save_repository_with_account(&conn, &remote, &scans, None, "").unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'update-available',
                 installed_hash = 'installed-hash'
             WHERE id = ?1",
        params![id],
    )
    .unwrap();
    let skill = load_skill_record(&conn, &id).unwrap().unwrap();
    let repo = load_repository(&conn, &repo_id_value).unwrap().unwrap();

    let conflict =
        persist_skill_update_conflict(&conn, &skill, &repo, "customized-local-hash").unwrap();

    assert_eq!(conflict.skill_id, id);
    assert_eq!(conflict.status, "pending");
    assert_eq!(conflict.local_hash, "customized-local-hash");
    assert_eq!(conflict.installed_hash.as_deref(), Some("installed-hash"));
    assert_eq!(conflict.remote_sha, remote.sha);
    assert_eq!(conflict.remote_hash, "remote-hash");
    assert_eq!(conflict.verification_state, "pending");
    assert_eq!(load_ui_skills(&conn).unwrap()[0].status, "update-conflict");

    let task = load_ui_tasks(&conn).unwrap().pop().unwrap();
    assert_eq!(task.id, conflict.task_id);
    assert_eq!(task.status, "waiting-user");
    assert!(task.summary.contains("使用 Agent 工具处理"));
    assert!(task
        .log
        .iter()
        .any(|line| { line.contains("未下载、未备份、未覆盖、未同步") }));
    assert!(!task.retryable);
    let completed_at: Option<String> = conn
        .query_row(
            "SELECT completed_at FROM backup_jobs WHERE id = ?1",
            params![conflict.task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(completed_at.is_none());

    record_skill_update_conflict_verification(
        &conn,
        &conflict,
        "unchanged",
        Some("customized-local-hash"),
    )
    .unwrap();
    let unchanged_task = load_ui_tasks(&conn).unwrap().pop().unwrap();
    assert!(unchanged_task.summary.contains("继续使用 Agent 工具处理"));
    assert!(!unchanged_task.summary.contains("显式确认"));

    record_skill_update_conflict_verification(
        &conn,
        &conflict,
        "customized",
        Some("customized-again"),
    )
    .unwrap();
    let customized_task = load_ui_tasks(&conn).unwrap().pop().unwrap();
    assert!(customized_task.summary.contains("等待用户显式确认"));
}

#[test]
fn repeated_conflict_detection_reuses_active_conflict_and_waiting_task() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = remote_for_skill_sync_status();
    let scans = sync_status_scan("v2.0.0", "remote-hash");
    let repo_id_value = save_repository_with_account(&conn, &remote, &scans, None, "").unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'update-available',
                 installed_hash = 'installed-hash'
             WHERE id = ?1",
        params![id],
    )
    .unwrap();

    let skill = load_skill_record(&conn, &id).unwrap().unwrap();
    let repo = load_repository(&conn, &repo_id_value).unwrap().unwrap();
    let first =
        persist_skill_update_conflict(&conn, &skill, &repo, "first-customized-hash").unwrap();
    let skill = load_skill_record(&conn, &id).unwrap().unwrap();
    let second =
        persist_skill_update_conflict(&conn, &skill, &repo, "later-customized-hash").unwrap();

    assert_eq!(second.id, first.id);
    assert_eq!(second.task_id, first.task_id);
    assert_eq!(second.local_hash, "first-customized-hash");
    assert_eq!(second.status, "pending");
    let pending_conflicts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM skill_update_conflicts
                 WHERE skill_id = ?1 AND status = 'pending'",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending_conflicts, 1);
    let task_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM backup_jobs WHERE kind = 'Update Skill' AND target = ?1",
            params![skill.name],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(task_count, 1);

    conn.execute(
        "UPDATE repositories SET remote_sha = 'new-remote-sha' WHERE id = ?1",
        params![repo_id_value],
    )
    .unwrap();
    conn.execute(
        "UPDATE skills SET remote_hash = 'new-remote-hash' WHERE id = ?1",
        params![id],
    )
    .unwrap();
    let changed_skill = load_skill_record(&conn, &id).unwrap().unwrap();
    let changed_repo = load_repository(&conn, &repo_id_value).unwrap().unwrap();
    let replacement = persist_skill_update_conflict(
        &conn,
        &changed_skill,
        &changed_repo,
        "later-customized-hash",
    )
    .unwrap();
    assert_ne!(replacement.id, first.id);
    assert_ne!(replacement.task_id, first.task_id);
    assert_eq!(replacement.remote_sha, "new-remote-sha");
    assert_eq!(replacement.remote_hash, "new-remote-hash");
    let stale = load_skill_update_conflict_by_id(&conn, &first.id)
        .unwrap()
        .unwrap();
    assert_eq!(stale.status, "stale");
    assert_eq!(stale.verification_state, "stale");
    let old_task_status: String = conn
        .query_row(
            "SELECT status FROM backup_jobs WHERE id = ?1",
            params![first.task_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old_task_status, "interrupted");
}

#[test]
fn stale_conflict_can_refresh_to_new_remote_target_without_file_mutation() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let library = tempfile::tempdir().unwrap();
    set_setting(&conn, "skill_library_root", path_string(library.path())).unwrap();
    let remote = remote_for_skill_sync_status();
    let repo_id_value = save_repository_with_account(
        &conn,
        &remote,
        &sync_status_scan("v1.0.0", "remote-hash-v1"),
        None,
        "",
    )
    .unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    let destination = library.path().join("demo-skill");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("SKILL.md"), "local customization").unwrap();
    let local_hash = hash_directory(&destination).unwrap();
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'update-available',
                 installed_hash = 'installed-v1',
                 install_path = ?2
             WHERE id = ?1",
        params![id, path_string(&destination)],
    )
    .unwrap();
    let skill = load_skill_record(&conn, &id).unwrap().unwrap();
    let repo = load_repository(&conn, &repo_id_value).unwrap().unwrap();
    let stale_conflict = persist_skill_update_conflict(&conn, &skill, &repo, &local_hash).unwrap();
    record_skill_update_conflict_verification(&conn, &stale_conflict, "stale", None).unwrap();

    let refresh_required = get_or_create_skill_update_conflict(&conn, &id).unwrap_err();
    assert_eq!(
        refresh_required.code,
        "skill_conflict_source_refresh_required"
    );
    let task_count_before_refresh: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM backup_jobs WHERE target = 'demo-skill'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(task_count_before_refresh, 1);

    let mut next_remote = remote;
    next_remote.sha = "new-remote-sha".into();
    save_repository_with_account(
        &conn,
        &next_remote,
        &sync_status_scan("v2.0.0", "remote-hash-v2"),
        None,
        "",
    )
    .unwrap();

    let refreshed = get_or_create_skill_update_conflict(&conn, &id).unwrap();

    assert_ne!(refreshed.id, stale_conflict.id);
    assert_ne!(refreshed.task_id, stale_conflict.task_id);
    assert_eq!(refreshed.remote_sha, "new-remote-sha");
    assert_eq!(refreshed.remote_hash, "remote-hash-v2");
    assert_eq!(refreshed.local_hash, local_hash);
    assert_eq!(refreshed.status, "pending");
    assert_eq!(
        fs::read_to_string(destination.join("SKILL.md")).unwrap(),
        "local customization"
    );
    let pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM skill_update_conflicts
                 WHERE skill_id = ?1 AND status = 'pending'",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pending_count, 1);
    let refreshed_task = load_ui_tasks(&conn)
        .unwrap()
        .into_iter()
        .find(|task| task.id == refreshed.task_id)
        .unwrap();
    assert_eq!(refreshed_task.status, "waiting-user");
}

#[test]
fn conflict_verification_distinguishes_stale_latest_unchanged_and_customized() {
    let conflict = SkillUpdateConflict {
        id: "conflict-1".into(),
        skill_id: "skill-1".into(),
        task_id: "task-1".into(),
        status: "pending".into(),
        local_hash: "local-at-detection".into(),
        installed_hash: Some("installed-hash".into()),
        remote_sha: "remote-sha".into(),
        remote_hash: "remote-hash".into(),
        verification_state: "pending".into(),
        verified_local_hash: None,
        created_at: "2026-08-28T00:00:00Z".into(),
        updated_at: "2026-08-28T00:00:00Z".into(),
        verified_at: None,
        resolved_at: None,
    };

    assert_eq!(
        classify_skill_update_conflict(&conflict, "new-remote-sha", "remote-hash"),
        "stale"
    );
    assert_eq!(
        classify_skill_update_conflict(&conflict, "remote-sha", "remote-hash"),
        "latest"
    );
    assert_eq!(
        classify_skill_update_conflict(&conflict, "remote-sha", "local-at-detection"),
        "unchanged"
    );
    assert_eq!(
        classify_skill_update_conflict(&conflict, "remote-sha", "edited-again"),
        "customized"
    );
    let mut unchanged_remote_equal = conflict.clone();
    unchanged_remote_equal.local_hash = "remote-hash".into();
    assert_eq!(
        classify_skill_update_conflict(&unchanged_remote_equal, "remote-sha", "remote-hash"),
        "latest"
    );
}

#[test]
fn conflict_confirmation_rejects_pending_and_unchanged_verification() {
    let mut conflict = verified_conflict_for_confirmation();
    conflict.verification_state = "pending".into();
    conflict.verified_local_hash = None;
    let pending =
        validate_skill_update_confirmation(&conflict, "remote-sha", "verified-local-hash")
            .unwrap_err();
    assert_eq!(pending.code, "skill_update_conflict_not_verified");

    conflict.verification_state = "unchanged".into();
    conflict.verified_local_hash = Some("verified-local-hash".into());
    let unchanged =
        validate_skill_update_confirmation(&conflict, "remote-sha", "verified-local-hash")
            .unwrap_err();
    assert_eq!(unchanged.code, "skill_update_conflict_not_verified");
}

#[test]
fn conflict_confirmation_rejects_local_hash_toctou() {
    let conflict = verified_conflict_for_confirmation();
    let error = validate_skill_update_confirmation(&conflict, "remote-sha", "changed-after-verify")
        .unwrap_err();
    assert_eq!(error.code, "skill_update_conflict_local_changed");
}

#[test]
fn conflict_confirmation_rejects_remote_sha_toctou() {
    let conflict = verified_conflict_for_confirmation();
    let error = validate_skill_update_confirmation(
        &conflict,
        "changed-after-verify",
        "verified-local-hash",
    )
    .unwrap_err();
    assert_eq!(error.code, "skill_update_conflict_remote_changed");
}

#[test]
fn customized_skill_preflight_is_noop_for_handled_remote_and_conflicts_on_new_remote() {
    let mut skill = SkillRecord {
        id: "skill-1".into(),
        repo_id: "repo-1".into(),
        name: "demo".into(),
        path: "skills/demo".into(),
        installed: true,
        installed_hash: Some("customized-baseline".into()),
        status: "installed-customized".into(),
        remote_hash: Some("remote-hash-v1".into()),
        handled_remote_sha: Some("remote-sha-v1".into()),
        handled_remote_hash: Some("remote-hash-v1".into()),
        source_type: "github".into(),
        install_path: None,
        sync_targets_mode: "inherit".into(),
        sync_targets: Vec::new(),
    };

    assert_eq!(
        classify_skill_update_preflight(&skill, "remote-sha-v1", "customized-baseline"),
        SkillUpdatePreflight::AlreadyHandled
    );
    assert_eq!(
        classify_skill_update_preflight(&skill, "remote-sha-v2", "customized-baseline"),
        SkillUpdatePreflight::Conflict
    );
    skill.remote_hash = Some("customized-baseline".into());
    assert_eq!(
        classify_skill_update_preflight(&skill, "remote-sha-v2", "customized-baseline"),
        SkillUpdatePreflight::AlreadyHandled
    );
    skill.remote_hash = Some("remote-hash-v1".into());
    skill.status = "installed-latest".into();
    assert_eq!(
        classify_skill_update_preflight(&skill, "remote-sha-v1", "customized-baseline"),
        SkillUpdatePreflight::AlreadyHandled
    );
    assert_eq!(
        classify_skill_update_preflight(&skill, "remote-sha-v2", "customized-baseline"),
        SkillUpdatePreflight::Proceed
    );
}

#[test]
fn install_command_rejects_an_already_installed_skill() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let remote = remote_for_skill_sync_status();
    let repo_id_value = save_repository_with_account(
        &conn,
        &remote,
        &sync_status_scan("v1.0.0", "remote-hash"),
        None,
        "",
    )
    .unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills SET installed = 1, status = 'installed-latest' WHERE id = ?1",
        params![id],
    )
    .unwrap();
    let skill = load_skill_record(&conn, &id).unwrap().unwrap();

    let error = validate_skill_action_mode(&skill, SkillActionMode::Install).unwrap_err();
    assert_eq!(error.code, "skill_already_installed");
}

#[test]
fn skill_action_mode_is_revalidated_against_current_installed_state() {
    let mut skill = SkillRecord {
        id: "skill-mode".into(),
        repo_id: "repo-mode".into(),
        name: "demo".into(),
        path: "skills/demo".into(),
        installed: false,
        installed_hash: None,
        status: "not-installed".into(),
        remote_hash: Some("remote-hash".into()),
        handled_remote_sha: None,
        handled_remote_hash: None,
        source_type: "github_repo".into(),
        install_path: None,
        sync_targets_mode: "inherit".into(),
        sync_targets: Vec::new(),
    };

    assert!(validate_skill_action_mode(&skill, SkillActionMode::Install).is_ok());
    let update_error = validate_skill_action_mode(&skill, SkillActionMode::Update).unwrap_err();
    assert_eq!(update_error.code, "skill_not_installed");

    skill.installed = true;
    let install_error = validate_skill_action_mode(&skill, SkillActionMode::Install).unwrap_err();
    assert_eq!(install_error.code, "skill_already_installed");
    assert!(validate_skill_action_mode(&skill, SkillActionMode::Update).is_ok());
}

#[test]
fn confirming_customized_conflict_preserves_local_files_and_resolves_original_task() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let library = tempfile::tempdir().unwrap();
    set_setting(&conn, "skill_library_root", path_string(library.path())).unwrap();
    let remote = remote_for_skill_sync_status();
    let scans = sync_status_scan("v2.0.0", "remote-content-hash");
    let repo_id_value = save_repository_with_account(&conn, &remote, &scans, None, "").unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    let dest = library.path().join("demo-skill");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("SKILL.md"), "customized content must survive").unwrap();
    let local_hash = hash_directory(&dest).unwrap();
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'update-available',
                 installed_hash = 'previous-installed-hash',
                 install_path = ?2,
                 sync_targets_mode = 'custom',
                 sync_targets = '[]'
             WHERE id = ?1",
        params![id, path_string(&dest)],
    )
    .unwrap();
    let skill = load_skill_record(&conn, &id).unwrap().unwrap();
    let repo = load_repository(&conn, &repo_id_value).unwrap().unwrap();
    let conflict = persist_skill_update_conflict(&conn, &skill, &repo, &local_hash).unwrap();
    let conflict = record_skill_update_conflict_verification(
        &conn,
        &conflict,
        "customized",
        Some(&local_hash),
    )
    .unwrap();
    let settings = settings_from_db(&conn, false).unwrap();
    let registry =
        TempArtifactRegistry::open(&library.path().join("temp-registry.sqlite")).unwrap();

    let outcome =
        finalize_skill_update_conflict(&conn, &conflict, &settings, &dest, &local_hash, &registry)
            .unwrap();

    assert!(matches!(outcome, SkillActionOutcome::Updated { .. }));
    assert_eq!(
        fs::read_to_string(dest.join("SKILL.md")).unwrap(),
        "customized content must survive"
    );
    let updated = load_skill_record(&conn, &id).unwrap().unwrap();
    assert_eq!(updated.status, "installed-customized");
    assert_eq!(updated.installed_hash.as_deref(), Some(local_hash.as_str()));
    assert_eq!(
        updated.handled_remote_sha.as_deref(),
        Some(remote.sha.as_str())
    );
    assert_eq!(
        updated.handled_remote_hash.as_deref(),
        Some("remote-content-hash")
    );
    let resolved = load_skill_update_conflict_by_id(&conn, &conflict.id)
        .unwrap()
        .unwrap();
    assert_eq!(resolved.status, "resolved");
    assert_eq!(resolved.verification_state, "customized");
    let task = load_ui_tasks(&conn)
        .unwrap()
        .into_iter()
        .find(|task| task.id == conflict.task_id)
        .unwrap();
    assert_eq!(task.status, "success");
}

#[test]
fn conflict_confirmation_rolls_back_skill_state_if_resolution_commit_fails() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let library = tempfile::tempdir().unwrap();
    set_setting(&conn, "skill_library_root", path_string(library.path())).unwrap();
    let remote = remote_for_skill_sync_status();
    let repo_id_value = save_repository_with_account(
        &conn,
        &remote,
        &sync_status_scan("v2.0.0", "remote-content-hash"),
        None,
        "",
    )
    .unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    let destination = library.path().join("demo-skill");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("SKILL.md"), "customized content").unwrap();
    let local_hash = hash_directory(&destination).unwrap();
    conn.execute(
        "UPDATE skills
             SET installed = 1,
                 status = 'update-available',
                 installed_hash = 'previous-installed-hash',
                 install_path = ?2,
                 sync_targets_mode = 'custom',
                 sync_targets = '[]'
             WHERE id = ?1",
        params![id, path_string(&destination)],
    )
    .unwrap();
    let skill = load_skill_record(&conn, &id).unwrap().unwrap();
    let repo = load_repository(&conn, &repo_id_value).unwrap().unwrap();
    let conflict = persist_skill_update_conflict(&conn, &skill, &repo, &local_hash).unwrap();
    let conflict = record_skill_update_conflict_verification(
        &conn,
        &conflict,
        "customized",
        Some(&local_hash),
    )
    .unwrap();
    conn.execute_batch(
        "CREATE TRIGGER fail_conflict_resolution
             BEFORE UPDATE ON skill_update_conflicts
             WHEN NEW.status = 'resolved'
             BEGIN
               SELECT RAISE(ABORT, 'fault injection: conflict resolution failed');
             END;",
    )
    .unwrap();
    let settings = settings_from_db(&conn, false).unwrap();
    let registry =
        TempArtifactRegistry::open(&library.path().join("temp-registry.sqlite")).unwrap();

    let error = finalize_skill_update_conflict(
        &conn,
        &conflict,
        &settings,
        &destination,
        &local_hash,
        &registry,
    )
    .unwrap_err();

    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("conflict resolution failed"));
    let unchanged_skill = load_skill_record(&conn, &id).unwrap().unwrap();
    assert_eq!(unchanged_skill.status, "update-conflict");
    assert_eq!(
        unchanged_skill.installed_hash.as_deref(),
        Some("previous-installed-hash")
    );
    assert_eq!(unchanged_skill.handled_remote_sha, None);
    let unchanged_conflict = load_skill_update_conflict_by_id(&conn, &conflict.id)
        .unwrap()
        .unwrap();
    assert_eq!(unchanged_conflict.status, "pending");
    let task = load_ui_tasks(&conn)
        .unwrap()
        .into_iter()
        .find(|task| task.id == conflict.task_id)
        .unwrap();
    assert_eq!(task.status, "waiting-user");
}

#[test]
fn skill_folder_resolution_accepts_only_matching_direct_child() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let library = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let inside = library.path().join("demo-skill");
    fs::create_dir_all(&inside).unwrap();
    fs::write(inside.join("SKILL.md"), "name: demo-skill").unwrap();
    set_setting(&conn, "skill_library_root", path_string(library.path())).unwrap();
    let remote = remote_for_skill_sync_status();
    let repo_id_value = save_repository_with_account(
        &conn,
        &remote,
        &sync_status_scan("v1.0.0", "remote-hash"),
        None,
        "",
    )
    .unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills SET installed = 1, install_path = ?2 WHERE id = ?1",
        params![id, path_string(&inside)],
    )
    .unwrap();

    let validated_inside = resolve_skill_folder_path(&conn, &id).unwrap();
    assert_eq!(validated_inside, inside.canonicalize().unwrap());
    revalidate_skill_folder_before_open(&validated_inside).unwrap();
    conn.execute(
        "UPDATE skills SET install_path = ?2 WHERE id = ?1",
        params![id, path_string(outside.path())],
    )
    .unwrap();
    let outside_error = resolve_skill_folder_path(&conn, &id).unwrap_err();
    assert_eq!(outside_error.code, "skill_folder_outside_library");

    let nested = library.path().join("nested").join("demo-skill");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("SKILL.md"), "name: demo-skill").unwrap();
    conn.execute(
        "UPDATE skills SET install_path = ?2 WHERE id = ?1",
        params![id, path_string(&nested)],
    )
    .unwrap();
    let nested_error = resolve_skill_folder_path(&conn, &id).unwrap_err();
    assert_eq!(nested_error.code, "skill_folder_outside_library");

    let mismatched = library.path().join("other-skill");
    fs::create_dir_all(&mismatched).unwrap();
    fs::write(mismatched.join("SKILL.md"), "name: other-skill").unwrap();
    conn.execute(
        "UPDATE skills SET install_path = ?2 WHERE id = ?1",
        params![id, path_string(&mismatched)],
    )
    .unwrap();
    let mismatched_error = resolve_skill_folder_path(&conn, &id).unwrap_err();
    assert_eq!(mismatched_error.code, "skill_folder_outside_library");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let escape = library.path().join("escape-link");
        symlink(outside.path(), &escape).unwrap();
        conn.execute(
            "UPDATE skills SET install_path = ?2 WHERE id = ?1",
            params![id, path_string(&escape)],
        )
        .unwrap();
        let symlink_error = resolve_skill_folder_path(&conn, &id).unwrap_err();
        assert_eq!(symlink_error.code, "skill_folder_invalid");
    }

    fs::remove_file(inside.join("SKILL.md")).unwrap();
    conn.execute(
        "UPDATE skills SET install_path = ?2 WHERE id = ?1",
        params![id, path_string(&inside)],
    )
    .unwrap();
    let missing_manifest = resolve_skill_folder_path(&conn, &id).unwrap_err();
    assert_eq!(missing_manifest.code, "skill_manifest_unavailable");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::remove_dir(&inside).unwrap();
        symlink(outside.path(), &inside).unwrap();
        let revalidation_error =
            revalidate_skill_folder_before_open(&validated_inside).unwrap_err();
        assert_eq!(revalidation_error.code, "skill_folder_invalid");
        let top_level_symlink = resolve_skill_folder_path(&conn, &id).unwrap_err();
        assert_eq!(top_level_symlink.code, "skill_folder_invalid");
        fs::remove_file(&inside).unwrap();
    }

    let missing_directory = resolve_skill_folder_path(&conn, &id).unwrap_err();
    assert_eq!(missing_directory.code, "skill_folder_unavailable");

    conn.execute(
        "UPDATE skills SET name = '../unsafe', install_path = ?2 WHERE id = ?1",
        params![id, path_string(&inside)],
    )
    .unwrap();
    let unsafe_name_error = resolve_skill_folder_path(&conn, &id).unwrap_err();
    assert_eq!(unsafe_name_error.code, "skill_name_unsafe");
}

#[test]
fn opening_skill_folder_holds_filesystem_lock_through_open_callback() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let library = tempfile::tempdir().unwrap();
    let lock_root = tempfile::tempdir().unwrap();
    let inside = library.path().join("demo-skill");
    fs::create_dir_all(&inside).unwrap();
    fs::write(inside.join("SKILL.md"), "name: demo-skill").unwrap();
    set_setting(&conn, "skill_library_root", path_string(library.path())).unwrap();
    let remote = remote_for_skill_sync_status();
    let repo_id_value = save_repository_with_account(
        &conn,
        &remote,
        &sync_status_scan("v1.0.0", "remote-hash"),
        None,
        "",
    )
    .unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    conn.execute(
        "UPDATE skills SET installed = 1, install_path = ?2 WHERE id = ?1",
        params![id, path_string(&inside)],
    )
    .unwrap();
    let filesystem_lock = FilesystemMutationLock::new(lock_root.path()).unwrap();
    let contender = FilesystemMutationLock::new(lock_root.path()).unwrap();
    let database = Mutex::new(conn);

    open_skill_folder_with(&filesystem_lock, &database, &id, |destination| {
        assert_eq!(destination, inside.canonicalize().unwrap());
        assert!(contender.try_acquire().unwrap().is_none());
        Ok(())
    })
    .unwrap();

    assert!(contender.try_acquire().unwrap().is_some());
}

#[test]
fn repository_list_returns_all_53_rows_in_stable_order() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    for index in (0..53).rev() {
        let id = format!("repo-{index:03}");
        conn.execute(
            "INSERT INTO repositories
                 (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
                  backup_status, check_status, url, branch, source_type, created_at, updated_at)
                 VALUES (?1, ?2, 'owner', ?2, 'main', 'skill repo', 0, 'sha',
                  'backed-up', 'success', ?3, 'main', 'github', ?4, ?4)",
            params![
                id,
                format!("repo-{index:03}"),
                format!("https://github.com/owner/repo-{index:03}"),
                "2026-08-28T00:00:00Z"
            ],
        )
        .unwrap();
    }

    let first: Vec<String> = load_ui_repositories(&conn)
        .unwrap()
        .into_iter()
        .map(|repo| repo.id)
        .collect();
    let second: Vec<String> = load_ui_repositories(&conn)
        .unwrap()
        .into_iter()
        .map(|repo| repo.id)
        .collect();

    assert_eq!(first.len(), 53);
    assert_eq!(first, second);
    assert_eq!(first.first().map(String::as_str), Some("repo-000"));
    assert_eq!(first.last().map(String::as_str), Some("repo-052"));
}

#[test]
fn moves_deleted_skill_to_app_data_backup() {
    let source_root = tempfile::tempdir().unwrap();
    let data_root = tempfile::tempdir().unwrap();
    let skill_dir = source_root.path().join("demo-skill");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), "name: demo-skill").unwrap();
    let deleted_path = move_skill_to_deleted(&skill_dir, data_root.path(), "demo-skill").unwrap();
    assert!(!skill_dir.exists());
    assert!(deleted_path.join("SKILL.md").exists());
    assert!(deleted_path.starts_with(data_root.path().join("deleted-skills")));
}

#[test]
fn resolves_inherited_and_custom_sync_targets() {
    let defaults = vec!["codex".to_string(), "gemini".to_string()];
    let custom = vec!["claude".to_string(), "unknown".to_string()];

    assert_eq!(
        resolve_skill_sync_targets("inherit", &custom, &defaults),
        defaults
    );
    assert_eq!(
        resolve_skill_sync_targets("custom", &custom, &defaults),
        vec!["claude".to_string()]
    );
    assert!(resolve_skill_sync_targets("custom", &[], &defaults).is_empty());
}

#[test]
fn settings_preserve_previous_and_current_library_roots_for_temp_cleanup() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let home = tempfile::tempdir().unwrap();
    let previous = home.path().join("previous Skill library");
    let current = home.path().join("current Skill library");
    fs::create_dir_all(&previous).unwrap();
    fs::create_dir_all(&current).unwrap();

    set_setting(&conn, "skill_library_root", path_string(&previous)).unwrap();
    remember_skill_library_roots(&conn, [&previous, &current]).unwrap();
    set_setting(&conn, "skill_library_root", path_string(&current)).unwrap();

    let persisted = skill_library_root_history(&conn).unwrap();
    assert_eq!(persisted, vec![previous.clone(), current.clone()]);

    let cleanup_roots = temp_artifact_cleanup_roots(&conn, home.path()).unwrap();
    assert!(cleanup_roots.contains(&default_skill_library_root(home.path())));
    assert!(cleanup_roots.contains(&previous));
    assert!(cleanup_roots.contains(&current));
    for target in sync_target_specs(home.path()) {
        assert!(cleanup_roots.contains(&target.path));
    }
}

#[cfg(unix)]
#[test]
fn cleanup_allowlist_preserves_a_symlinked_sync_root_for_safe_rejection() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, os::unix::fs::symlink, time::Duration};

    fn set_mtime(path: &Path, modified: SystemTime) {
        let seconds = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let times = [
            libc::timespec {
                tv_sec: seconds,
                tv_nsec: 0,
            },
            libc::timespec {
                tv_sec: seconds,
                tv_nsec: 0,
            },
        ];
        assert_eq!(
            unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) },
            0
        );
    }

    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let home = tempfile::tempdir().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let external = home.path().join(".cc-switch").join("skills");
    let configured = home.path().join(".codex").join("skills");
    fs::create_dir_all(&external).unwrap();
    fs::create_dir_all(configured.parent().unwrap()).unwrap();
    symlink(&external, &configured).unwrap();
    let stale = external.join(".external-1787707160032652000-sync-tmp");
    fs::create_dir(&stale).unwrap();
    set_mtime(
        &stale,
        SystemTime::now() - Duration::from_secs(25 * 60 * 60),
    );
    let registry = TempArtifactRegistry::open(&data_dir.path().join("registry.sqlite")).unwrap();

    let roots = temp_artifact_cleanup_roots(&conn, home.path()).unwrap();
    assert!(roots.contains(&configured));
    assert!(!roots.contains(&external.canonicalize().unwrap()));

    let report =
        cleanup_temp_artifacts_with_lock_held(&conn, &registry, data_dir.path(), home.path());

    assert_eq!(report.found, 0);
    assert_eq!(report.quarantined, 0);
    assert_eq!(report.failed, 0);
    assert!(stale.exists());
    assert!(configured
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn temp_cleanup_tasks_are_quiet_when_empty_and_retry_without_persisted_paths() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();

    let empty = temp_artifacts::CleanupReport::default();
    assert!(!record_temp_cleanup_task(&conn, &empty).unwrap());
    let empty_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM backup_jobs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(empty_count, 0);

    let failed = temp_artifacts::CleanupReport {
        found: 2,
        removed: 1,
        quarantined: 0,
        deferred: 1,
        failed: 1,
        log: vec!["fixture failure".to_string()],
        ..Default::default()
    };
    assert!(record_temp_cleanup_task(&conn, &failed).unwrap());
    let (summary, retryable, action, payload): (String, i64, String, String) = conn
        .query_row(
            "SELECT summary, retryable, retry_action, retry_payload
                 FROM backup_jobs ORDER BY created_at DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        summary,
        "found=2 removed=1 quarantined=0 deferred=1 failed=1"
    );
    assert_eq!(retryable, 1);
    assert_eq!(action, RETRY_TEMP_ARTIFACT_CLEANUP);
    assert_eq!(payload, "{}");
}

#[test]
fn replace_dir_from_source_copies_complete_target() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let dest = root.path().join("target").join("demo-skill");
    let registry = TempArtifactRegistry::open(&root.path().join("registry.sqlite")).unwrap();
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::write(source.join("SKILL.md"), "name: demo-skill").unwrap();
    fs::write(source.join("nested").join("notes.md"), "ok").unwrap();

    let mut prepared =
        prepare_dir_replacement_from_source(&source, &dest, "codex", "demo-skill", 5, &registry)
            .unwrap();
    prepared.replacement.take().unwrap().commit().unwrap();

    assert!(prepared.backup.is_none());
    assert!(dest.join("SKILL.md").exists());
    assert!(dest.join("nested").join("notes.md").exists());
}

#[cfg(unix)]
#[test]
fn sync_replace_preserves_same_source_symlink_and_rejects_other_or_broken_links_pre_temp() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let other = root.path().join("other");
    let target_root = root.path().join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&other).unwrap();
    fs::create_dir_all(&target_root).unwrap();
    fs::write(source.join("SKILL.md"), "name: source").unwrap();
    let registry = TempArtifactRegistry::open(&root.path().join("registry.sqlite")).unwrap();

    let same = target_root.join("same");
    symlink(&source, &same).unwrap();
    assert!(
        prepare_dir_replacement_from_source(&source, &same, "codex", "same", 5, &registry)
            .unwrap()
            .replacement
            .is_none()
    );
    assert_eq!(same.canonicalize().unwrap(), source.canonicalize().unwrap());

    let external = target_root.join("external");
    symlink(&other, &external).unwrap();
    let external_error =
        prepare_dir_replacement_from_source(&source, &external, "codex", "external", 5, &registry)
            .unwrap_err();
    assert_eq!(external_error.code, "sync_target_symlink_conflict");

    let broken = target_root.join("broken");
    symlink("missing", &broken).unwrap();
    let broken_error =
        prepare_dir_replacement_from_source(&source, &broken, "codex", "broken", 5, &registry)
            .unwrap_err();
    assert_eq!(broken_error.code, "sync_target_symlink_conflict");

    assert!(fs::read_dir(&target_root)
        .unwrap()
        .filter_map(Result::ok)
        .all(|entry| !entry.file_name().to_string_lossy().contains("sync-tmp")));
}

#[test]
fn deleted_local_skill_is_returned_as_restorable() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let now = utc_now();
    conn.execute(
        "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
              backup_status, check_status, url, branch, source_type, created_at, updated_at)
             VALUES ('local:installed:test', 'Local Skills Library', 'local', 'skills', 'local',
              'skill repo', 1, 'local', 'local-only', 'success', 'file:///tmp/skills',
              'local', 'local', ?1, ?1)",
        params![now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, local_version,
              remote_version, status, installed, updated_at, source_type, install_path,
             deleted_at, deleted_path)
             VALUES ('skill-1', 'local:installed:test', 'demo-skill', '', 'Local Skills Library',
              'demo-skill', 'local', 'local', 'local', 'source-unavailable', 0, ?1,
              'installed_local', '/tmp/skills/demo-skill', ?1, '/tmp/deleted/demo-skill')",
        params![now],
    )
    .unwrap();

    let skills = load_ui_skills(&conn).unwrap();

    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].status, "deleted");
    assert!(skills[0].can_restore);
    assert!(!skills[0].can_delete);
    assert_eq!(
        skills[0].deleted_path.as_deref(),
        Some("/tmp/deleted/demo-skill")
    );
}

#[test]
fn migrates_local_library_display_names() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let now = utc_now();
    conn.execute(
            "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha,
              backup_status, check_status, url, branch, source_type, canonical_name, created_at, updated_at)
             VALUES ('local:installed:test', 'Local Skills Library', 'local', 'skills', 'local',
              'skill repo', 1, 'local', 'local-only', 'success', 'file:///tmp/skills',
              'local', 'local', 'Local Skills Library', ?1, ?1)",
            params![now],
        )
        .unwrap();
    conn.execute(
        "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, local_version,
              remote_version, status, installed, updated_at, source_type)
             VALUES ('skill-1', 'local:installed:test', 'demo-skill', '', 'Local Skills Library',
              'demo-skill', 'local', 'local', 'local', 'installed-latest', 1, ?1,
              'installed_local')",
        params![now],
    )
    .unwrap();

    migrate_local_library_names(&conn).unwrap();
    let repos = load_ui_repositories(&conn).unwrap();
    let skills = load_ui_skills(&conn).unwrap();

    assert_eq!(repos[0].name, LOCAL_SKILLS_LIBRARY_NAME);
    assert_eq!(skills[0].repo, LOCAL_SKILLS_LIBRARY_NAME);
}

#[test]
fn finds_local_skill_markdown_file() {
    let root = tempfile::tempdir().unwrap();
    let skill_dir = root.path().join("demo-skill");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), "name: demo-skill").unwrap();

    let path = skill_markdown_path(None, Some(&path_string(&skill_dir)), None).unwrap();

    assert_eq!(
        path.file_name().and_then(|name| name.to_str()),
        Some("SKILL.md")
    );
}

#[test]
fn validates_only_github_https_urls() {
    assert!(validate_github_url("https://github.com/openai/openai-cookbook").is_ok());
    assert!(validate_github_url("http://github.com/openai/openai-cookbook").is_err());
    assert!(validate_github_url("https://example.com/openai/openai-cookbook").is_err());
}

#[test]
fn sqlite_details_are_kept_for_task_logs() {
    let error = AppError::with_details(
        "sqlite_error",
        "SQLite 操作失败。",
        "UNIQUE constraint failed",
    );
    let line = format_error_for_log("NVIDIA/SkillSpector", &error);
    assert!(line.contains("sqlite_error"));
    assert!(line.contains("UNIQUE constraint failed"));
}

#[test]
fn migration_marks_legacy_tasks_as_not_retryable() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
            CREATE TABLE backup_jobs (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              target TEXT NOT NULL,
              progress TEXT NOT NULL,
              status TEXT NOT NULL,
              summary TEXT NOT NULL,
              backup_dir TEXT,
              created_at TEXT NOT NULL,
              started_at TEXT,
              completed_at TEXT
            );
            INSERT INTO backup_jobs
             (id, kind, target, progress, status, summary, created_at)
             VALUES ('legacy-task', 'Update Skill', 'demo-skill', '0 / 1',
              'failed', 'old failure', '2026-07-08T00:00:00Z');
            "#,
    )
    .unwrap();

    migrate(&conn).unwrap();

    let task = load_ui_tasks(&conn).unwrap().pop().unwrap();
    assert_eq!(task.id, "legacy-task");
    assert!(!task.retryable);
    assert!(task.retry_reason.is_none());
    let error = load_task_retry_metadata(&conn, "legacy-task").unwrap_err();
    assert_eq!(error.code, "task_not_retryable");
    assert!(error.message.contains("旧任务缺少可重试参数"));
}

#[test]
fn retryable_task_metadata_round_trips() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let retry_request = CheckRepositoriesRequest {
        repo_ids: Some(vec!["repo-1".into()]),
    };

    insert_retryable_task(
        &conn,
        TaskWrite {
            id: "check-1",
            kind: "Check remote state",
            target: "Selected repositories",
            progress: "0 / 1",
            status: "failed",
            summary: "0 success, 1 failed",
            backup_dir: None,
            log: &["repo failed".into()],
        },
        RETRY_CHECK_REPOSITORIES,
        &retry_request,
    )
    .unwrap();

    let task = load_ui_tasks(&conn).unwrap().pop().unwrap();
    assert!(task.retryable);
    let metadata = load_task_retry_metadata(&conn, "check-1").unwrap();
    assert_eq!(metadata.action, RETRY_CHECK_REPOSITORIES);
    let payload: CheckRepositoriesRequest = parse_retry_payload(&metadata.payload).unwrap();
    assert_eq!(payload.repo_ids, Some(vec!["repo-1".into()]));
}

#[test]
fn partial_skill_sync_retries_only_the_sync_step() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let report = SyncReport {
        success_count: 0,
        failure_count: 1,
        skipped_count: 0,
        log: vec!["codex: sync target conflict".into()],
    };
    assert_eq!(
        completed_local_skill_task_status(&report),
        "partial-success"
    );

    insert_skill_sync_result_task(
        &conn,
        "sync-partial",
        "Update Skill",
        "demo-skill",
        "1 / 2",
        "partial-success",
        "local Skill updated; sync 1 synced, 1 failed, 0 skipped",
        &["codex: sync target conflict".into()],
        "skill-1",
        true,
    )
    .unwrap();

    let metadata = load_task_retry_metadata(&conn, "sync-partial").unwrap();
    assert_eq!(metadata.action, RETRY_SYNC_SKILL);
    let payload: SkillActionRequest = parse_retry_payload(&metadata.payload).unwrap();
    assert_eq!(payload.skill_id, "skill-1");
}

#[test]
fn confirmed_conflict_with_partial_sync_stays_retryable_as_sync_only() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    insert_task(
        &conn,
        TaskWrite {
            id: "conflict-task",
            kind: "Update Skill",
            target: "demo-skill",
            progress: "0 / 1",
            status: "waiting-user",
            summary: "等待用户处理",
            backup_dir: None,
            log: &[],
        },
    )
    .unwrap();

    set_waiting_conflict_task_sync_result(
        &conn,
        ConflictTaskResult {
            task_id: "conflict-task",
            skill_id: "skill-1",
            progress: "1 / 2",
            status: "partial-success",
            summary: "已保留本地定制内容，同步部分成功",
            completed_at: "2026-08-28T00:00:00Z",
            sync_failed: true,
        },
    )
    .unwrap();

    let metadata = load_task_retry_metadata(&conn, "conflict-task").unwrap();
    assert_eq!(metadata.action, RETRY_SYNC_SKILL);
    let payload: SkillActionRequest = parse_retry_payload(&metadata.payload).unwrap();
    assert_eq!(payload.skill_id, "skill-1");
}

#[test]
fn builds_stable_github_account_token_keys() {
    assert_eq!(github_account_id_for_login("Octo-Cat"), "github:octo-cat");
    assert_eq!(
        github_account_token_key("github:octo-cat"),
        "github-account-token:github:octo-cat"
    );
}

#[test]
fn parses_github_next_link_header() {
    let link = r#"<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=4>; rel="last""#;
    assert_eq!(
        parse_link_header_next(link).as_deref(),
        Some("https://api.github.com/user/repos?page=2")
    );
    assert!(
        parse_link_header_next(r#"<https://api.github.com/user/repos?page=1>; rel="last""#)
            .is_none()
    );
}

#[test]
fn cleans_legacy_token_metadata_without_creating_default_account() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let now = utc_now();
    set_setting(&conn, "github_token_configured", "true").unwrap();
    set_setting(&conn, "github_token_status", "saved_unverified").unwrap();
    set_setting(&conn, "github_token_last_verified", "2026-06-30T00:00:00Z").unwrap();
    conn.execute(
            "INSERT INTO github_accounts
             (id, login, display_name, avatar_url, token_key, status, scopes, last_verified, is_default, created_at, updated_at)
             VALUES (?1, 'default', 'Default GitHub token', NULL, ?2, 'saved_unverified', '', NULL, 1, ?3, ?3)",
            params![LEGACY_GITHUB_ACCOUNT_ID, TOKEN_USER, now],
        )
        .unwrap();
    conn.execute(
            "INSERT INTO github_repo_catalog
             (account_id, full_name, owner, repo, github_id, html_url, last_refreshed)
             VALUES (?1, 'octocat/Hello-World', 'octocat', 'Hello-World', 42, 'https://github.com/octocat/Hello-World', ?2)",
            params![LEGACY_GITHUB_ACCOUNT_ID, now],
        )
        .unwrap();
    conn.execute(
            "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha, url, branch, source_type, github_account_id, created_at, updated_at)
             VALUES ('repo-1', 'octocat/Hello-World', 'octocat', 'Hello-World', 'main', 'generic repo', 0, 'abc123', 'https://github.com/octocat/Hello-World', 'main', 'github', ?1, ?2, ?2)",
            params![LEGACY_GITHUB_ACCOUNT_ID, now],
        )
        .unwrap();

    cleanup_legacy_github_account_metadata(&conn).unwrap();

    let account_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM github_accounts", [], |row| row.get(0))
        .unwrap();
    let catalog_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM github_repo_catalog", [], |row| {
            row.get(0)
        })
        .unwrap();
    let repo_account: Option<String> = conn
        .query_row(
            "SELECT github_account_id FROM repositories WHERE id = 'repo-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(account_count, 0);
    assert_eq!(catalog_count, 0);
    assert_eq!(repo_account, None);
    assert_eq!(
        get_setting(&conn, "github_token_configured")
            .unwrap()
            .as_deref(),
        Some("false")
    );
    assert_eq!(
        get_setting(&conn, "github_token_status")
            .unwrap()
            .as_deref(),
        Some("not_configured")
    );
    assert_eq!(
        get_setting(&conn, "github_token_last_verified")
            .unwrap()
            .as_deref(),
        Some("")
    );
}

#[test]
fn upserted_github_accounts_are_not_marked_default() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let account = GithubAccountRecord {
        id: "github:octocat".into(),
        login: "octocat".into(),
        display_name: "Octocat".into(),
        avatar_url: None,
        token_key: github_account_token_key("github:octocat"),
        status: "verified".into(),
        scopes: "repo, user".into(),
        last_verified: Some(utc_now()),
        is_default: true,
    };

    upsert_github_account(&conn, &account).unwrap();

    let stored = github_account_by_id(&conn, "github:octocat")
        .unwrap()
        .unwrap();
    assert!(!stored.is_default);
}

#[test]
fn upserts_catalog_and_marks_tracked_repositories() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let account = GithubAccountRecord {
        id: "github:octocat".into(),
        login: "octocat".into(),
        display_name: "Octocat".into(),
        avatar_url: None,
        token_key: github_account_token_key("github:octocat"),
        status: "verified".into(),
        scopes: "repo, user".into(),
        last_verified: Some(utc_now()),
        is_default: true,
    };
    upsert_github_account(&conn, &account).unwrap();
    let repo_json = serde_json::json!({
        "id": 42,
        "full_name": "octocat/Hello-World",
        "name": "Hello-World",
        "owner": { "login": "octocat" },
        "html_url": "https://github.com/octocat/Hello-World",
        "description": "A demo repository",
        "visibility": "private",
        "private": true,
        "fork": false,
        "archived": false,
        "default_branch": "main",
        "language": "Rust",
        "stargazers_count": 7,
        "permissions": { "pull": true, "push": true },
        "pushed_at": "2026-06-30T00:00:00Z",
        "updated_at": "2026-06-30T00:00:00Z"
    });
    upsert_github_catalog_item(
        &conn,
        &account.id,
        &repo_json,
        true,
        Some("2026-06-30T01:00:00Z"),
        "demo readme search",
    )
    .unwrap();
    let remote = RemoteInfo {
        owner: "octocat".into(),
        repo: "Hello-World".into(),
        full_name: "octocat/Hello-World".into(),
        default_branch: "main".into(),
        resolved_ref: "main".into(),
        sha: "bf4e9ac4d4428bda261afcfe981871ceb92d94e6".into(),
    };
    save_repository_with_account(&conn, &remote, &[], Some(&account.id), "tracked readme").unwrap();

    let catalog = load_ui_github_repositories(&conn, Some(&account.id)).unwrap();

    assert_eq!(catalog.len(), 1);
    assert!(catalog[0].private);
    assert!(catalog[0].starred);
    assert!(catalog[0].starred_at.is_some());
    assert_eq!(catalog[0].readme_search_text, "demo readme search");
    assert_eq!(catalog[0].language, "Rust");
    assert_eq!(
        catalog[0].tracked_repo_id.as_deref(),
        Some(repo_id("octocat", "Hello-World", "main").as_str())
    );
    assert!(catalog[0].permissions.contains("push"));

    upsert_github_catalog_item(&conn, &account.id, &repo_json, false, None, "").unwrap();
    let refreshed_catalog = load_ui_github_repositories(&conn, Some(&account.id)).unwrap();
    assert!(!refreshed_catalog[0].starred);
    assert!(refreshed_catalog[0].starred_at.is_none());
}

#[test]
fn github_catalog_and_tracked_repository_share_note() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let account = GithubAccountRecord {
        id: "github:octocat".into(),
        login: "octocat".into(),
        display_name: "Octocat".into(),
        avatar_url: None,
        token_key: github_account_token_key("github:octocat"),
        status: "verified".into(),
        scopes: "repo".into(),
        last_verified: Some(utc_now()),
        is_default: true,
    };
    upsert_github_account(&conn, &account).unwrap();
    let repo_json = serde_json::json!({
        "id": 42,
        "full_name": "octocat/Hello-World",
        "name": "Hello-World",
        "owner": { "login": "octocat" },
        "html_url": "https://github.com/octocat/Hello-World",
        "description": "A demo repository",
        "visibility": "public",
        "private": false,
        "fork": false,
        "archived": false,
        "default_branch": "main",
        "language": "Rust",
        "stargazers_count": 7,
        "permissions": { "pull": true },
        "pushed_at": "2026-06-30T00:00:00Z",
        "updated_at": "2026-06-30T00:00:00Z"
    });
    upsert_github_catalog_item(&conn, &account.id, &repo_json, false, None, "").unwrap();
    let remote = RemoteInfo {
        owner: "octocat".into(),
        repo: "Hello-World".into(),
        full_name: "octocat/Hello-World".into(),
        default_branch: "main".into(),
        resolved_ref: "main".into(),
        sha: "bf4e9ac4d4428bda261afcfe981871ceb92d94e6".into(),
    };
    save_repository_with_account(&conn, &remote, &[], Some(&account.id), "").unwrap();

    save_user_note(
        &conn,
        "repository",
        &github_repository_note_key("OCTOCAT", "hello-world"),
        "用于测试 GitHub 同步备注",
    )
    .unwrap();

    let catalog = load_ui_github_repositories(&conn, Some(&account.id)).unwrap();
    let repos = load_ui_repositories(&conn).unwrap();

    assert_eq!(catalog[0].note, "用于测试 GitHub 同步备注");
    assert_eq!(repos[0].note, "用于测试 GitHub 同步备注");

    save_user_note(
        &conn,
        "repository",
        &github_repository_note_key("octocat", "Hello-World"),
        "",
    )
    .unwrap();
    assert_eq!(
        load_ui_github_repositories(&conn, Some(&account.id)).unwrap()[0].note,
        ""
    );
    assert_eq!(load_ui_repositories(&conn).unwrap()[0].note, "");
}

#[test]
fn local_repository_skill_and_plugin_notes_use_distinct_keys() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("README.md"), "Repository README marker").unwrap();
    let skill_dir = root.path().join("demo-skill");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo-skill\ndescription: Local demo\nversion: v1.2.3\n---",
    )
    .unwrap();
    let scans = scan_skills_from_directory(root.path(), "Local Skills").unwrap();
    let plugins = vec![PluginScan {
        name: "demo-plugin".into(),
        description: "Demo plugin".into(),
        kind: "structured-plugin".into(),
        install_command: "/plugin install demo".into(),
        update_command: None,
        source_path: "plugin.json".into(),
        source_excerpt: "{}".into(),
        linked_skill_paths: vec!["demo-skill".into()],
    }];
    let repo_id_value =
        save_local_repository_with_plugins(&conn, root.path(), &scans, &plugins, false).unwrap();
    let cached_readme: String = conn
        .query_row(
            "SELECT readme_search_text FROM repositories WHERE id = ?1",
            params![&repo_id_value],
            |row| row.get(0),
        )
        .unwrap();
    assert!(cached_readme.contains("Repository README marker"));
    let skill_id_value = skill_id(&repo_id_value, "demo-skill");
    let plugin_id_value = load_ui_plugins(&conn).unwrap()[0].id.clone();

    save_user_note(
        &conn,
        "repository",
        &format!("local:{repo_id_value}"),
        "本地仓库备注",
    )
    .unwrap();
    save_user_note(&conn, "skill", &skill_id_value, "技能备注").unwrap();
    save_user_note(&conn, "plugin", &plugin_id_value, "插件备注").unwrap();

    let repo = load_ui_repositories(&conn).unwrap()[0].clone();
    let skill = load_ui_skills(&conn).unwrap()[0].clone();
    let plugin = load_ui_plugins(&conn).unwrap()[0].clone();
    assert_eq!(repo.note, "本地仓库备注");
    assert!(repo.readme_search_text.contains("Repository README marker"));
    assert_eq!(skill.note, "技能备注");
    assert!(skill.search_text.contains("Local demo"));
    assert_eq!(plugin.note, "插件备注");
    assert!(!plugin.created_at.is_empty());

    let package = build_migration_package(&conn).unwrap();
    assert!(package.repositories[0]
        .readme_search_text
        .contains("Repository README marker"));
    assert!(package.skills[0].search_text.contains("Local demo"));
    assert_eq!(package.plugins[0].search_text, "{}");
}

#[test]
fn migration_command_requests_accept_camel_case_wire_values() {
    let export: ExportMigrationRequest =
        serde_json::from_value(serde_json::json!({ "includePrompts": true })).unwrap();
    assert!(export.include_prompts);

    let import: ImportMigrationRequest = serde_json::from_value(serde_json::json!({
        "path": "/tmp/example.srtmigration",
        "expectedPackageSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "expectedPackageSizeBytes": 42,
        "conflictStrategy": "duplicate"
    }))
    .unwrap();
    assert_eq!(import.path, "/tmp/example.srtmigration");
    assert_eq!(import.expected_package_size_bytes, 42);
    assert_eq!(
        import.conflict_strategy,
        prompt_migration::PromptConflictStrategy::Duplicate
    );

    let default_strategy: ImportMigrationRequest = serde_json::from_value(serde_json::json!({
        "path": "/tmp/example.srtmigration",
        "expectedPackageSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "expectedPackageSizeBytes": 1
    }))
    .unwrap();
    assert_eq!(
        default_strategy.conflict_strategy,
        prompt_migration::PromptConflictStrategy::KeepLocal
    );
    assert!(
        serde_json::from_value::<ImportMigrationRequest>(serde_json::json!({
            "path": "/tmp/example.srtmigration"
        }))
        .is_err()
    );
}

#[test]
fn production_migration_export_keeps_v1_json_and_round_trips_v2() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    save_user_note(
        &source,
        "repository",
        "migration-v2-note",
        "legacy metadata",
    )
    .unwrap();
    let tag = prompts::create_prompt_tag(&source, "研究").unwrap();
    prompts::create_prompt(
        &source,
        &prompts::PromptCreateInput {
            id: Some("prompt-production-wire".to_string()),
            title: "迁移提示词".to_string(),
            content: "# incoming\n\n完整正文".to_string(),
            tag_ids: vec![tag.id],
            pinned: true,
        },
    )
    .unwrap();

    let directory = tempfile::tempdir().unwrap();
    let legacy_path = directory.path().join("legacy.json");
    let legacy_summary = write_migration_package_to_path(&source, &legacy_path, false).unwrap();
    assert!(legacy_summary.prompts.is_none());
    let legacy_value: serde_json::Value =
        serde_json::from_slice(&fs::read(&legacy_path).unwrap()).unwrap();
    assert_eq!(legacy_value["schemaVersion"], MIGRATION_SCHEMA_VERSION);
    assert!(legacy_value.get("prompts").is_none());
    let mut legacy_file = fs::File::open(&legacy_path).unwrap();
    assert_eq!(
        prompt_migration::detect_migration_package(&mut legacy_file).unwrap(),
        prompt_migration::MigrationPackageKind::LegacyV1Json
    );

    let v2_path = directory.path().join("with-prompts.srtmigration");
    let v2_summary = write_migration_package_to_path(&source, &v2_path, true).unwrap();
    assert_eq!(v2_summary.prompts, Some(1));
    assert_eq!(v2_summary.tags, Some(1));
    let preview = migration_preview_for_path(&source, &v2_path).unwrap();
    assert_eq!(preview.format, "v2");
    assert_eq!(preview.prompts, 1);
    assert_eq!(preview.tags, 1);
    assert!(preview
        .conflicts
        .iter()
        .any(|conflict| { conflict.id == "prompt-production-wire" && conflict.kind == "same" }));

    let mut target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    prompts::create_prompt(
        &target,
        &prompts::PromptCreateInput {
            id: Some("prompt-production-wire".to_string()),
            title: "本机版本".to_string(),
            content: "local content".to_string(),
            tag_ids: Vec::new(),
            pinned: false,
        },
    )
    .unwrap();
    let imported = import_migration_package_from_path(
        &mut target,
        &v2_path,
        prompt_migration::PromptConflictStrategy::Overwrite,
        preview.package_sha256.as_deref().unwrap(),
        preview.package_size_bytes,
    )
    .unwrap();
    assert_eq!(imported.prompts, Some(1));
    assert_eq!(
        target
            .query_row(
                "SELECT content FROM prompts WHERE id = 'prompt-production-wire'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "# incoming\n\n完整正文"
    );
    assert_eq!(
        target
            .query_row("SELECT COUNT(*) FROM prompt_tag_links", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
    assert_eq!(
        load_user_note(&target, "repository", "migration-v2-note").unwrap(),
        "legacy metadata"
    );

    import_migration_package_from_path(
        &mut target,
        &v2_path,
        prompt_migration::PromptConflictStrategy::KeepLocal,
        preview.package_sha256.as_deref().unwrap(),
        preview.package_size_bytes,
    )
    .unwrap();
    assert_eq!(
        target
            .query_row("SELECT COUNT(*) FROM prompts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn migration_preview_reports_all_different_conflicts_beyond_detail_cap() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    let target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    for index in 0..201 {
        let id = format!("prompt-conflict-{index:03}");
        prompts::create_prompt(
            &source,
            &prompts::PromptCreateInput {
                id: Some(id.clone()),
                title: format!("迁移版本 {index}"),
                content: format!("incoming-{index}"),
                tag_ids: Vec::new(),
                pinned: false,
            },
        )
        .unwrap();
        prompts::create_prompt(
            &target,
            &prompts::PromptCreateInput {
                id: Some(id),
                title: format!("本机版本 {index}"),
                content: format!("local-{index}"),
                tag_ids: Vec::new(),
                pinned: false,
            },
        )
        .unwrap();
    }

    let directory = tempfile::tempdir().unwrap();
    let package_path = directory.path().join("many-conflicts.srtmigration");
    write_migration_package_to_path(&source, &package_path, true).unwrap();
    let preview = migration_preview_for_path(&target, &package_path).unwrap();

    assert_eq!(preview.conflicts.len(), 200);
    assert_eq!(preview.different_conflict_count, 201);
    assert!(preview.has_different_conflicts);
    assert_eq!(preview.package_sha256.as_deref().unwrap().len(), 64);
    assert_eq!(
        preview.package_size_bytes,
        fs::metadata(&package_path).unwrap().len()
    );
}

#[test]
fn migration_import_rejects_file_replaced_after_preview_before_database_writes() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    prompts::create_prompt(
        &source,
        &prompts::PromptCreateInput {
            id: Some("prompt-original".to_string()),
            title: "原包".to_string(),
            content: "original".to_string(),
            tag_ids: Vec::new(),
            pinned: false,
        },
    )
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let package_path = directory.path().join("replace-after-preview.srtmigration");
    write_migration_package_to_path(&source, &package_path, true).unwrap();

    let mut target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    let preview = migration_preview_for_path(&target, &package_path).unwrap();

    source.execute("DELETE FROM prompts", []).unwrap();
    prompts::create_prompt(
        &source,
        &prompts::PromptCreateInput {
            id: Some("prompt-replaced".to_string()),
            title: "替换包".to_string(),
            content: "replaced".to_string(),
            tag_ids: Vec::new(),
            pinned: false,
        },
    )
    .unwrap();
    write_migration_package_to_path(&source, &package_path, true).unwrap();

    let error = import_migration_package_from_path(
        &mut target,
        &package_path,
        prompt_migration::PromptConflictStrategy::KeepLocal,
        preview.package_sha256.as_deref().unwrap(),
        preview.package_size_bytes,
    )
    .unwrap_err();
    assert_eq!(error.code, "migration_package_changed_since_preview");
    assert_eq!(
        target
            .query_row("SELECT COUNT(*) FROM prompts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        target
            .query_row(
                "SELECT library_revision FROM prompt_library_meta WHERE id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn production_v2_export_rejects_incompatible_embedded_legacy_schema() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    let mut legacy = build_migration_package(&source).unwrap();
    legacy.schema_version = MIGRATION_SCHEMA_VERSION + 1;
    let legacy_bytes = serde_json::to_vec(&legacy).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let package_path = directory.path().join("unsupported.srtmigration");
    let error =
        prompt_migration::write_v2_package_atomic(
            &package_path,
            &legacy_bytes,
            APP_VERSION,
            &utc_now(),
            Vec::<
                Result<
                    prompt_migration::PromptMigrationTag,
                    prompt_migration::PromptMigrationError,
                >,
            >::new(),
            Vec::<
                Result<
                    prompt_migration::PromptMigrationPrompt,
                    prompt_migration::PromptMigrationError,
                >,
            >::new(),
            Vec::<
                Result<
                    prompt_migration::PromptMigrationLink,
                    prompt_migration::PromptMigrationError,
                >,
            >::new(),
        )
        .unwrap_err();
    assert_eq!(error.code(), "migration_v1_schema_unsupported");
}

#[test]
fn production_v2_import_rolls_back_embedded_v1_when_prompt_write_fails() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    save_user_note(&source, "repository", "must-roll-back", "embedded legacy").unwrap();
    prompts::create_prompt(
        &source,
        &prompts::PromptCreateInput {
            id: Some("prompt-trigger-failure".to_string()),
            title: "Will fail".to_string(),
            content: "incoming".to_string(),
            tag_ids: Vec::new(),
            pinned: false,
        },
    )
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let package_path = directory.path().join("rollback.srtmigration");
    write_migration_package_to_path(&source, &package_path, true).unwrap();

    let mut target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    target
        .execute_batch(
            "CREATE TRIGGER reject_migrated_prompt
                 BEFORE INSERT ON prompts
                 BEGIN
                   SELECT RAISE(ABORT, 'reject imported prompt');
                 END;",
        )
        .unwrap();
    let preview = migration_preview_for_path(&target, &package_path).unwrap();
    let error = import_migration_package_from_path(
        &mut target,
        &package_path,
        prompt_migration::PromptConflictStrategy::KeepLocal,
        preview.package_sha256.as_deref().unwrap(),
        preview.package_size_bytes,
    )
    .unwrap_err();
    assert_eq!(error.code, "prompt_migration_database_failed");
    assert_eq!(
        target
            .query_row("SELECT COUNT(*) FROM prompts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        load_user_note(&target, "repository", "must-roll-back").unwrap(),
        ""
    );
}

#[test]
fn migration_package_excludes_token_key_and_imports_notes() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    let account = GithubAccountRecord {
        id: "github:octocat".into(),
        login: "octocat".into(),
        display_name: "Octocat".into(),
        avatar_url: None,
        token_key: "github-account-token:secret-source".into(),
        status: "verified".into(),
        scopes: "repo".into(),
        last_verified: Some(utc_now()),
        is_default: true,
    };
    upsert_github_account(&source, &account).unwrap();
    save_user_note(
        &source,
        "repository",
        &github_repository_note_key("octocat", "hello-world"),
        "迁移备注",
    )
    .unwrap();

    let package = build_migration_package(&source).unwrap();
    let json = serde_json::to_string_pretty(&package).unwrap();

    assert!(!json.contains("tokenKey"));
    assert!(!json.contains("token_key"));
    assert!(!json.contains("secret-source"));

    let target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    save_user_note(&target, "skill", "local-only-skill", "保留本机备注").unwrap();
    let parsed = parse_migration_package(&json).unwrap();
    merge_migration_package(&target, &parsed).unwrap();

    assert_eq!(
        load_user_note(
            &target,
            "repository",
            &github_repository_note_key("OCTOCAT", "Hello-World")
        )
        .unwrap(),
        "迁移备注"
    );
    assert_eq!(
        load_user_note(&target, "skill", "local-only-skill").unwrap(),
        "保留本机备注"
    );
    let imported_account = github_account_by_id(&target, "github:octocat")
        .unwrap()
        .unwrap();
    assert_eq!(
        imported_account.token_key,
        github_account_token_key("github:octocat")
    );
    assert_eq!(imported_account.status, "saved_unverified");
}

#[test]
fn migration_import_rolls_back_all_changes_when_a_late_skill_fk_fails() {
    let target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    let mut original_remote = remote_for_skill_sync_status();
    original_remote.sha = "original-target-sha".into();
    let original_repo_id = save_repository_with_account(
        &target,
        &original_remote,
        &sync_status_scan("v1.0.0", "original-target-hash"),
        None,
        "original target readme",
    )
    .unwrap();

    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    let mut imported_remote = remote_for_skill_sync_status();
    imported_remote.sha = "imported-source-sha".into();
    save_repository_with_account(
        &source,
        &imported_remote,
        &sync_status_scan("v2.0.0", "imported-source-hash"),
        None,
        "imported source readme",
    )
    .unwrap();
    save_user_note(
        &source,
        "repository",
        &original_repo_id,
        "must not be imported",
    )
    .unwrap();
    let mut package = build_migration_package(&source).unwrap();
    let mut invalid_skill = package.skills.first().unwrap().clone();
    invalid_skill.id = "migration-invalid-skill".into();
    invalid_skill.repo_id = "migration-missing-repository".into();
    invalid_skill.name = "invalid-skill".into();
    invalid_skill.path = "skills/invalid-skill".into();
    package.skills.push(invalid_skill);

    let error = merge_migration_package(&target, &package).unwrap_err();
    assert_eq!(error.code, "sqlite_error");

    let repository_state: (String, String) = target
        .query_row(
            "SELECT remote_sha, readme_search_text FROM repositories WHERE id = ?1",
            params![original_repo_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        repository_state,
        (
            "original-target-sha".into(),
            "original target readme".into()
        )
    );
    let skill_state: (String, String) = target
        .query_row(
            "SELECT remote_version, remote_hash FROM skills WHERE repo_id = ?1",
            params![original_repo_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        skill_state,
        ("v1.0.0".into(), "original-target-hash".into())
    );
    assert_eq!(
        target
            .query_row(
                "SELECT COUNT(*) FROM skills WHERE id = 'migration-invalid-skill'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        load_user_note(&target, "repository", &original_repo_id).unwrap(),
        ""
    );
}

#[test]
fn migration_round_trips_skill_update_metadata_but_excludes_active_conflicts() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    let remote = remote_for_skill_sync_status();
    let scans = sync_status_scan("v2.0.0", "remote-hash");
    let repo_id_value = save_repository_with_account(&source, &remote, &scans, None, "").unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    source
        .execute(
            "UPDATE skills
                 SET installed = 1,
                     status = 'update-conflict',
                     local_version = 'v1-local',
                     installed_hash = 'local-machine-hash',
                     install_path = '/Users/source-machine/SkillRepoTracker/skills/demo-skill',
                     remote_hash = 'remote-hash',
                     handled_remote_sha = 'handled-sha',
                     handled_remote_hash = 'handled-hash'
                 WHERE id = ?1",
            params![id],
        )
        .unwrap();
    source
        .execute(
            "INSERT INTO skill_update_conflicts
                 (id, skill_id, task_id, status, local_hash, remote_sha, remote_hash,
                  verification_state, created_at, updated_at)
                 VALUES ('conflict-secret-id', ?1, 'task-secret-id', 'pending', 'local-hash',
                         'remote-sha', 'remote-hash', 'pending', '2026-08-28T00:00:00Z',
                         '2026-08-28T00:00:00Z')",
            params![id],
        )
        .unwrap();

    let package = build_migration_package(&source).unwrap();
    let exported = package.skills.iter().find(|skill| skill.id == id).unwrap();
    assert_eq!(exported.remote_hash.as_deref(), Some("remote-hash"));
    assert_eq!(exported.handled_remote_sha.as_deref(), Some("handled-sha"));
    assert_eq!(
        exported.handled_remote_hash.as_deref(),
        Some("handled-hash")
    );
    assert!(!exported.installed);
    assert_eq!(exported.status, "not-installed");
    assert!(exported.local_version.is_none());
    assert!(exported.installed_hash.is_none());
    assert!(exported.install_path.is_none());
    let json = serde_json::to_string(&package).unwrap();
    assert!(!json.contains("skillUpdateConflicts"));
    assert!(!json.contains("conflict-secret-id"));
    assert!(!json.contains("task-secret-id"));
    assert!(!json.contains("/Users/source-machine"));
    assert!(!json.contains("update-conflict"));

    let target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    merge_migration_package(&target, &parse_migration_package(&json).unwrap()).unwrap();
    let imported: (
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = target
        .query_row(
            "SELECT installed, status, install_path, remote_hash,
                        handled_remote_sha, handled_remote_hash
                 FROM skills WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        imported,
        (
            0,
            "not-installed".into(),
            None,
            Some("remote-hash".into()),
            Some("handled-sha".into()),
            Some("handled-hash".into())
        )
    );

    let mut legacy_value = serde_json::to_value(&package).unwrap();
    let legacy_skill = legacy_value
        .get_mut("skills")
        .and_then(|skills| skills.as_array_mut())
        .and_then(|skills| skills.first_mut())
        .and_then(|skill| skill.as_object_mut())
        .unwrap();
    legacy_skill.remove("remoteHash");
    legacy_skill.remove("handledRemoteSha");
    legacy_skill.remove("handledRemoteHash");
    let legacy = parse_migration_package(&legacy_value.to_string()).unwrap();
    assert!(legacy.skills[0].remote_hash.is_none());
    assert!(legacy.skills[0].handled_remote_sha.is_none());
    assert!(legacy.skills[0].handled_remote_hash.is_none());
}

#[test]
fn migration_import_preserves_existing_machine_local_skill_state() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    let remote = remote_for_skill_sync_status();
    let repo_id_value = save_repository_with_account(
        &source,
        &remote,
        &sync_status_scan("v2.0.0", "remote-v2"),
        None,
        "",
    )
    .unwrap();
    let id = skill_id(&repo_id_value, "skills/demo-skill");
    let package = build_migration_package(&source).unwrap();

    let target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    save_repository_with_account(
        &target,
        &remote,
        &sync_status_scan("v1.0.0", "remote-v1"),
        None,
        "",
    )
    .unwrap();
    target
        .execute(
            "UPDATE skills
                 SET installed = 1,
                     status = 'installed-customized',
                     local_version = 'v1-custom',
                     installed_hash = 'target-local-hash',
                     install_path = '/Users/target-machine/skills/demo-skill',
                     handled_remote_sha = 'target-handled-sha',
                     handled_remote_hash = 'target-handled-hash'
                 WHERE id = ?1",
            params![id],
        )
        .unwrap();

    merge_migration_package(&target, &package).unwrap();

    type MigratedLocalSkillState = (
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let state: MigratedLocalSkillState = target
        .query_row(
            "SELECT installed, status, installed_hash, install_path, remote_hash,
                        handled_remote_sha, handled_remote_hash
                 FROM skills WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(state.0, 1);
    assert_eq!(state.1, "installed-customized");
    assert_eq!(state.2.as_deref(), Some("target-local-hash"));
    assert_eq!(
        state.3.as_deref(),
        Some("/Users/target-machine/skills/demo-skill")
    );
    assert_eq!(state.4.as_deref(), Some("remote-v2"));
    assert_eq!(state.5.as_deref(), Some("target-handled-sha"));
    assert_eq!(state.6.as_deref(), Some("target-handled-hash"));
}

#[test]
fn migration_import_normalizes_legacy_active_conflict_without_local_files() {
    let source = Connection::open_in_memory().unwrap();
    migrate(&source).unwrap();
    let remote = remote_for_skill_sync_status();
    save_repository_with_account(
        &source,
        &remote,
        &sync_status_scan("v2.0.0", "remote-v2"),
        None,
        "",
    )
    .unwrap();
    let mut package = build_migration_package(&source).unwrap();
    let transported = package.skills.first_mut().unwrap();
    transported.installed = true;
    transported.status = "update-conflict".into();
    transported.local_version = Some("source-local".into());
    transported.installed_hash = Some("source-local-hash".into());
    transported.install_path = Some("/Users/source-machine/skills/demo-skill".into());

    let target = Connection::open_in_memory().unwrap();
    migrate(&target).unwrap();
    merge_migration_package(&target, &package).unwrap();

    let state: (i64, String, Option<String>, Option<String>) = target
        .query_row(
            "SELECT installed, status, installed_hash, install_path FROM skills LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(state, (0, "not-installed".into(), None, None));
    let conflict_count: i64 = target
        .query_row("SELECT COUNT(*) FROM skill_update_conflicts", [], |row| {
            row.get(0)
        })
        .unwrap();
    let waiting_count: i64 = target
        .query_row(
            "SELECT COUNT(*) FROM backup_jobs WHERE status = 'waiting-user'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(conflict_count, 0);
    assert_eq!(waiting_count, 0);
}

#[test]
fn migration_adds_local_source_columns() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let mut stmt = conn.prepare("PRAGMA table_info(skills)").unwrap();
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(columns.contains(&"source_type".to_string()));
    assert!(columns.contains(&"install_path".to_string()));
    assert!(columns.contains(&"deleted_at".to_string()));
    assert!(columns.contains(&"deleted_path".to_string()));
    assert!(columns.contains(&"sync_targets_mode".to_string()));
    assert!(columns.contains(&"sync_targets".to_string()));
    assert!(columns.contains(&"created_at".to_string()));
    assert!(columns.contains(&"search_text".to_string()));

    let mut stmt = conn.prepare("PRAGMA table_info(repositories)").unwrap();
    let repo_columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(repo_columns.contains(&"github_account_id".to_string()));
    assert!(repo_columns.contains(&"readme_search_text".to_string()));

    let mut stmt = conn
        .prepare("PRAGMA table_info(github_repo_catalog)")
        .unwrap();
    let catalog_columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(catalog_columns.contains(&"starred_at".to_string()));
    assert!(catalog_columns.contains(&"readme_search_text".to_string()));

    let mut stmt = conn.prepare("PRAGMA table_info(plugins)").unwrap();
    let plugin_columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(plugin_columns.contains(&"created_at".to_string()));
    assert!(plugin_columns.contains(&"search_text".to_string()));

    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_sync_records'",
        )
        .unwrap();
    let table_name: Option<String> = stmt.query_row([], |row| row.get(0)).optional().unwrap();
    assert_eq!(table_name.as_deref(), Some("skill_sync_records"));

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_accounts'")
        .unwrap();
    let account_table: Option<String> = stmt.query_row([], |row| row.get(0)).optional().unwrap();
    assert_eq!(account_table.as_deref(), Some("github_accounts"));

    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_repo_catalog'",
        )
        .unwrap();
    let catalog_table: Option<String> = stmt.query_row([], |row| row.get(0)).optional().unwrap();
    assert_eq!(catalog_table.as_deref(), Some("github_repo_catalog"));

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugins'")
        .unwrap();
    let plugin_table: Option<String> = stmt.query_row([], |row| row.get(0)).optional().unwrap();
    assert_eq!(plugin_table.as_deref(), Some("plugins"));

    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_skill_links'",
        )
        .unwrap();
    let plugin_link_table: Option<String> =
        stmt.query_row([], |row| row.get(0)).optional().unwrap();
    assert_eq!(plugin_link_table.as_deref(), Some("plugin_skill_links"));

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_notes'")
        .unwrap();
    let user_notes_table: Option<String> = stmt.query_row([], |row| row.get(0)).optional().unwrap();
    assert_eq!(user_notes_table.as_deref(), Some("user_notes"));
}

#[test]
fn migration_adds_persistent_skill_update_conflict_state() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();

    let mut stmt = conn.prepare("PRAGMA table_info(skills)").unwrap();
    let skill_columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(skill_columns.contains(&"remote_hash".to_string()));
    assert!(skill_columns.contains(&"handled_remote_sha".to_string()));
    assert!(skill_columns.contains(&"handled_remote_hash".to_string()));

    let mut stmt = conn
        .prepare("PRAGMA table_info(skill_update_conflicts)")
        .unwrap();
    let conflict_columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for column in [
        "id",
        "skill_id",
        "task_id",
        "status",
        "local_hash",
        "installed_hash",
        "remote_sha",
        "remote_hash",
        "verification_state",
        "verified_local_hash",
        "created_at",
        "updated_at",
        "verified_at",
        "resolved_at",
    ] {
        assert!(
            conflict_columns.contains(&column.to_string()),
            "missing conflict column {column}"
        );
    }
}

#[test]
fn skill_action_outcome_is_a_strict_tagged_wire_contract() {
    let value = serde_json::to_value(SkillActionOutcome::Updated { skills: Vec::new() }).unwrap();

    assert_eq!(
        value,
        serde_json::json!({ "kind": "updated", "skills": [] })
    );
}

#[test]
fn backfills_added_time_and_search_text_metadata() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute(
            "INSERT INTO repositories
             (id, name, owner, repo, ref_name, repo_type, skills_count, remote_sha, url, branch, created_at, updated_at)
             VALUES ('repo-1', 'example/repo', 'example', 'repo', 'main', 'skill repo', 1, 'abc', 'https://github.com/example/repo', 'main', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')",
            [],
        )
        .unwrap();
    conn.execute(
            "INSERT INTO skills
             (id, repo_id, name, description, repo_name, path, ref_name, remote_version, status, updated_at)
             VALUES ('skill-1', 'repo-1', 'DemoSkill', 'Skill description', 'example/repo', '.', 'main', 'v1', 'not-installed', '2026-07-03T00:00:00Z')",
            [],
        )
        .unwrap();
    conn.execute(
            "INSERT INTO plugins
             (id, repo_id, name, description, kind, install_command, source_path, source_excerpt, status, detected_sha, updated_at)
             VALUES ('plugin-1', 'repo-1', 'DemoPlugin', 'Plugin description', 'codex-marketplace', '/plugin install demo', 'README.md', 'README plugin excerpt', 'detected', 'abc', '2026-07-04T00:00:00Z')",
            [],
        )
        .unwrap();

    backfill_search_metadata(&conn).unwrap();

    let skill: (String, String) = conn
        .query_row(
            "SELECT created_at, search_text FROM skills WHERE id = 'skill-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(skill.0, "2026-07-03T00:00:00Z");
    assert_eq!(skill.1, "Skill description");

    let plugin: (String, String) = conn
        .query_row(
            "SELECT created_at, search_text FROM plugins WHERE id = 'plugin-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(plugin.0, "2026-07-04T00:00:00Z");
    assert_eq!(plugin.1, "README plugin excerpt");
}

#[test]
fn preferred_github_account_uses_verified_account_first() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let unverified = GithubAccountRecord {
        id: "github:unverified".into(),
        login: "unverified".into(),
        display_name: "Unverified".into(),
        avatar_url: None,
        token_key: github_account_token_key("github:unverified"),
        status: "saved_unverified".into(),
        scopes: "repo".into(),
        last_verified: None,
        is_default: false,
    };
    let verified = GithubAccountRecord {
        id: "github:verified".into(),
        login: "verified".into(),
        display_name: "Verified".into(),
        avatar_url: None,
        token_key: github_account_token_key("github:verified"),
        status: "verified".into(),
        scopes: "repo".into(),
        last_verified: Some("2026-07-08T00:00:00Z".into()),
        is_default: false,
    };
    upsert_github_account(&conn, &unverified).unwrap();
    upsert_github_account(&conn, &verified).unwrap();

    let preferred = preferred_github_account(&conn).unwrap().unwrap();

    assert_eq!(preferred.id, "github:verified");
}

#[test]
fn repository_save_backfills_and_preserves_github_account_binding() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let account = GithubAccountRecord {
        id: "github:octocat".into(),
        login: "octocat".into(),
        display_name: "Octocat".into(),
        avatar_url: None,
        token_key: github_account_token_key("github:octocat"),
        status: "verified".into(),
        scopes: "repo".into(),
        last_verified: Some("2026-07-08T00:00:00Z".into()),
        is_default: false,
    };
    upsert_github_account(&conn, &account).unwrap();
    let remote = RemoteInfo {
        owner: "octocat".into(),
        repo: "Hello-World".into(),
        full_name: "octocat/Hello-World".into(),
        default_branch: "main".into(),
        resolved_ref: "main".into(),
        sha: "bf4e9ac4d4428bda261afcfe981871ceb92d94e6".into(),
    };

    let saved_id =
        save_repository_with_account(&conn, &remote, &[], Some(&account.id), "").unwrap();
    let stored_account: Option<String> = conn
        .query_row(
            "SELECT github_account_id FROM repositories WHERE id = ?1",
            params![saved_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_account.as_deref(), Some("github:octocat"));

    save_repository_with_account(&conn, &remote, &[], None, "").unwrap();
    let preserved_account: Option<String> = conn
        .query_row(
            "SELECT github_account_id FROM repositories WHERE id = ?1",
            params![repo_id("octocat", "Hello-World", "main")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preserved_account.as_deref(), Some("github:octocat"));
}

#[test]
fn classifies_github_auth_and_rate_limit_rejections() {
    let mut anonymous_headers = HeaderMap::new();
    anonymous_headers.insert("x-ratelimit-limit", HeaderValue::from_static("60"));
    anonymous_headers.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
    anonymous_headers.insert("x-ratelimit-reset", HeaderValue::from_static("1783512000"));

    let error = classify_github_rejection(401, &HeaderMap::new(), "", "repo_account").unwrap();
    assert_eq!(error.code, "github_token_invalid");

    let error = classify_github_rejection(403, &anonymous_headers, "", "none").unwrap();
    assert_eq!(error.code, "github_unauthenticated_rate_limited");
    assert!(error
        .details
        .unwrap()
        .contains("x-ratelimit-reset=1783512000"));
    let error = classify_github_rejection(403, &anonymous_headers, "", "repo_account").unwrap();
    assert_eq!(error.code, "github_token_not_applied_rate_limited");

    let mut authenticated_headers = HeaderMap::new();
    authenticated_headers.insert("x-ratelimit-limit", HeaderValue::from_static("5000"));
    authenticated_headers.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
    let error =
        classify_github_rejection(403, &authenticated_headers, "", "default_account").unwrap();
    assert_eq!(error.code, "github_authenticated_rate_limited");

    let error = classify_github_rejection(
        403,
        &HeaderMap::new(),
        r#"{"message":"You have exceeded a secondary rate limit"}"#,
        "repo_account",
    )
    .unwrap();
    assert_eq!(error.code, "github_secondary_rate_limited");

    let error = classify_github_rejection(
        403,
        &HeaderMap::new(),
        "Resource not accessible",
        "repo_account",
    )
    .unwrap();
    assert_eq!(error.code, "github_forbidden");

    let error = classify_github_rejection(429, &HeaderMap::new(), "", "repo_account").unwrap();
    assert_eq!(error.code, "github_secondary_rate_limited");
}

#[test]
fn global_github_rejections_stop_batch_checks_without_repeating_failures() {
    let rate_error = AppError::new(
            "github_unauthenticated_rate_limited",
            "本次 GitHub 请求落到匿名配额（60 次/小时），请确认仓库已绑定 GitHub 账号或重新验证 token。",
        );
    assert!(is_global_github_rejection(&rate_error));
    assert_eq!(
            format_skipped_github_check("example/repo", &rate_error),
            "example/repo skipped: same GitHub request block as earlier item [github_unauthenticated_rate_limited]"
        );

    let not_found = AppError::new("github_not_found", "仓库不存在或无访问权限。");
    assert!(!is_global_github_rejection(&not_found));
}

#[test]
fn keychain_missing_auth_is_not_reported_as_unconfigured() {
    let auth = GithubAuth::keychain_missing("github:octocat".into());
    let error = auth.usable().unwrap_err();
    assert_eq!(auth.label(), "keychain_missing");
    assert_eq!(error.code, "github_token_keychain_missing");
    assert_eq!(error.details.as_deref(), Some("auth=keychain_missing"));
}

#[test]
fn tauri_state_commands_use_injected_resources_without_external_side_effects() {
    struct MemoryCredentials;

    impl adapters::CredentialStore for MemoryCredentials {
        fn get(&self, _service: &str, _key: &str) -> Result<Option<String>, String> {
            Ok(None)
        }

        fn set(&self, _service: &str, _key: &str, _secret: &str) -> Result<(), String> {
            Ok(())
        }

        fn delete(&self, _service: &str, _key: &str) -> Result<(), String> {
            Ok(())
        }
    }

    struct UnusedGithub;

    impl adapters::GithubHttpAdapter for UnusedGithub {
        fn execute(&self, _request: reqwest::Request) -> adapters::GithubHttpFuture<'_> {
            panic!("this deterministic command test must not make GitHub requests")
        }
    }

    let sandbox = tempfile::tempdir().unwrap();
    let missing_backup_root = sandbox.path().join("missing-backup-root");
    let state = AppState::new_with_adapters(
        sandbox.path().join("data"),
        AppAdapters {
            credentials: Arc::new(MemoryCredentials),
            github: Arc::new(UnusedGithub),
            filesystem: Arc::new(adapters::SystemFilesystem),
        },
    )
    .unwrap();
    set_setting(
        &state.db.lock().unwrap(),
        "backup_root",
        path_string(&missing_backup_root),
    )
    .unwrap();

    let app = tauri::test::mock_builder()
        .manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    let updated = update_settings(
        UpdateSettingsRequest {
            backup_root: None,
            skills_root: None,
            skill_library_root: None,
            default_sync_targets: None,
            sync_backup_keep: None,
            auto_check_interval: Some(7),
            auto_check_enabled: Some(true),
            auto_backup_enabled: Some(true),
        },
        app.state(),
    );
    assert!(updated.ok);
    let settings = updated.data.unwrap();
    assert_eq!(settings.auto_check_interval, 15);
    assert!(settings.auto_check_enabled);
    assert!(settings.auto_backup_enabled);

    let cleared = clear_github_token(app.state());
    assert!(cleared.ok);
    assert!(cleared.data.is_some());

    let opened = open_backup_folder(
        backup_paths::OpenBackupFolderRequest {
            repository_id: None,
        },
        app.state(),
    );
    assert!(!opened.ok);
    assert_eq!(
        opened.error.as_ref().map(|error| error.code.as_str()),
        Some("backup_root_unavailable")
    );
}
