use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use reqwest::header::HeaderMap;

pub(super) trait CredentialStore: Send + Sync {
    fn get(&self, service: &str, key: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, key: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, service: &str, key: &str) -> Result<(), String>;
}

pub(super) struct SystemKeychain;

fn map_keyring_get(result: keyring::Result<String>) -> Result<Option<String>, String> {
    match result {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn map_keyring_delete(result: keyring::Result<()>) -> Result<(), String> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn keychain_account_allowed(key: &str) -> bool {
    key == crate::TOKEN_USER
        || key
            .strip_prefix("github-account-token:github:")
            .is_some_and(|account| {
                !account.is_empty()
                    && account.bytes().all(|byte| {
                        byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || matches!(byte, b'-' | b'_')
                    })
            })
}

fn system_keychain_entry(service: &str, key: &str) -> Result<keyring::Entry, String> {
    if service != crate::TOKEN_SERVICE {
        return Err("unreviewed keychain service".to_string());
    }
    if !keychain_account_allowed(key) {
        return Err("unreviewed keychain account namespace".to_string());
    }
    keyring::Entry::new(crate::TOKEN_SERVICE, key).map_err(|error| error.to_string())
}

impl CredentialStore for SystemKeychain {
    fn get(&self, service: &str, key: &str) -> Result<Option<String>, String> {
        let entry = system_keychain_entry(service, key)?;
        map_keyring_get(entry.get_password())
    }

    fn set(&self, service: &str, key: &str, secret: &str) -> Result<(), String> {
        system_keychain_entry(service, key)?
            .set_password(secret)
            .map_err(|error| error.to_string())
    }

    fn delete(&self, service: &str, key: &str) -> Result<(), String> {
        let entry = system_keychain_entry(service, key)?;
        map_keyring_delete(entry.delete_credential())
    }
}

pub(super) trait GithubHttpAdapter: Send + Sync {
    fn execute(&self, request: reqwest::Request) -> GithubHttpFuture<'_>;
}

pub(super) struct GithubHttpResponse {
    pub(super) status: u16,
    pub(super) headers: HeaderMap,
    pub(super) body: Result<Vec<u8>, String>,
}

pub(super) type GithubHttpFuture<'a> =
    Pin<Box<dyn Future<Output = Result<GithubHttpResponse, String>> + Send + 'a>>;

pub(super) struct ReqwestGithubHttpAdapter(reqwest::Client);

const MAX_GITHUB_REDIRECTS: usize = 5;
pub(super) const GITHUB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const GITHUB_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const GITHUB_ARCHIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
pub(super) const GITHUB_TIMEOUT_PREFIX: &str = "github_request_timeout: ";

fn github_request_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("api.github.com" | "github.com" | "codeload.github.com")
        )
}

fn github_redirect_allowed(url: &reqwest::Url, previous_redirects: usize) -> bool {
    previous_redirects < MAX_GITHUB_REDIRECTS && github_request_allowed(url)
}

impl Default for ReqwestGithubHttpAdapter {
    fn default() -> Self {
        let redirect = reqwest::redirect::Policy::custom(|attempt| {
            let previous_redirects = attempt.previous().len().saturating_sub(1);
            if github_redirect_allowed(attempt.url(), previous_redirects) {
                attempt.follow()
            } else {
                attempt.error("GitHub redirect target is not allowed")
            }
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(redirect)
            .connect_timeout(GITHUB_CONNECT_TIMEOUT)
            .timeout(GITHUB_REQUEST_TIMEOUT)
            .https_only(true)
            .build()
            .expect("GitHub HTTP client configuration must be valid");
        Self(client)
    }
}

impl GithubHttpAdapter for ReqwestGithubHttpAdapter {
    fn execute(&self, request: reqwest::Request) -> GithubHttpFuture<'_> {
        if !github_request_allowed(request.url()) {
            let host = request.url().host_str().unwrap_or("<unknown>").to_string();
            return Box::pin(async move {
                Err(format!("GitHub request target is not allowed: {host}"))
            });
        }
        Box::pin(async move {
            let response = self.0.execute(request).await.map_err(|error| {
                if error.is_timeout() {
                    format!("{GITHUB_TIMEOUT_PREFIX}{error}")
                } else {
                    error.to_string()
                }
            })?;
            Ok(collect_github_response(response).await)
        })
    }
}

async fn collect_github_response(response: reqwest::Response) -> GithubHttpResponse {
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| github_body_error(error.is_timeout(), &error.to_string()));
    github_http_response(status, headers, body)
}

fn github_body_error(is_timeout: bool, message: &str) -> String {
    if is_timeout {
        format!("{GITHUB_TIMEOUT_PREFIX}{message}")
    } else {
        message.to_string()
    }
}

fn github_http_response(
    status: u16,
    headers: HeaderMap,
    body: Result<Vec<u8>, String>,
) -> GithubHttpResponse {
    GithubHttpResponse {
        status,
        headers,
        body,
    }
}

pub(super) trait FilesystemAdapter: Send + Sync {
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf>;
    fn is_dir(&self, path: &Path) -> bool;
}

pub(super) struct SystemFilesystem;

impl FilesystemAdapter for SystemFilesystem {
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        path.canonicalize()
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
}

pub(super) struct AppAdapters {
    pub(super) credentials: Arc<dyn CredentialStore>,
    pub(super) github: Arc<dyn GithubHttpAdapter>,
    pub(super) filesystem: Arc<dyn FilesystemAdapter>,
}

impl Default for AppAdapters {
    fn default() -> Self {
        Self {
            credentials: Arc::new(SystemKeychain),
            github: Arc::new(ReqwestGithubHttpAdapter::default()),
            filesystem: Arc::new(SystemFilesystem),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_keychain_accepts_only_reviewed_account_namespaces() {
        assert!(keychain_account_allowed(crate::TOKEN_USER));
        assert!(keychain_account_allowed(
            "github-account-token:github:alice_1"
        ));
        assert!(!keychain_account_allowed("github-account-token:github:"));
        assert!(!keychain_account_allowed(
            "github-account-token:github:Alice"
        ));
        assert!(!keychain_account_allowed("unreviewed-token"));
    }

    #[test]
    fn system_keychain_rejects_unreviewed_namespaces_before_platform_access() {
        let keychain = SystemKeychain;
        assert_eq!(
            keychain
                .get("Unreviewed Service", crate::TOKEN_USER)
                .unwrap_err(),
            "unreviewed keychain service"
        );
        assert_eq!(
            keychain
                .set(crate::TOKEN_SERVICE, "unreviewed-token", "fictional-secret")
                .unwrap_err(),
            "unreviewed keychain account namespace"
        );
        assert_eq!(
            keychain
                .delete("Unreviewed Service", crate::TOKEN_USER)
                .unwrap_err(),
            "unreviewed keychain service"
        );
    }

    #[test]
    fn system_keychain_get_treats_only_no_entry_as_missing() {
        assert_eq!(
            map_keyring_get(Ok("fictional-secret".into())).unwrap(),
            Some("fictional-secret".into())
        );
        assert_eq!(map_keyring_get(Err(keyring::Error::NoEntry)).unwrap(), None);

        let error = map_keyring_get(Err(keyring::Error::Invalid(
            "account".into(),
            "fictional invalid value".into(),
        )))
        .unwrap_err();
        assert!(error.contains("fictional invalid value"));
    }

    #[test]
    fn system_keychain_delete_treats_no_entry_as_success() {
        assert!(map_keyring_delete(Err(keyring::Error::NoEntry)).is_ok());

        let error = map_keyring_delete(Err(keyring::Error::Invalid(
            "account".into(),
            "fictional invalid value".into(),
        )))
        .unwrap_err();
        assert!(error.contains("fictional invalid value"));
    }

    #[test]
    fn github_redirect_policy_allows_only_enumerated_https_hosts() {
        for url in [
            "https://api.github.com/repos/example/repository/zipball/main",
            "https://github.com/example/repository/archive/main.zip",
            "https://codeload.github.com/example/repository/zip/main",
        ] {
            assert!(github_redirect_allowed(&url.parse().unwrap(), 0), "{url}");
        }

        for url in [
            "https://example.invalid/archive.zip",
            "https://api.github.com.example.invalid/archive.zip",
            "http://codeload.github.com/example/repository/zip/main",
        ] {
            assert!(!github_redirect_allowed(&url.parse().unwrap(), 0), "{url}");
        }
    }

    #[test]
    fn github_redirect_policy_stops_at_the_redirect_limit() {
        let url = "https://codeload.github.com/example/repository/zip/main"
            .parse()
            .unwrap();

        assert!(github_redirect_allowed(&url, MAX_GITHUB_REDIRECTS - 1));
        assert!(!github_redirect_allowed(&url, MAX_GITHUB_REDIRECTS));
    }

    #[test]
    fn github_adapter_rejects_non_allowlisted_initial_url_before_send() {
        let url = "https://credentials.example.invalid/collect"
            .parse()
            .unwrap();
        assert!(!github_request_allowed(&url));

        let adapter = ReqwestGithubHttpAdapter::default();
        let request = reqwest::Request::new(reqwest::Method::GET, url);
        let result = tauri::async_runtime::block_on(adapter.execute(request));
        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap()
            .contains("GitHub request target is not allowed"));
    }

    #[test]
    fn github_client_timeout_budget_is_explicit_and_bounded() {
        assert_eq!(GITHUB_CONNECT_TIMEOUT, std::time::Duration::from_secs(10));
        assert_eq!(GITHUB_REQUEST_TIMEOUT, std::time::Duration::from_secs(30));
        assert_eq!(
            GITHUB_ARCHIVE_REQUEST_TIMEOUT,
            std::time::Duration::from_secs(120)
        );
        assert!(GITHUB_CONNECT_TIMEOUT < GITHUB_REQUEST_TIMEOUT);
        assert!(GITHUB_REQUEST_TIMEOUT < GITHUB_ARCHIVE_REQUEST_TIMEOUT);
    }

    #[test]
    fn system_filesystem_canonicalizes_paths_and_distinguishes_files() {
        let sandbox = tempfile::tempdir().unwrap();
        let nested = sandbox.path().join("nested");
        let file = sandbox.path().join("ordinary-file");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(&file, b"fictional").unwrap();
        let filesystem = SystemFilesystem;

        assert_eq!(
            filesystem.canonicalize(&nested).unwrap(),
            nested.canonicalize().unwrap()
        );
        assert!(filesystem.is_dir(&nested));
        assert!(!filesystem.is_dir(&file));
    }

    #[test]
    fn response_mapping_preserves_status_headers_and_binary_body() {
        let mut headers = HeaderMap::new();
        headers.insert("x-fictional", "yes".parse().unwrap());
        let collected = github_http_response(206, headers, Ok(vec![0x00, 0x01, 0xfe, 0xff]));

        assert_eq!(collected.status, 206);
        assert_eq!(collected.headers.get("x-fictional").unwrap(), "yes");
        assert_eq!(collected.body.unwrap(), vec![0x00, 0x01, 0xfe, 0xff]);
    }

    #[test]
    fn body_error_mapping_distinguishes_timeout_from_other_failures() {
        assert_eq!(
            github_body_error(false, "fictional truncated body"),
            "fictional truncated body"
        );
        assert_eq!(
            github_body_error(true, "fictional timed out body"),
            format!("{GITHUB_TIMEOUT_PREFIX}fictional timed out body")
        );
    }
}
