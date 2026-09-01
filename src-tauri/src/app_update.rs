use crate::{
    adapters::GithubHttpAdapter,
    github_transport::{rejection_error, response_body, send_request},
    headers, AppError,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};

const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/xrevoman-hu/skill-repo-tracker/releases/latest";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppUpdateCheck {
    current_version: String,
    latest_version: String,
    update_available: bool,
}

#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
}

fn normalized_version(version: &str) -> &str {
    let version = version.trim();
    version
        .strip_prefix('v')
        .or_else(|| version.strip_prefix('V'))
        .unwrap_or(version)
}

fn stable_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = normalized_version(version).split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub(super) async fn check_latest_release(
    transport: &dyn GithubHttpAdapter,
    current_version: &str,
) -> Result<AppUpdateCheck, AppError> {
    let response = send_request(
        transport,
        Method::GET,
        LATEST_RELEASE_URL.to_string(),
        headers(None),
        "无法检查应用更新。",
    )
    .await?;
    if matches!(response.status, 401 | 403 | 429) {
        return Err(rejection_error(&response, "none"));
    }
    if !(200..=299).contains(&response.status) {
        return Err(AppError::with_details(
            "github_release_error",
            "GitHub Release 检查失败。",
            format!("status={}", response.status),
        ));
    }
    let body = response_body(
        response,
        "github_release_error",
        "GitHub Release 响应读取失败。",
    )?;
    let release: LatestRelease = serde_json::from_slice(&body).map_err(|error| {
        AppError::with_details(
            "github_release_invalid",
            "GitHub Release 响应解析失败。",
            error.to_string(),
        )
    })?;
    let current_version = normalized_version(current_version);
    let latest_version = normalized_version(&release.tag_name);
    let current_semver = stable_version(current_version).ok_or_else(|| {
        AppError::new("app_version_invalid", "当前应用版本不是有效的稳定版本号。")
    })?;
    let latest_semver = stable_version(latest_version).ok_or_else(|| {
        AppError::new(
            "github_release_invalid",
            "GitHub Release 未提供有效的稳定版本号。",
        )
    })?;

    Ok(AppUpdateCheck {
        current_version: current_version.to_string(),
        latest_version: latest_version.to_string(),
        update_available: latest_semver > current_semver,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::adapters::{GithubHttpFuture, GithubHttpResponse};
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};

    struct FakeGithubHttp {
        response: Mutex<Option<GithubHttpResponse>>,
        request: Mutex<Option<reqwest::Request>>,
    }

    impl FakeGithubHttp {
        fn returning(status: u16, headers: HeaderMap, body: Result<Vec<u8>, String>) -> Self {
            Self {
                response: Mutex::new(Some(GithubHttpResponse {
                    status,
                    headers,
                    body,
                })),
                request: Mutex::new(None),
            }
        }
    }

    impl GithubHttpAdapter for FakeGithubHttp {
        fn execute(&self, request: reqwest::Request) -> GithubHttpFuture<'_> {
            *self.request.lock().unwrap() = Some(request);
            let response = self.response.lock().unwrap().take().unwrap();
            Box::pin(async move { Ok(response) })
        }
    }

    #[test]
    fn update_check_uses_the_injected_adapter_and_normalizes_versions() {
        let transport = FakeGithubHttp::returning(
            200,
            HeaderMap::new(),
            Ok(br#"{"tag_name":"v1.2.3"}"#.to_vec()),
        );

        let result =
            tauri::async_runtime::block_on(check_latest_release(&transport, "v1.2.2")).unwrap();

        assert_eq!(
            result,
            AppUpdateCheck {
                current_version: "1.2.2".into(),
                latest_version: "1.2.3".into(),
                update_available: true,
            }
        );
        let request = transport.request.lock().unwrap();
        let request = request.as_ref().unwrap();
        assert_eq!(request.method(), Method::GET);
        assert_eq!(request.url().as_str(), LATEST_RELEASE_URL);
        assert!(request.headers().get(AUTHORIZATION).is_none());
        assert_eq!(
            request.headers().get(USER_AGENT).unwrap(),
            crate::APP_USER_AGENT
        );
    }

    #[test]
    fn update_check_fails_closed_on_invalid_or_empty_release_payloads() {
        for body in [
            br#"not-json"#.as_slice(),
            br#"{"tag_name":"v"}"#.as_slice(),
            br#"{"tag_name":"v1.2"}"#.as_slice(),
            br#"{"tag_name":"v1.2.3.4"}"#.as_slice(),
            br#"{"tag_name":"v1.2.3-beta.1"}"#.as_slice(),
        ] {
            let transport = FakeGithubHttp::returning(200, HeaderMap::new(), Ok(body.to_vec()));
            let error = tauri::async_runtime::block_on(check_latest_release(&transport, "1.2.3"))
                .unwrap_err();
            assert_eq!(error.code, "github_release_invalid");
        }
    }

    #[test]
    fn update_check_only_offers_strictly_newer_stable_versions() {
        for (latest, expected) in [("v1.2.2", false), ("1.2.3", false), ("v1.3.0", true)] {
            let transport = FakeGithubHttp::returning(
                200,
                HeaderMap::new(),
                Ok(format!(r#"{{"tag_name":"{latest}"}}"#).into_bytes()),
            );

            let result =
                tauri::async_runtime::block_on(check_latest_release(&transport, "v1.2.3")).unwrap();

            assert_eq!(result.update_available, expected, "latest={latest}");
        }
    }

    #[test]
    fn update_check_rejects_an_invalid_current_version() {
        let transport = FakeGithubHttp::returning(
            200,
            HeaderMap::new(),
            Ok(br#"{"tag_name":"v1.2.3"}"#.to_vec()),
        );

        let error = tauri::async_runtime::block_on(check_latest_release(&transport, "development"))
            .unwrap_err();

        assert_eq!(error.code, "app_version_invalid");
    }

    #[test]
    fn update_check_preserves_rate_limit_classification() {
        let headers = HeaderMap::from_iter([(
            "retry-after".parse().unwrap(),
            HeaderValue::from_static("17"),
        )]);
        let transport =
            FakeGithubHttp::returning(429, headers, Ok(br#"{"message":"slow down"}"#.to_vec()));

        let error =
            tauri::async_runtime::block_on(check_latest_release(&transport, "1.2.3")).unwrap_err();

        assert_eq!(error.code, "github_secondary_rate_limited");
        assert!(error.details.unwrap_or_default().contains("retry-after=17"));
    }

    #[test]
    fn update_check_rejects_other_http_failures_before_parsing() {
        let transport = FakeGithubHttp::returning(
            503,
            HeaderMap::new(),
            Ok(br#"{"tag_name":"v9.9.9"}"#.to_vec()),
        );

        let error =
            tauri::async_runtime::block_on(check_latest_release(&transport, "1.2.3")).unwrap_err();

        assert_eq!(error.code, "github_release_error");
        assert_eq!(error.details.as_deref(), Some("status=503"));
    }
}
