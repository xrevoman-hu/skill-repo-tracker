use super::*;

#[test]
fn migration_is_atomic_idempotent_and_integrity_checked() {
    let conn = Connection::open_in_memory().unwrap();
    migrate_prompt_library(&conn).unwrap();
    migrate_prompt_library(&conn).unwrap();
    prompt_fts_integrity_check(&conn).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, PROMPT_SCHEMA_USER_VERSION);
    assert_eq!(library_revision(&conn).unwrap(), 0);

    let broken = Connection::open_in_memory().unwrap();
    broken
        .execute_batch("CREATE TABLE prompt_tags(id TEXT PRIMARY KEY);")
        .unwrap();
    let error = migrate_prompt_library(&broken).unwrap_err();
    assert_eq!(error.code, "prompt_schema_incompatible");
    let prompts_created: bool = broken
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'prompts')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !prompts_created,
        "failed migration must roll back new tables"
    );
}

#[test]
fn newer_prompt_schema_is_rejected_without_mutating_the_database_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("future-prompt-schema.sqlite");
    let conn = Connection::open(&path).unwrap();
    let initial_journal_mode: String = conn
        .query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))
        .unwrap();
    assert_eq!(initial_journal_mode, "delete");
    conn.execute_batch(
        "CREATE TABLE future_prompt_sentinel (
           id INTEGER PRIMARY KEY,
           value TEXT NOT NULL
         );
         INSERT INTO future_prompt_sentinel(id, value)
         VALUES (1, 'must remain unchanged');
         PRAGMA user_version = 4;",
    )
    .unwrap();
    drop(conn);

    let conn = Connection::open(&path).unwrap();
    let error = migrate_prompt_library(&conn)
        .expect_err("a prompt schema from a newer app must be rejected");
    assert_eq!(error.code, "prompt_schema_incompatible");
    assert_eq!(
        error.details.as_deref(),
        Some("user_version=4, supported_max=3")
    );
    drop(conn);

    let conn = Connection::open(&path).unwrap();
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal_mode, "delete");
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(user_version, 4);
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(tables, vec!["future_prompt_sentinel"]);
    let sentinel: String = conn
        .query_row(
            "SELECT value FROM future_prompt_sentinel WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(sentinel, "must remain unchanged");
}

#[test]
fn v2_schema_migrates_to_manual_order_without_changing_visible_order() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        PRAGMA user_version = 2;
        CREATE TABLE prompts (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (length(title) BETWEEN 1 AND 200),
          CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 5242880)
        );
        INSERT INTO prompts
          (id, title, content, excerpt, pinned, revision, created_at, updated_at)
        VALUES
          ('normal-older', '普通旧', '正文', '正文', 0, 1, '2026-01-01', '2026-01-01'),
          ('normal-newer', '普通新', '正文', '正文', 0, 1, '2026-01-01', '2026-01-02'),
          ('pinned-older', '置顶旧', '正文', '正文', 1, 1, '2026-01-01', '2026-01-01'),
          ('pinned-newer', '置顶新', '正文', '正文', 1, 1, '2026-01-01', '2026-01-02');
        "#,
    )
    .unwrap();

    migrate_prompt_library(&conn).unwrap();

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 3);
    let manual_order_column_exists: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM pragma_table_info('prompts') WHERE name = 'manual_order'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(manual_order_column_exists);
    let manual_index_exists: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_master
               WHERE type = 'index' AND name = 'prompts_manual_sort_idx'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(manual_index_exists);

    let ids = list_prompts(&conn, &PromptListRequest::default())
        .unwrap()
        .items
        .into_iter()
        .map(|prompt| prompt.id)
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "pinned-newer",
            "pinned-older",
            "normal-newer",
            "normal-older",
        ]
    );
}
