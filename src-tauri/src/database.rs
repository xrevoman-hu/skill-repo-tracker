use rusqlite::{params, Connection, OptionalExtension};

use crate::{utc_now, AppError};

const CORE_SCHEMA_BASELINE_VERSION: i64 = 1;
const CORE_SCHEMA_BASELINE_NAME: &str = "legacy-v1.2.2-baseline";
const MIGRATION_SAVEPOINT: &str = "skill_repo_tracker_core_migration";

/// Records the published idempotent core upgrader as an immutable baseline.
/// Once that baseline exists, startup only validates history and never replays
/// editable legacy upgrade code. Initial upgrade and ledger creation share one
/// savepoint. Prompt migrations intentionally use their own version domain.
pub(super) fn run_core_migrations(
    conn: &Connection,
    legacy_upgrade: impl FnOnce(&Connection) -> Result<(), AppError>,
) -> Result<(), AppError> {
    conn.execute_batch(&format!("SAVEPOINT {MIGRATION_SAVEPOINT}"))?;
    let result = (|| {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL UNIQUE,
               applied_at TEXT NOT NULL
             )",
        )?;
        let unknown_migration = conn
            .query_row(
                "SELECT version, name FROM schema_migrations
                 WHERE version <> ?1 ORDER BY version LIMIT 1",
                params![CORE_SCHEMA_BASELINE_VERSION],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((version, name)) = unknown_migration {
            return Err(AppError::with_details(
                "schema_migration_history_conflict",
                "数据库迁移历史与当前应用不兼容。",
                format!("unknown_version={version} name={name}"),
            ));
        }
        let recorded_name = conn
            .query_row(
                "SELECT name FROM schema_migrations WHERE version = ?1",
                params![CORE_SCHEMA_BASELINE_VERSION],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if recorded_name.as_deref() == Some(CORE_SCHEMA_BASELINE_NAME) {
            return Ok(());
        }
        if let Some(recorded_name) = recorded_name {
            return Err(AppError::with_details(
                "schema_migration_history_conflict",
                "数据库迁移历史与当前应用不兼容。",
                format!(
                    "version={} expected={} actual={}",
                    CORE_SCHEMA_BASELINE_VERSION, CORE_SCHEMA_BASELINE_NAME, recorded_name
                ),
            ));
        }

        legacy_upgrade(conn)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at)
             VALUES (?1, ?2, ?3)",
            params![
                CORE_SCHEMA_BASELINE_VERSION,
                CORE_SCHEMA_BASELINE_NAME,
                utc_now()
            ],
        )?;
        Ok(())
    })();

    match result {
        Ok(()) => match conn.execute_batch(&format!("RELEASE {MIGRATION_SAVEPOINT}")) {
            Ok(()) => Ok(()),
            Err(release_error) => {
                match conn.execute_batch(&format!(
                    "ROLLBACK TO {MIGRATION_SAVEPOINT}; RELEASE {MIGRATION_SAVEPOINT}"
                )) {
                    Ok(()) => Err(release_error.into()),
                    Err(rollback_error) => Err(AppError::with_details(
                        "sqlite_error",
                        "SQLite 操作失败。",
                        format!(
                            "migration release failed: {release_error}; rollback failed: {rollback_error}"
                        ),
                    )),
                }
            }
        },
        Err(error) => match conn.execute_batch(&format!(
            "ROLLBACK TO {MIGRATION_SAVEPOINT}; RELEASE {MIGRATION_SAVEPOINT}"
        )) {
            Ok(()) => Err(error),
            Err(rollback_error) => {
                let rollback_details = format!("migration rollback failed: {rollback_error}");
                let details = match error.details {
                    Some(original_details) => {
                        format!("{original_details}; {rollback_details}")
                    }
                    None => rollback_details,
                };
                Err(AppError::with_details(error.code, error.message, details))
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::{
        get_setting, migrate, path_string, seed_settings, set_setting, settings_from_db,
        sync_targets_from_db, UpdateSettingsRequest,
    };

    const CORE_SCHEMA_FIXTURES: [(&str, &str); 3] = [
        (
            "v1.1.12",
            include_str!("../tests/fixtures/core-schema/v1.1.12.sql"),
        ),
        (
            "v1.2.0",
            include_str!("../tests/fixtures/core-schema/v1.2.0.sql"),
        ),
        (
            "v1.2.2",
            include_str!("../tests/fixtures/core-schema/v1.2.2.sql"),
        ),
    ];

    #[test]
    fn rejects_a_rewritten_published_migration() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL UNIQUE,
               applied_at TEXT NOT NULL
             );
             INSERT INTO schema_migrations(version, name, applied_at)
             VALUES (1, 'rewritten-history', '2026-01-01T00:00:00Z');",
        )
        .unwrap();
        let legacy_called = Cell::new(false);

        let error = run_core_migrations(&conn, |_| {
            legacy_called.set(true);
            Ok(())
        })
        .unwrap_err();

        assert_eq!(error.code, "schema_migration_history_conflict");
        assert!(!legacy_called.get());
    }

    #[test]
    fn rejects_an_unknown_future_migration_instead_of_opening_a_newer_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL UNIQUE,
               applied_at TEXT NOT NULL
             );
             INSERT INTO schema_migrations(version, name, applied_at) VALUES
               (1, 'legacy-v1.2.2-baseline', '2026-01-01T00:00:00Z'),
               (2, 'future-schema-owned-by-a-newer-app', '2026-09-02T00:00:00Z');",
        )
        .unwrap();
        let legacy_called = Cell::new(false);

        let error = run_core_migrations(&conn, |_| {
            legacy_called.set(true);
            Ok(())
        })
        .unwrap_err();

        assert_eq!(error.code, "schema_migration_history_conflict");
        assert!(!legacy_called.get());
    }

    #[test]
    fn recorded_baseline_never_replays_the_legacy_upgrade() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL UNIQUE,
               applied_at TEXT NOT NULL
             );
             INSERT INTO schema_migrations(version, name, applied_at)
             VALUES (1, 'legacy-v1.2.2-baseline', '2026-01-01T00:00:00Z');",
        )
        .unwrap();
        let legacy_called = Cell::new(false);

        run_core_migrations(&conn, |_| {
            legacy_called.set(true);
            Ok(())
        })
        .unwrap();

        assert!(!legacy_called.get());
    }

    #[test]
    fn legacy_noop_settings_remain_stored_but_leave_the_wire_contract() {
        let home = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        seed_settings(
            &conn,
            home.path(),
            &home.path().join("backups"),
            &home.path().join("skills"),
        )
        .unwrap();
        for (key, value) in [("concurrency", 9), ("retry_count", 4), ("cleanup_keep", 88)] {
            set_setting(&conn, key, value).unwrap();
        }

        let serialized = serde_json::to_value(settings_from_db(&conn, false).unwrap()).unwrap();
        assert!(serialized.get("concurrency").is_none());
        assert!(serialized.get("retryCount").is_none());
        assert!(serialized.get("cleanupKeep").is_none());
        assert_eq!(
            get_setting(&conn, "concurrency").unwrap().as_deref(),
            Some("9")
        );
        assert_eq!(
            get_setting(&conn, "retry_count").unwrap().as_deref(),
            Some("4")
        );
        assert_eq!(
            get_setting(&conn, "cleanup_keep").unwrap().as_deref(),
            Some("88")
        );
    }

    #[test]
    fn seeds_library_and_default_sync_targets() {
        let home = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let backup_root = home.path().join("SkillRepoBackups");
        let library_root = home.path().join("SkillRepoTracker").join("skills");

        seed_settings(&conn, home.path(), &backup_root, &library_root).unwrap();

        assert_eq!(
            get_setting(&conn, "skill_library_root").unwrap(),
            Some(path_string(&library_root))
        );
        assert_eq!(sync_targets_from_db(&conn).unwrap(), ["claude", "codex"]);
    }

    #[test]
    fn settings_wire_contract_rejects_removed_noop_fields() {
        for removed_field in ["concurrency", "retryCount", "cleanupKeep"] {
            assert!(serde_json::from_value::<UpdateSettingsRequest>(
                serde_json::json!({ removed_field: 3 })
            )
            .is_err());
        }
    }

    #[test]
    fn core_baseline_is_append_only_and_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();

        let rows: Vec<(i64, String)> = conn
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, vec![(1, CORE_SCHEMA_BASELINE_NAME.to_string())]);
    }

    #[test]
    fn failed_core_upgrade_rolls_back_without_a_ledger() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE migration_fixture_anchor (
               id INTEGER PRIMARY KEY
             );
             INSERT INTO migration_fixture_anchor(id) VALUES (1);
             CREATE TABLE schema_migrations (
               version INTEGER PRIMARY KEY,
               name TEXT NOT NULL UNIQUE,
               applied_at TEXT NOT NULL
             );
             CREATE TRIGGER reject_core_baseline
             BEFORE INSERT ON schema_migrations
             BEGIN SELECT RAISE(FAIL, 'forced migration failure'); END;",
        )
        .unwrap();

        let error = run_core_migrations(&conn, |conn| {
            conn.execute_batch(
                "CREATE TABLE fictional_core_upgrade (
                   id INTEGER PRIMARY KEY,
                   value TEXT NOT NULL
                 );
                 INSERT INTO fictional_core_upgrade(id, value)
                 VALUES (1, 'must roll back');
                 ALTER TABLE migration_fixture_anchor
                 ADD COLUMN fictional_upgrade_value TEXT;",
            )?;
            Ok(())
        })
        .expect_err("the injected ledger failure must roll back the legacy upgrade");

        assert_eq!(error.code, "sqlite_error");
        let ledger_exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(ledger_exists, 0);
        let fictional_table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'fictional_core_upgrade'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fictional_table_exists, 0);
        let fictional_column_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('migration_fixture_anchor')
                 WHERE name = 'fictional_upgrade_value'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fictional_column_exists, 0);
        let anchor_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM migration_fixture_anchor", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(anchor_rows, 1);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn legacy_error_preserves_rollback_failure_diagnostics() {
        let conn = Connection::open_in_memory().unwrap();

        let error = run_core_migrations(&conn, |conn| {
            conn.execute_batch(&format!("RELEASE {MIGRATION_SAVEPOINT}"))?;
            Err(AppError::with_details(
                "legacy_upgrade_failed",
                "旧数据库升级失败。",
                "original_failure=sentinel",
            ))
        })
        .expect_err("the injected legacy failure must be returned");

        assert_eq!(error.code, "legacy_upgrade_failed");
        let details = error.details.as_deref().unwrap_or_default();
        assert!(details.contains("original_failure=sentinel"));
        assert!(details.contains("migration rollback failed"));
        assert!(details.contains("no such savepoint"));
        assert!(conn.is_autocommit());
    }

    #[test]
    fn release_failure_rolls_back_the_outer_migration_savepoint() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

        let error = run_core_migrations(&conn, |conn| {
            conn.execute_batch(
                "CREATE TABLE migration_release_parent (
                   id INTEGER PRIMARY KEY
                 );
                 CREATE TABLE migration_release_child (
                   parent_id INTEGER NOT NULL
                     REFERENCES migration_release_parent(id)
                     DEFERRABLE INITIALLY DEFERRED
                 );
                 INSERT INTO migration_release_child(parent_id) VALUES (404);",
            )?;
            Ok(())
        })
        .expect_err("the deferred foreign key must reject the outer RELEASE");

        assert_eq!(error.code, "sqlite_error");
        assert!(conn.is_autocommit());
        let persisted_migration_objects: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE name IN (
                   'schema_migrations',
                   'migration_release_parent',
                   'migration_release_child'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(persisted_migration_objects, 0);
    }

    #[test]
    fn published_core_schema_fixtures_upgrade_without_data_loss() {
        for (version, fixture) in CORE_SCHEMA_FIXTURES {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(fixture).unwrap();

            migrate(&conn).unwrap();
            migrate(&conn).unwrap();

            let repository: (String, String, String, String, String) = conn
                .query_row(
                    "SELECT name, remote_sha, last_backup_sha, url, source_type
                     FROM repositories WHERE id = 'github:fixture/repository:main'",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .unwrap();
            assert_eq!(repository.0, "Fixture Repository", "fixture={version}");
            assert_eq!(repository.1, "fixture-remote-sha", "fixture={version}");
            assert_eq!(repository.2, "fixture-backup-sha", "fixture={version}");
            assert_eq!(
                repository.3, "https://github.com/fixture/repository",
                "fixture={version}"
            );
            assert_eq!(repository.4, "github", "fixture={version}");
            assert_eq!(
                get_setting(&conn, "fixture_version").unwrap().as_deref(),
                Some(version)
            );
            assert_eq!(
                get_setting(&conn, "concurrency").unwrap().as_deref(),
                Some("7")
            );
            assert_eq!(
                get_setting(&conn, "retry_count").unwrap().as_deref(),
                Some("3")
            );
            assert_eq!(
                get_setting(&conn, "cleanup_keep").unwrap().as_deref(),
                Some("42")
            );
            let note: String = conn
                .query_row(
                    "SELECT note FROM user_notes
                     WHERE scope = 'repository' AND entity_key = 'github:fixture/repository'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(note, "fictional compatibility note", "fixture={version}");
            let baseline: String = conn
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(baseline, CORE_SCHEMA_BASELINE_NAME, "fixture={version}");

            for table in [
                "repositories",
                "skills",
                "skill_sync_records",
                "skill_update_conflicts",
                "plugins",
                "plugin_skill_links",
                "user_notes",
                "backup_jobs",
                "backup_job_items",
                "task_logs",
                "settings",
                "github_accounts",
                "github_repo_catalog",
                "backup_manifests",
                "schedules",
            ] {
                let count: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert!(count > 0, "fixture={version}; table={table}");
            }

            let skill_graph: i64 = conn
                .query_row(
                    "SELECT COUNT(*)
                     FROM repositories r
                     JOIN skills s ON s.repo_id = r.id
                     JOIN skill_sync_records sr ON sr.skill_id = s.id
                     JOIN skill_update_conflicts c ON c.skill_id = s.id
                     JOIN plugins p ON p.repo_id = r.id
                     JOIN plugin_skill_links pl ON pl.plugin_id = p.id AND pl.skill_id = s.id
                     WHERE r.id = 'github:fixture/repository:main'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(skill_graph, 1, "fixture={version}");
            let account_graph: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM repositories r
                     JOIN github_accounts a ON a.id = r.github_account_id
                     JOIN github_repo_catalog c ON c.account_id = a.id
                     WHERE c.full_name = 'fixture/repository'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(account_graph, 1, "fixture={version}");
            let backup_graph: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM backup_jobs j
                     JOIN backup_job_items i ON i.job_id = j.id
                     JOIN task_logs l ON l.task_id = j.id
                     WHERE j.id = 'job:fixture'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(backup_graph, 1, "fixture={version}");

            let search_backfill: (String, String, String, String) = conn
                .query_row(
                    "SELECT s.created_at, s.search_text, p.created_at, p.search_text
                     FROM skills s JOIN plugins p ON p.repo_id = s.repo_id
                     WHERE s.id = 'skill:fixture' AND p.id = 'plugin:fixture'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap();
            assert!(!search_backfill.0.is_empty(), "fixture={version}");
            assert_eq!(
                search_backfill.1, "fictional skill row",
                "fixture={version}"
            );
            assert!(!search_backfill.2.is_empty(), "fixture={version}");
            assert_eq!(search_backfill.3, "fictional excerpt", "fixture={version}");
            let added_columns: (String, String, String) = conn
                .query_row(
                    "SELECT s.sync_targets_mode, r.github_account_id, j.retry_reason
                     FROM skills s
                     JOIN repositories r ON r.id = s.repo_id
                     JOIN backup_jobs j ON j.id = 'job:fixture'
                     WHERE s.id = 'skill:fixture'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(
                added_columns,
                (
                    "inherit".into(),
                    "github:fixture-account".into(),
                    "fictional retry reason".into()
                ),
                "fixture={version}"
            );
            let mut foreign_keys = conn.prepare("PRAGMA foreign_key_check").unwrap();
            let mut violations = foreign_keys.query([]).unwrap();
            assert!(violations.next().unwrap().is_none(), "fixture={version}");
        }
    }
}
