use crate::{
    adapters::CredentialStore, github_account_by_id, load_ui_github_accounts, set_setting,
    upsert_github_account, utc_now, AppError, GithubAccountRecord, UiGithubAccount,
};
use rusqlite::{params, Connection};
#[cfg(unix)]
use std::os::unix::{fs::OpenOptionsExt, io::AsRawFd};
use std::{
    fs::{File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub(super) struct CredentialMutationLock {
    path: PathBuf,
}

#[derive(Debug)]
struct CredentialMutationGuard {
    file: File,
}
impl CredentialMutationLock {
    pub(super) fn new(data_dir: &Path) -> io::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        Ok(Self {
            path: data_dir.join("skill-credentials.lock"),
        })
    }

    fn acquire(&self) -> io::Result<CredentialMutationGuard> {
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let file = options.open(&self.path)?;
        #[cfg(unix)]
        {
            // SAFETY: file remains open for the complete lifetime of the returned guard.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(not(unix))]
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "credential mutation locks require Unix flock",
        ));
        Ok(CredentialMutationGuard { file })
    }
}
fn acquire_mutation_guard(
    mutation_lock: &CredentialMutationLock,
) -> Result<CredentialMutationGuard, AppError> {
    mutation_lock.acquire().map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock {
            AppError::new(
                "credential_busy",
                "另一实例正在更新 GitHub 凭据，请稍后重试。",
            )
        } else {
            AppError::with_details(
                "credential_lock_failed",
                "无法锁定 GitHub 凭据更新。",
                error.to_string(),
            )
        }
    })
}
impl Drop for CredentialMutationGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        // SAFETY: the descriptor remains valid until this guard finishes dropping.
        let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}
pub(super) fn save_validated_account(
    conn: &Connection,
    mutation_lock: &CredentialMutationLock,
    credentials: &dyn CredentialStore,
    service: &str,
    token: &str,
    mut account: GithubAccountRecord,
) -> Result<Vec<UiGithubAccount>, AppError> {
    let _guard = acquire_mutation_guard(mutation_lock)?;
    let previous_secret = credentials
        .get(service, &account.token_key)
        .map_err(|error| {
            AppError::with_details("token_store_read_failed", "Token 读取失败。", error)
        })?;
    credentials
        .set(service, &account.token_key, token)
        .map_err(|error| AppError::with_details("token_store_failed", "Token 存储失败。", error))?;

    account.is_default = false;
    let database_result = (|| {
        let transaction = conn.unchecked_transaction()?;
        upsert_github_account(&transaction, &account)?;
        set_setting(&transaction, "github_token_configured", "false")?;
        set_setting(&transaction, "github_token_status", "not_configured")?;
        set_setting(&transaction, "github_token_last_verified", "")?;
        let accounts = load_ui_github_accounts(&transaction)?;
        transaction.commit()?;
        Ok(accounts)
    })();
    match database_result {
        Ok(accounts) => Ok(accounts),
        Err(database_error) => {
            let compensation = match previous_secret.as_deref() {
                Some(secret) => credentials.set(service, &account.token_key, secret),
                None => credentials.delete(service, &account.token_key),
            };
            match compensation {
                Ok(()) => Err(database_error),
                Err(compensation_error) => Err(AppError::with_details(
                    "token_store_compensation_failed",
                    "账号保存失败，且 Token 恢复失败。",
                    format!(
                        "database_code={}; database={}; compensation={compensation_error}",
                        database_error.code,
                        database_error
                            .details
                            .as_deref()
                            .unwrap_or(&database_error.message)
                    ),
                )),
            }
        }
    }
}

pub(super) fn refresh_validated_account(
    conn: &Connection,
    mutation_lock: &CredentialMutationLock,
    account_id: &str,
    verified: GithubAccountRecord,
) -> Result<Vec<UiGithubAccount>, AppError> {
    let _guard = acquire_mutation_guard(mutation_lock)?;
    let transaction = conn.unchecked_transaction()?;
    let affected = transaction.execute(
        "UPDATE github_accounts
         SET login = ?2,
             display_name = ?3,
             avatar_url = ?4,
             status = ?5,
             scopes = ?6,
             last_verified = ?7,
             updated_at = ?8
         WHERE id = ?1",
        params![
            account_id,
            verified.login,
            verified.display_name,
            verified.avatar_url,
            verified.status,
            verified.scopes,
            verified.last_verified,
            utc_now(),
        ],
    )?;
    if affected != 1 {
        return Err(AppError::new(
            "github_account_missing",
            "GitHub 账号不存在。",
        ));
    }
    let accounts = load_ui_github_accounts(&transaction)?;
    transaction.commit()?;
    Ok(accounts)
}

pub(super) fn delete_account(
    conn: &Connection,
    mutation_lock: &CredentialMutationLock,
    credentials: &dyn CredentialStore,
    service: &str,
    account_id: &str,
) -> Result<Vec<UiGithubAccount>, AppError> {
    let _guard = acquire_mutation_guard(mutation_lock)?;
    let account = github_account_by_id(conn, account_id)?
        .ok_or_else(|| AppError::new("github_account_missing", "GitHub 账号不存在。"))?;
    let previous_secret = credentials
        .get(service, &account.token_key)
        .map_err(|error| {
            AppError::with_details("token_delete_failed", "Token 读取失败，账号未删除。", error)
        })?;
    credentials
        .delete(service, &account.token_key)
        .map_err(|error| {
            AppError::with_details("token_delete_failed", "Token 删除失败，账号未删除。", error)
        })?;

    let database_result = (|| {
        let transaction = conn.unchecked_transaction()?;
        transaction.execute(
            "UPDATE repositories SET github_account_id = NULL WHERE github_account_id = ?1",
            params![account.id],
        )?;
        transaction.execute(
            "DELETE FROM github_repo_catalog WHERE account_id = ?1",
            params![account.id],
        )?;
        transaction.execute(
            "DELETE FROM github_accounts WHERE id = ?1",
            params![account.id],
        )?;
        let accounts = load_ui_github_accounts(&transaction)?;
        transaction.commit()?;
        Ok(accounts)
    })();
    match database_result {
        Ok(accounts) => Ok(accounts),
        Err(database_error) => {
            let compensation = previous_secret.as_deref().map_or(Ok(()), |secret| {
                credentials.set(service, &account.token_key, secret)
            });
            match compensation {
                Ok(()) => Err(database_error),
                Err(compensation_error) => Err(AppError::with_details(
                    "token_delete_compensation_failed",
                    "账号删除失败，且 Token 恢复失败。",
                    format!(
                        "database_code={}; database={}; compensation={compensation_error}",
                        database_error.code,
                        database_error
                            .details
                            .as_deref()
                            .unwrap_or(&database_error.message)
                    ),
                )),
            }
        }
    }
}

#[cfg(test)]
#[path = "github_accounts_tests.rs"]
mod tests;
