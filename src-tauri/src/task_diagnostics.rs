use crate::{
    insert_failed_task, load_skill_record, update_skill_inner, AppError, AppState, CommandResult,
    SkillActionMode, SkillActionOutcome, UiTask,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::State;

pub(super) fn format_error_for_log(context: &str, error: &AppError) -> String {
    match &error.details {
        Some(details) => format!(
            "{context} failed: {} [{}] details: {}",
            error.message, error.code, details
        ),
        None => format!("{context} failed: {} [{}]", error.message, error.code),
    }
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<UiTask> {
    Ok(UiTask {
        id: row.get(0)?,
        kind: row.get(1)?,
        target: row.get(2)?,
        progress: row.get(3)?,
        status: row.get(4)?,
        summary: row.get(5)?,
        retryable: row.get::<_, i64>(6)? == 1,
        retry_reason: row.get(7)?,
        log: Vec::new(),
    })
}

fn load_task_log(conn: &Connection, task_id: &str) -> Result<Vec<String>, AppError> {
    let mut stmt =
        conn.prepare("SELECT line FROM task_logs WHERE task_id = ?1 ORDER BY line_no ASC")?;
    let rows = stmt.query_map(params![task_id], |row| row.get(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub(super) fn load_ui_tasks(conn: &Connection) -> Result<Vec<UiTask>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, target, progress, status, summary, retryable, retry_reason
         FROM backup_jobs
         ORDER BY created_at DESC
         LIMIT 100",
    )?;
    let mut tasks = stmt
        .query_map([], task_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    for task in &mut tasks {
        task.log = load_task_log(conn, &task.id)?;
    }
    Ok(tasks)
}

pub(super) fn copy_task_report(conn: &Connection, task_id: &str) -> Result<String, AppError> {
    let mut task = conn
        .query_row(
            "SELECT id, kind, target, progress, status, summary, retryable, retry_reason
             FROM backup_jobs WHERE id = ?1",
            params![task_id],
            task_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::new("task_not_found", "任务不存在。"))?;
    task.log = load_task_log(conn, task_id)?;
    let mut lines = vec![
        format!("Task ID: {}", task.id),
        format!("Type: {}", task.kind),
        format!("Target: {}", task.target),
        format!("Status: {}", task.status),
        format!("Progress: {}", task.progress),
        format!("Summary: {}", task.summary),
        format!("Retryable: {}", task.retryable),
    ];
    if let Some(reason) = task.retry_reason {
        lines.push(format!("Retry reason: {reason}"));
    }
    lines.extend([String::new(), "Log:".into()]);
    if task.log.is_empty() {
        lines.push("No detailed log was saved for this task.".into());
    } else {
        lines.extend(task.log);
    }
    Ok(lines.join("\n"))
}

pub(super) async fn run_skill_action(
    skill_id: String,
    mode: SkillActionMode,
    state: State<'_, AppState>,
) -> CommandResult<SkillActionOutcome> {
    let response = update_skill_inner(skill_id.clone(), mode, state.clone()).await?;
    if let Some(error) = &response.error {
        // The workflow has released its filesystem and database guards. All
        // early and late failures now pass through one audit boundary.
        let db = state.db.lock().expect("db mutex poisoned");
        let skill = load_skill_record(&db, &skill_id).ok().flatten();
        let target = skill
            .as_ref()
            .map(|item| item.name.as_str())
            .unwrap_or(&skill_id);
        let mut log = vec![format!("Skill ID: {skill_id}")];
        if let Some(path) = skill.as_ref().and_then(|item| item.install_path.as_deref()) {
            log.push(format!("target path {path}"));
        }
        insert_failed_task(
            &db,
            "skill",
            match mode {
                SkillActionMode::Install => "Install Skill",
                SkillActionMode::Update => "Update Skill",
            },
            target,
            &AppError {
                code: error.code.clone(),
                message: error.message.clone(),
                details: error.details.clone(),
            },
            log,
        );
    }
    Ok(response)
}
