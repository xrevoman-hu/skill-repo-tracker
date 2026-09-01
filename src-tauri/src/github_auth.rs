use crate::{
    github_account_by_id, preferred_github_account, AppError, AppState, GithubAccountRecord,
    RepoRecord, TOKEN_SERVICE,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GithubAuthSource {
    RepoAccount,
    DefaultAccount,
    None,
    KeychainMissing,
    KeychainUnavailable,
}

impl GithubAuthSource {
    fn label(self) -> &'static str {
        match self {
            Self::RepoAccount => "repo_account",
            Self::DefaultAccount => "default_account",
            Self::None => "none",
            Self::KeychainMissing => "keychain_missing",
            Self::KeychainUnavailable => "keychain_unavailable",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct GithubAuth {
    token: Option<String>,
    pub(super) account_id: Option<String>,
    source: GithubAuthSource,
}

impl GithubAuth {
    fn anonymous() -> Self {
        Self {
            token: None,
            account_id: None,
            source: GithubAuthSource::None,
        }
    }

    pub(super) fn keychain_missing(account_id: String) -> Self {
        Self {
            token: None,
            account_id: Some(account_id),
            source: GithubAuthSource::KeychainMissing,
        }
    }

    fn keychain_unavailable(account_id: String) -> Self {
        Self {
            token: None,
            account_id: Some(account_id),
            source: GithubAuthSource::KeychainUnavailable,
        }
    }

    pub(super) fn label(&self) -> &'static str {
        self.source.label()
    }

    pub(super) fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub(super) fn usable(&self) -> Result<(), AppError> {
        match self.source {
            GithubAuthSource::KeychainMissing => Err(AppError::with_details(
                "github_token_keychain_missing",
                "GitHub token 已配置，但无法从系统安全存储读取。请重新验证 GitHub 账号。",
                "auth=keychain_missing",
            )),
            GithubAuthSource::KeychainUnavailable => Err(AppError::with_details(
                "github_token_keychain_unavailable",
                "系统安全存储暂时不可用，无法读取 GitHub token。请稍后重试。",
                "auth=keychain_unavailable",
            )),
            _ => Ok(()),
        }
    }
}

impl AppState {
    pub(super) fn token_for_key(&self, token_key: &str) -> Result<Option<String>, AppError> {
        self.adapters
            .credentials
            .get(TOKEN_SERVICE, token_key)
            .map(|token| token.filter(|token| !token.trim().is_empty()))
            .map_err(|_| {
                AppError::with_details(
                    "token_store_read_failed",
                    "系统安全存储暂时不可用，Token 读取失败。",
                    "credential_store=get",
                )
            })
    }

    pub(super) fn auth_for_account_record(
        &self,
        account: GithubAccountRecord,
        source: GithubAuthSource,
    ) -> GithubAuth {
        match self.token_for_key(&account.token_key) {
            Ok(Some(token)) => GithubAuth {
                token: Some(token),
                account_id: Some(account.id),
                source,
            },
            Ok(None) => GithubAuth::keychain_missing(account.id),
            Err(_) => GithubAuth::keychain_unavailable(account.id),
        }
    }

    pub(super) fn default_github_auth(&self) -> GithubAuth {
        let account = {
            let db = match self.db.lock() {
                Ok(db) => db,
                Err(_) => return GithubAuth::anonymous(),
            };
            preferred_github_account(&db).ok().flatten()
        };
        account
            .map(|account| self.auth_for_account_record(account, GithubAuthSource::DefaultAccount))
            .unwrap_or_else(GithubAuth::anonymous)
    }

    pub(super) fn github_auth_for_account(
        &self,
        account_id: &str,
        source: GithubAuthSource,
    ) -> GithubAuth {
        let account = {
            let db = match self.db.lock() {
                Ok(db) => db,
                Err(_) => return GithubAuth::anonymous(),
            };
            github_account_by_id(&db, account_id).ok().flatten()
        };
        account
            .map(|account| self.auth_for_account_record(account, source))
            .unwrap_or_else(|| self.default_github_auth())
    }

    pub(super) fn github_auth_for_repo(&self, repo: &RepoRecord) -> GithubAuth {
        if let Some(account_id) = repo.github_account_id.as_deref() {
            let account = {
                let db = match self.db.lock() {
                    Ok(db) => db,
                    Err(_) => return GithubAuth::anonymous(),
                };
                github_account_by_id(&db, account_id).ok().flatten()
            };
            if let Some(account) = account {
                return self.auth_for_account_record(account, GithubAuthSource::RepoAccount);
            }
        }
        self.default_github_auth()
    }
}
