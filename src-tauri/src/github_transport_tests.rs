use std::{collections::VecDeque, sync::Mutex, time::Duration};

use crate::adapters::{GithubHttpAdapter, GithubHttpFuture, GithubHttpResponse};
use reqwest::header::{HeaderMap, HeaderValue};

struct RecordedRequest {
    method: reqwest::Method,
    url: String,
    headers: HeaderMap,
}

struct FakeGithubHttp {
    responses: Mutex<VecDeque<Result<GithubHttpResponse, String>>>,
    requests: Mutex<Vec<RecordedRequest>>,
}

impl FakeGithubHttp {
    fn scripted(responses: impl IntoIterator<Item = Result<GithubHttpResponse, String>>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn responding(responses: impl IntoIterator<Item = GithubHttpResponse>) -> Self {
        Self::scripted(responses.into_iter().map(Ok))
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| RecordedRequest {
                method: request.method.clone(),
                url: request.url.clone(),
                headers: request.headers.clone(),
            })
            .collect()
    }
}

impl GithubHttpAdapter for FakeGithubHttp {
    fn execute(&self, request: reqwest::Request) -> GithubHttpFuture<'_> {
        self.requests.lock().unwrap().push(RecordedRequest {
            method: request.method().clone(),
            url: request.url().to_string(),
            headers: request.headers().clone(),
        });
        let response = self.responses.lock().unwrap().pop_front().unwrap();
        Box::pin(async move { response })
    }
}

struct PendingGithubHttp;

impl GithubHttpAdapter for PendingGithubHttp {
    fn execute(&self, _request: reqwest::Request) -> GithubHttpFuture<'_> {
        Box::pin(std::future::pending())
    }
}

#[test]
fn pending_transport_returns_a_deterministic_timeout_error() {
    let result = tauri::async_runtime::block_on(super::send_request_with_timeout(
        &PendingGithubHttp,
        reqwest::Method::GET,
        "https://api.github.com/user".to_string(),
        HeaderMap::new(),
        "无法验证 GitHub token。",
        Duration::from_millis(5),
    ));
    let error = match result {
        Ok(_) => panic!("pending transport unexpectedly completed"),
        Err(error) => error,
    };

    assert_eq!(error.code, "github_timeout");
    assert_eq!(error.message, "无法验证 GitHub token。");
    assert!(error
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("timeout_ms=5"));
}

#[test]
fn zip_download_preserves_non_utf8_bytes() {
    let expected = vec![0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80];
    let transport = FakeGithubHttp::responding([GithubHttpResponse {
        status: 200,
        headers: HeaderMap::new(),
        body: Ok(expected.clone()),
    }]);

    let actual = tauri::async_runtime::block_on(super::download_zip(
        &transport,
        "example-org",
        "fictional-repository",
        "fictional-sha",
        Some("fictional-token"),
        "repo_account",
    ))
    .unwrap();

    assert_eq!(actual, expected);
}

#[test]
fn token_validation_preserves_auth_rate_limit_and_service_failure_classes() {
    for (status, headers, expected_code) in [
        (401, HeaderMap::new(), "token_invalid"),
        (403, HeaderMap::new(), "github_forbidden"),
        (
            403,
            HeaderMap::from_iter([(
                "x-ratelimit-remaining".parse().unwrap(),
                HeaderValue::from_static("0"),
            )]),
            "github_rate_limited",
        ),
        (429, HeaderMap::new(), "github_secondary_rate_limited"),
        (503, HeaderMap::new(), "github_error"),
    ] {
        let transport = FakeGithubHttp::responding([GithubHttpResponse {
            status,
            headers,
            body: Err("fictional body read failure".into()),
        }]);

        let error = tauri::async_runtime::block_on(super::validate_token_identity(
            &transport,
            "fictional-token",
        ))
        .unwrap_err();

        assert_eq!(error.code, expected_code, "status={status}");
        let details = error.details.unwrap_or_default();
        assert!(details.contains(&status.to_string()), "status={status}");
        assert!(
            details.contains("body_read_error=fictional body read failure"),
            "status={status}"
        );
    }
}

#[test]
fn remote_info_uses_repository_then_resolved_commit_requests() {
    let transport = FakeGithubHttp::responding([
        GithubHttpResponse {
            status: 200,
            headers: HeaderMap::new(),
            body: Ok(
                br#"{"full_name":"example-org/fictional-repository","default_branch":"trunk"}"#
                    .to_vec(),
            ),
        },
        GithubHttpResponse {
            status: 200,
            headers: HeaderMap::new(),
            body: Ok(br#"{"sha":"fictional-commit-sha"}"#.to_vec()),
        },
    ]);

    let remote = tauri::async_runtime::block_on(super::fetch_remote_info(
        &transport,
        "example-org",
        "fictional-repository",
        "",
        Some("fictional-token"),
        "repo_account",
    ))
    .unwrap();

    assert_eq!(remote.resolved_ref, "trunk");
    assert_eq!(remote.sha, "fictional-commit-sha");
    let requests = transport.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, reqwest::Method::GET);
    assert_eq!(
        requests[0].url,
        "https://api.github.com/repos/example-org/fictional-repository"
    );
    assert_eq!(
        requests[1].url,
        "https://api.github.com/repos/example-org/fictional-repository/commits/trunk"
    );
    assert_eq!(
        requests[0]
            .headers
            .get(reqwest::header::AUTHORIZATION)
            .unwrap(),
        "Bearer fictional-token"
    );
}

#[test]
fn content_request_decodes_text_and_preserves_reported_source_path() {
    let transport = FakeGithubHttp::responding([GithubHttpResponse {
        status: 200,
        headers: HeaderMap::new(),
        body: Ok(
            br#"{"path":"skills/fictional/SKILL.md","content":"IyBGaWN0aW9uYWwgU2tpbGwK"}"#
                .to_vec(),
        ),
    }]);

    let (text, source_path) = tauri::async_runtime::block_on(super::fetch_github_content(
        &transport,
        crate::GithubContentRequest {
            owner: "example-org",
            repo: "fictional-repository",
            ref_name: "feature/fictional",
            path: Some("skills/fictional/SKILL.md"),
            readme: false,
            auth: "repo_account",
        },
        Some("fictional-token"),
    ))
    .unwrap();

    assert_eq!(text, "# Fictional Skill\n");
    assert_eq!(source_path, "skills/fictional/SKILL.md");
    assert_eq!(
        transport.requests()[0].url,
        "https://api.github.com/repos/example-org/fictional-repository/contents/skills/fictional/SKILL.md?ref=feature%2Ffictional"
    );
}

#[test]
fn star_remote_uses_put_or_delete_without_reading_a_204_body() {
    for (starred, expected_method) in [
        (true, reqwest::Method::PUT),
        (false, reqwest::Method::DELETE),
    ] {
        let transport = FakeGithubHttp::responding([GithubHttpResponse {
            status: 204,
            headers: HeaderMap::new(),
            body: Err("fictional body should not be read".into()),
        }]);

        tauri::async_runtime::block_on(super::set_star_remote(
            &transport,
            "example-org",
            "fictional-repository",
            starred,
            "fictional-token",
            "repo_account",
        ))
        .unwrap();

        let requests = transport.requests();
        assert_eq!(requests[0].method, expected_method);
        assert_eq!(
            requests[0].url,
            "https://api.github.com/user/starred/example-org/fictional-repository"
        );
    }
}

#[test]
fn rejection_status_survives_body_read_failure() {
    let mut headers = HeaderMap::new();
    headers.insert("retry-after", HeaderValue::from_static("17"));
    let transport = FakeGithubHttp::responding([GithubHttpResponse {
        status: 429,
        headers,
        body: Err("fictional body read failure".into()),
    }]);

    let error = tauri::async_runtime::block_on(super::download_zip(
        &transport,
        "example-org",
        "fictional-repository",
        "fictional-sha",
        Some("fictional-token"),
        "repo_account",
    ))
    .unwrap_err();

    assert_eq!(error.code, "github_secondary_rate_limited");
    let details = error.details.unwrap();
    assert!(details.contains("retry-after=17"));
    assert!(details.contains("body_read_error=fictional body read failure"));
}

#[test]
fn send_and_success_body_failures_keep_distinct_messages() {
    let send_failure = FakeGithubHttp::scripted([Err("fictional send failure".into())]);
    let error = tauri::async_runtime::block_on(super::download_zip(
        &send_failure,
        "example-org",
        "fictional-repository",
        "fictional-sha",
        None,
        "none",
    ))
    .unwrap_err();
    assert_eq!(error.code, "github_network");
    assert_eq!(error.message, "源码 ZIP 下载失败。");

    let body_failure = FakeGithubHttp::responding([GithubHttpResponse {
        status: 200,
        headers: HeaderMap::new(),
        body: Err("fictional body read failure".into()),
    }]);
    let error = tauri::async_runtime::block_on(super::download_zip(
        &body_failure,
        "example-org",
        "fictional-repository",
        "fictional-sha",
        None,
        "none",
    ))
    .unwrap_err();
    assert_eq!(error.code, "github_network");
    assert_eq!(error.message, "源码 ZIP 读取失败。");
}

#[test]
fn successful_response_body_timeout_keeps_the_timeout_contract() {
    let transport = FakeGithubHttp::responding([GithubHttpResponse {
        status: 200,
        headers: HeaderMap::new(),
        body: Err(format!(
            "{}fictional response body timeout",
            crate::adapters::GITHUB_TIMEOUT_PREFIX
        )),
    }]);

    let error = tauri::async_runtime::block_on(super::download_zip(
        &transport,
        "example-org",
        "fictional-repository",
        "fictional-sha",
        None,
        "none",
    ))
    .unwrap_err();

    assert_eq!(error.code, "github_timeout");
    assert_eq!(error.message, "源码 ZIP 读取失败。");
}

fn response(status: u16, body: impl Into<Vec<u8>>) -> GithubHttpResponse {
    GithubHttpResponse {
        status,
        headers: HeaderMap::new(),
        body: Ok(body.into()),
    }
}

fn request_error(result: Result<GithubHttpResponse, crate::AppError>) -> crate::AppError {
    match result {
        Ok(_) => panic!("request unexpectedly succeeded"),
        Err(error) => error,
    }
}

fn content_request(
    readme: bool,
    path: Option<&'static str>,
) -> crate::GithubContentRequest<'static> {
    crate::GithubContentRequest {
        owner: "example-org",
        repo: "fictional-repository",
        ref_name: "feature/fictional",
        path,
        readme,
        auth: "repo_account",
    }
}

#[test]
fn send_request_distinguishes_invalid_urls_and_adapter_timeouts() {
    let unused = FakeGithubHttp::scripted(std::iter::empty());
    let invalid = request_error(tauri::async_runtime::block_on(
        super::send_request_with_timeout(
            &unused,
            reqwest::Method::GET,
            "not a valid URL".to_string(),
            HeaderMap::new(),
            "fictional network failure",
            Duration::from_secs(1),
        ),
    ));
    assert_eq!(invalid.code, "github_network");
    assert_eq!(invalid.message, "fictional network failure");
    assert!(invalid.details.is_some());
    assert!(unused.requests().is_empty());

    let timeout = FakeGithubHttp::scripted([Err(format!(
        "{}fictional adapter timeout",
        crate::adapters::GITHUB_TIMEOUT_PREFIX
    ))]);
    let timed_out = request_error(tauri::async_runtime::block_on(
        super::send_request_with_timeout(
            &timeout,
            reqwest::Method::GET,
            "https://api.github.com/user".to_string(),
            HeaderMap::new(),
            "fictional network failure",
            Duration::from_secs(1),
        ),
    ));
    assert_eq!(timed_out.code, "github_timeout");
    assert!(timed_out
        .details
        .as_deref()
        .unwrap_or_default()
        .contains("fictional adapter timeout"));
}

#[test]
fn unknown_rejection_falls_back_without_discarding_status() {
    let error = super::rejection_error(
        &response(418, br#"{"message":"fictional teapot"}"#.to_vec()),
        "none",
    );

    assert_eq!(error.code, "github_error");
    assert_eq!(error.message, "GitHub 返回未知错误。");
    assert_eq!(error.details.as_deref(), Some("418"));
}

#[test]
fn token_validation_builds_verified_accounts_and_applies_name_fallback() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-oauth-scopes",
        HeaderValue::from_static("repo, read:user"),
    );
    let transport = FakeGithubHttp::responding([GithubHttpResponse {
        status: 200,
        headers,
        body: Ok(
            br#"{"login":"fictional-octopus","name":"Fictional Octopus","avatar_url":"https://avatars.example.invalid/octopus.png"}"#
                .to_vec(),
        ),
    }]);

    let (account, raw_json) = tauri::async_runtime::block_on(super::validate_token_identity(
        &transport,
        "fictional-token",
    ))
    .unwrap();

    assert_eq!(account.login, "fictional-octopus");
    assert_eq!(account.display_name, "Fictional Octopus");
    assert_eq!(
        account.avatar_url.as_deref(),
        Some("https://avatars.example.invalid/octopus.png")
    );
    assert_eq!(account.status, "verified");
    assert!(account.scopes.contains("repo"));
    assert!(account.last_verified.is_some());
    assert!(!account.is_default);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&raw_json).unwrap()["login"],
        "fictional-octopus"
    );

    let fallback = FakeGithubHttp::responding([response(
        200,
        br#"{"login":"fallback-user","name":"   "}"#.to_vec(),
    )]);
    let (account, _) = tauri::async_runtime::block_on(super::validate_token_identity(
        &fallback,
        "fictional-token",
    ))
    .unwrap();
    assert_eq!(account.display_name, "fallback-user");
    assert_eq!(account.avatar_url, None);
}

#[test]
fn token_validation_rejects_invalid_or_incomplete_success_payloads() {
    let invalid_json = FakeGithubHttp::responding([response(200, b"not-json".to_vec())]);
    let error = tauri::async_runtime::block_on(super::validate_token_identity(
        &invalid_json,
        "fictional-token",
    ))
    .unwrap_err();
    assert_eq!(error.code, "github_error");
    assert_eq!(error.message, "GitHub 用户响应解析失败。");

    let missing_login = FakeGithubHttp::responding([response(200, b"{}".to_vec())]);
    let error = tauri::async_runtime::block_on(super::validate_token_identity(
        &missing_login,
        "fictional-token",
    ))
    .unwrap_err();
    assert_eq!(error.code, "github_error");
    assert_eq!(error.message, "GitHub 用户响应缺少 login。");
}

#[test]
fn zip_download_rejects_non_auth_status_and_empty_success_body() {
    let server_failure = FakeGithubHttp::responding([response(502, b"upstream".to_vec())]);
    let error = tauri::async_runtime::block_on(super::download_zip(
        &server_failure,
        "example-org",
        "fictional-repository",
        "fictional-sha",
        None,
        "none",
    ))
    .unwrap_err();
    assert_eq!(error.code, "github_error");
    assert_eq!(error.details.as_deref(), Some("502"));

    let empty = FakeGithubHttp::responding([response(200, Vec::new())]);
    let error = tauri::async_runtime::block_on(super::download_zip(
        &empty,
        "example-org",
        "fictional-repository",
        "fictional-sha",
        None,
        "none",
    ))
    .unwrap_err();
    assert_eq!(error.code, "zip_empty");
}

#[test]
fn remote_info_classifies_repository_statuses_before_reading_the_body() {
    for (status, expected_code) in [
        (403, "github_forbidden"),
        (404, "github_not_found"),
        (502, "github_error"),
    ] {
        let transport = FakeGithubHttp::responding([response(status, b"ignored".to_vec())]);
        let error = tauri::async_runtime::block_on(super::fetch_remote_info(
            &transport,
            "example-org",
            "fictional-repository",
            "main",
            None,
            "repo_account",
        ))
        .unwrap_err();
        assert_eq!(error.code, expected_code, "status={status}");
        assert_eq!(transport.requests().len(), 1, "status={status}");
    }
}

#[test]
fn remote_info_validates_repository_and_commit_payloads() {
    let invalid_repository = FakeGithubHttp::responding([response(200, b"not-json".to_vec())]);
    let error = tauri::async_runtime::block_on(super::fetch_remote_info(
        &invalid_repository,
        "example-org",
        "fictional-repository",
        "main",
        None,
        "none",
    ))
    .unwrap_err();
    assert_eq!(error.message, "GitHub 仓库响应解析失败。");

    for (commit_body, expected_message) in [
        (b"not-json".as_slice(), "GitHub 提交响应解析失败。"),
        (b"{}".as_slice(), "GitHub 响应缺少 sha。"),
    ] {
        let transport = FakeGithubHttp::responding([
            response(200, br#"{"default_branch":"main"}"#.to_vec()),
            response(200, commit_body.to_vec()),
        ]);
        let error = tauri::async_runtime::block_on(super::fetch_remote_info(
            &transport,
            "example-org",
            "fictional-repository",
            "main",
            None,
            "none",
        ))
        .unwrap_err();
        assert_eq!(error.message, expected_message);
    }
}

#[test]
fn remote_info_classifies_commit_statuses_after_a_valid_repository() {
    for (status, expected_code) in [
        (403, "github_forbidden"),
        (404, "ref_not_found"),
        (502, "github_error"),
    ] {
        let transport = FakeGithubHttp::responding([
            response(200, br#"{"default_branch":"main"}"#.to_vec()),
            response(status, b"ignored".to_vec()),
        ]);
        let error = tauri::async_runtime::block_on(super::fetch_remote_info(
            &transport,
            "example-org",
            "fictional-repository",
            "main",
            None,
            "repo_account",
        ))
        .unwrap_err();
        assert_eq!(error.code, expected_code, "status={status}");
        assert_eq!(transport.requests().len(), 2, "status={status}");
    }
}

#[test]
fn remote_info_uses_safe_fallbacks_for_incomplete_repository_metadata() {
    let transport = FakeGithubHttp::responding([
        response(200, br#"{"full_name":"single-component"}"#.to_vec()),
        response(200, br#"{"sha":"fictional-sha"}"#.to_vec()),
    ]);

    let info = tauri::async_runtime::block_on(super::fetch_remote_info(
        &transport,
        "fallback-owner",
        "fallback-repository",
        "feature/fallback",
        None,
        "none",
    ))
    .unwrap();

    assert_eq!(info.owner, "fallback-owner");
    assert_eq!(info.repo, "fallback-repository");
    assert_eq!(info.full_name, "single-component");
    assert_eq!(info.default_branch, "main");
    assert_eq!(info.resolved_ref, "feature/fallback");
    assert_eq!(info.sha, "fictional-sha");
}

#[test]
fn content_readme_route_uses_reported_fallback_path() {
    let transport = FakeGithubHttp::responding([response(
        200,
        br#"{"content":"IyBGaWN0aW9uYWwgUkVBRE1FCg=="}"#.to_vec(),
    )]);

    let (text, source_path) = tauri::async_runtime::block_on(super::fetch_github_content(
        &transport,
        content_request(true, None),
        None,
    ))
    .unwrap();

    assert_eq!(text, "# Fictional README\n");
    assert_eq!(source_path, "README.md");
    assert_eq!(
        transport.requests()[0].url,
        "https://api.github.com/repos/example-org/fictional-repository/readme?ref=feature%2Ffictional"
    );
}

#[test]
fn content_request_classifies_http_statuses_before_parsing() {
    for (status, expected_code) in [
        (403, "github_forbidden"),
        (404, "github_file_not_found"),
        (502, "github_error"),
    ] {
        let transport = FakeGithubHttp::responding([response(status, b"ignored".to_vec())]);
        let error = tauri::async_runtime::block_on(super::fetch_github_content(
            &transport,
            content_request(false, Some("SKILL.md")),
            None,
        ))
        .unwrap_err();
        assert_eq!(error.code, expected_code, "status={status}");
    }
}

#[test]
fn content_request_rejects_malformed_json_base64_and_utf8() {
    for (body, expected_message) in [
        (b"not-json".as_slice(), "GitHub 文件响应解析失败。"),
        (b"{}".as_slice(), "GitHub 文件响应缺少 content。"),
        (
            br#"{"content":"%%%"}"#.as_slice(),
            "GitHub 文件 base64 解码失败。",
        ),
        (
            br#"{"content":"/w=="}"#.as_slice(),
            "GitHub 文件不是 UTF-8 文本。",
        ),
    ] {
        let transport = FakeGithubHttp::responding([response(200, body.to_vec())]);
        let error = tauri::async_runtime::block_on(super::fetch_github_content(
            &transport,
            content_request(false, Some("SKILL.md")),
            None,
        ))
        .unwrap_err();
        assert_eq!(error.code, "github_error");
        assert_eq!(error.message, expected_message);
    }
}

#[test]
fn star_remote_classifies_rejection_and_permission_failures() {
    for (status, expected_code) in [(403, "github_forbidden"), (500, "github_star_failed")] {
        let transport = FakeGithubHttp::responding([response(status, b"ignored".to_vec())]);
        let error = tauri::async_runtime::block_on(super::set_star_remote(
            &transport,
            "example-org",
            "fictional-repository",
            true,
            "fictional-token",
            "repo_account",
        ))
        .unwrap_err();
        assert_eq!(error.code, expected_code, "status={status}");
    }
}
