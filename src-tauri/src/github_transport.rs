use crate::{
    adapters::{
        GithubHttpAdapter, GithubHttpResponse, GITHUB_ARCHIVE_REQUEST_TIMEOUT,
        GITHUB_REQUEST_TIMEOUT, GITHUB_TIMEOUT_PREFIX,
    },
    classify_github_rejection, github_account_id_for_login, github_account_token_key, headers,
    scopes_from_headers, truncate_preview, utc_now, AppError, GithubAccountRecord,
    GithubContentRequest, RemoteInfo,
};
use base64::{engine::general_purpose, Engine as _};
use reqwest::{header::HeaderMap, Method};
use std::time::Duration;

pub(super) async fn send_request(
    transport: &dyn GithubHttpAdapter,
    method: Method,
    url: String,
    headers: HeaderMap,
    network_message: &'static str,
) -> Result<GithubHttpResponse, AppError> {
    send_request_with_timeout(
        transport,
        method,
        url,
        headers,
        network_message,
        GITHUB_REQUEST_TIMEOUT,
    )
    .await
}

async fn send_request_with_timeout(
    transport: &dyn GithubHttpAdapter,
    method: Method,
    url: String,
    headers: HeaderMap,
    network_message: &'static str,
    timeout: Duration,
) -> Result<GithubHttpResponse, AppError> {
    let url = reqwest::Url::parse(&url).map_err(|error| {
        AppError::with_details("github_network", network_message, error.to_string())
    })?;
    let mut request = reqwest::Request::new(method, url);
    *request.headers_mut() = headers;
    *request.timeout_mut() = Some(timeout);
    match tokio::time::timeout(timeout, transport.execute(request)).await {
        Err(_) => Err(AppError::with_details(
            "github_timeout",
            network_message,
            format!("timeout_ms={}", timeout.as_millis()),
        )),
        Ok(Err(error)) if error.starts_with(GITHUB_TIMEOUT_PREFIX) => Err(AppError::with_details(
            "github_timeout",
            network_message,
            error,
        )),
        Ok(result) => {
            result.map_err(|error| AppError::with_details("github_network", network_message, error))
        }
    }
}

pub(super) fn rejection_error(response: &GithubHttpResponse, auth: &str) -> AppError {
    let body = response
        .body
        .as_ref()
        .map(|body| String::from_utf8_lossy(body))
        .unwrap_or_default();
    let mut error =
        classify_github_rejection(response.status, &response.headers, body.as_ref(), auth)
            .unwrap_or_else(|| {
                AppError::with_details(
                    "github_error",
                    "GitHub 返回未知错误。",
                    response.status.to_string(),
                )
            });
    if let Err(body_error) = &response.body {
        let details = error.details.take().unwrap_or_default();
        error.details = Some(format!("{details}; body_read_error={body_error}"));
    }
    error
}

pub(super) fn response_body(
    response: GithubHttpResponse,
    code: &'static str,
    message: &'static str,
) -> Result<Vec<u8>, AppError> {
    match response.body {
        Err(error) if error.starts_with(GITHUB_TIMEOUT_PREFIX) => {
            Err(AppError::with_details("github_timeout", message, error))
        }
        result => result.map_err(|error| AppError::with_details(code, message, error)),
    }
}

pub(super) async fn validate_token_identity(
    transport: &dyn GithubHttpAdapter,
    token: &str,
) -> Result<(GithubAccountRecord, String), AppError> {
    let response = send_request(
        transport,
        Method::GET,
        "https://api.github.com/user".to_string(),
        headers(Some(token)),
        "无法验证 GitHub token。",
    )
    .await?;
    if !matches!(response.status, 200..=299) {
        if matches!(response.status, 403 | 429) {
            return Err(rejection_error(&response, "token_validation"));
        }
        let mut error = if response.status == 401 {
            AppError::with_details(
                "token_invalid",
                "GitHub token 验证失败。",
                response.status.to_string(),
            )
        } else {
            AppError::with_details(
                "github_error",
                "GitHub token 验证服务返回异常。",
                response.status.to_string(),
            )
        };
        if let Err(body_error) = &response.body {
            let details = error.details.take().unwrap_or_default();
            error.details = Some(format!("{details}; body_read_error={body_error}"));
        }
        return Err(error);
    }
    let scopes = scopes_from_headers(&response.headers);
    let body = response_body(response, "github_error", "GitHub 用户响应读取失败。")?;
    let json: serde_json::Value = serde_json::from_slice(&body).map_err(|error| {
        AppError::with_details(
            "github_error",
            "GitHub 用户响应解析失败。",
            error.to_string(),
        )
    })?;
    let login = json
        .get("login")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::new("github_error", "GitHub 用户响应缺少 login。"))?
        .to_string();
    let display_name = json
        .get("name")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&login)
        .to_string();
    let id = github_account_id_for_login(&login);
    let token_key = github_account_token_key(&id);
    Ok((
        GithubAccountRecord {
            id,
            login,
            display_name,
            avatar_url: json
                .get("avatar_url")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            token_key,
            status: "verified".to_string(),
            scopes,
            last_verified: Some(utc_now()),
            is_default: false,
        },
        json.to_string(),
    ))
}

pub(super) async fn download_zip(
    transport: &dyn GithubHttpAdapter,
    owner: &str,
    repo: &str,
    sha: &str,
    token: Option<&str>,
    auth: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/zipball/{sha}");
    let response = send_request_with_timeout(
        transport,
        Method::GET,
        url,
        headers(token),
        "源码 ZIP 下载失败。",
        GITHUB_ARCHIVE_REQUEST_TIMEOUT,
    )
    .await?;
    if !matches!(response.status, 200..=299) {
        if matches!(response.status, 401 | 403 | 429) {
            return Err(rejection_error(&response, auth));
        }
        return Err(AppError::with_details(
            "github_error",
            "源码 ZIP 下载失败。",
            response.status.to_string(),
        ));
    }
    let bytes = response_body(response, "github_network", "源码 ZIP 读取失败。")?;
    if bytes.is_empty() {
        return Err(AppError::new("zip_empty", "ZIP 文件大小为 0。"));
    }
    Ok(bytes)
}

pub(super) async fn fetch_remote_info(
    transport: &dyn GithubHttpAdapter,
    owner: &str,
    repo: &str,
    ref_name: &str,
    token: Option<&str>,
    auth: &str,
) -> Result<RemoteInfo, AppError> {
    let repo_response = send_request(
        transport,
        Method::GET,
        format!("https://api.github.com/repos/{owner}/{repo}"),
        headers(token),
        "无法访问 GitHub。",
    )
    .await?;
    match repo_response.status {
        200 => {}
        401 | 403 | 429 => return Err(rejection_error(&repo_response, auth)),
        404 => {
            return Err(AppError::new(
                "github_not_found",
                "仓库不存在或无访问权限。",
            ))
        }
        status => {
            return Err(AppError::with_details(
                "github_error",
                "GitHub 返回未知错误。",
                status.to_string(),
            ))
        }
    }
    let repo_body = response_body(repo_response, "github_error", "GitHub 仓库响应读取失败。")?;
    let repo_json: serde_json::Value = serde_json::from_slice(&repo_body).map_err(|error| {
        AppError::with_details(
            "github_error",
            "GitHub 仓库响应解析失败。",
            error.to_string(),
        )
    })?;
    let full_name = repo_json
        .get("full_name")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{owner}/{repo}"));
    let default_branch = repo_json
        .get("default_branch")
        .and_then(|value| value.as_str())
        .unwrap_or("main")
        .to_string();
    let resolved_ref = if ref_name.trim().is_empty() {
        default_branch.clone()
    } else {
        ref_name.to_string()
    };

    let commit_response = send_request(
        transport,
        Method::GET,
        format!(
            "https://api.github.com/repos/{owner}/{repo}/commits/{}",
            urlencoding::encode(&resolved_ref)
        ),
        headers(token),
        "无法读取远端提交。",
    )
    .await?;
    match commit_response.status {
        200 => {}
        401 | 403 | 429 => return Err(rejection_error(&commit_response, auth)),
        404 => return Err(AppError::new("ref_not_found", "指定 ref 不存在。")),
        status => {
            return Err(AppError::with_details(
                "github_error",
                "GitHub 提交响应异常。",
                status.to_string(),
            ))
        }
    }
    let commit_body = response_body(commit_response, "github_error", "GitHub 提交响应读取失败。")?;
    let commit_json: serde_json::Value = serde_json::from_slice(&commit_body).map_err(|error| {
        AppError::with_details(
            "github_error",
            "GitHub 提交响应解析失败。",
            error.to_string(),
        )
    })?;
    let sha = commit_json
        .get("sha")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::new("github_error", "GitHub 响应缺少 sha。"))?
        .to_string();
    let (canonical_owner, canonical_repo) = full_name
        .split_once('/')
        .map(|(left, right)| (left.to_string(), right.to_string()))
        .unwrap_or_else(|| (owner.to_string(), repo.to_string()));
    Ok(RemoteInfo {
        owner: canonical_owner,
        repo: canonical_repo,
        full_name,
        default_branch,
        resolved_ref,
        sha,
    })
}

pub(super) async fn fetch_github_content(
    transport: &dyn GithubHttpAdapter,
    request: GithubContentRequest<'_>,
    token: Option<&str>,
) -> Result<(String, String), AppError> {
    let url = if request.readme {
        format!(
            "https://api.github.com/repos/{}/{}/readme?ref={}",
            request.owner,
            request.repo,
            urlencoding::encode(request.ref_name)
        )
    } else {
        let encoded_path = request
            .path
            .unwrap_or("README.md")
            .split('/')
            .map(urlencoding::encode)
            .collect::<Vec<_>>()
            .join("/");
        format!(
            "https://api.github.com/repos/{}/{}/contents/{encoded_path}?ref={}",
            request.owner,
            request.repo,
            urlencoding::encode(request.ref_name)
        )
    };
    let response = send_request(
        transport,
        Method::GET,
        url,
        headers(token),
        "无法读取 GitHub 文件。",
    )
    .await?;
    match response.status {
        200 => {}
        401 | 403 | 429 => return Err(rejection_error(&response, request.auth)),
        404 => {
            return Err(AppError::new(
                "github_file_not_found",
                "GitHub 仓库中未找到该文件。",
            ))
        }
        status => {
            return Err(AppError::with_details(
                "github_error",
                "GitHub 文件响应异常。",
                status.to_string(),
            ))
        }
    }
    let body = response_body(response, "github_error", "GitHub 文件响应读取失败。")?;
    let json: serde_json::Value = serde_json::from_slice(&body).map_err(|error| {
        AppError::with_details(
            "github_error",
            "GitHub 文件响应解析失败。",
            error.to_string(),
        )
    })?;
    let source_path = json
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or(request.path.unwrap_or("README.md"))
        .to_string();
    let content = json
        .get("content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::new("github_error", "GitHub 文件响应缺少 content。"))?;
    let normalized = content.lines().collect::<String>();
    let bytes = general_purpose::STANDARD
        .decode(normalized.as_bytes())
        .map_err(|error| {
            AppError::with_details(
                "github_error",
                "GitHub 文件 base64 解码失败。",
                error.to_string(),
            )
        })?;
    let text = String::from_utf8(bytes).map_err(|error| {
        AppError::with_details(
            "github_error",
            "GitHub 文件不是 UTF-8 文本。",
            error.to_string(),
        )
    })?;
    Ok((truncate_preview(text), source_path))
}

pub(super) async fn set_star_remote(
    transport: &dyn GithubHttpAdapter,
    owner: &str,
    repo: &str,
    starred: bool,
    token: &str,
    auth: &str,
) -> Result<(), AppError> {
    let method = if starred { Method::PUT } else { Method::DELETE };
    let response = send_request(
        transport,
        method,
        format!(
            "https://api.github.com/user/starred/{}/{}",
            urlencoding::encode(owner),
            urlencoding::encode(repo)
        ),
        headers(Some(token)),
        "GitHub Star 操作无法完成。",
    )
    .await?;
    match response.status {
        204 => Ok(()),
        401 | 403 | 429 => Err(rejection_error(&response, auth)),
        status => Err(AppError::with_details(
            "github_star_failed",
            "GitHub Star 操作失败，请检查 token 的 Starring 权限。",
            status.to_string(),
        )),
    }
}

#[cfg(test)]
#[path = "github_transport_tests.rs"]
mod tests;
