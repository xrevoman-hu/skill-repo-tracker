use crate::{
    adapters::GithubHttpAdapter,
    classify_github_rejection,
    github_transport::{rejection_error, response_body, send_request},
    headers_with_accept, parse_link_header_next, AppError,
};
use reqwest::header::{HeaderMap, LINK};

pub(super) async fn fetch_json_array_paginated(
    transport: &dyn GithubHttpAdapter,
    first_url: String,
    token: &str,
    auth: &str,
) -> Result<Vec<serde_json::Value>, AppError> {
    fetch_json_array_paginated_with_accept(
        transport,
        first_url,
        token,
        "application/vnd.github+json",
        auth,
    )
    .await
}

pub(super) async fn fetch_json_array_paginated_with_accept(
    transport: &dyn GithubHttpAdapter,
    first_url: String,
    token: &str,
    accept: &'static str,
    auth: &str,
) -> Result<Vec<serde_json::Value>, AppError> {
    let mut next_url = Some(first_url);
    let mut values = Vec::new();
    while let Some(url) = next_url {
        let response = send_request(
            transport,
            reqwest::Method::GET,
            url,
            headers_with_accept(Some(token), accept),
            "无法访问 GitHub。",
        )
        .await?;
        if matches!(response.status, 401 | 403 | 429) {
            return Err(rejection_error(&response, auth));
        }
        let status = response.status;
        let headers = response.headers.clone();
        let body = response_body(response, "github_error", "GitHub 响应读取失败。")?;
        let page = parse_json_array_page(status, &headers, &body, auth)?;
        next_url = page.next_url;
        values.extend(page.items);
    }
    Ok(values)
}

#[derive(Debug)]
pub(super) struct GithubJsonArrayPage {
    pub(super) items: Vec<serde_json::Value>,
    pub(super) next_url: Option<String>,
}

pub(super) fn parse_json_array_page(
    status: u16,
    headers: &HeaderMap,
    body: &[u8],
    auth: &str,
) -> Result<GithubJsonArrayPage, AppError> {
    let body_text = String::from_utf8_lossy(body);
    if let Some(error) = classify_github_rejection(status, headers, &body_text, auth) {
        return Err(error);
    }
    if status != 200 {
        return Err(AppError::with_details(
            "github_error",
            "GitHub 分页响应异常。",
            status.to_string(),
        ));
    }
    let value = serde_json::from_slice::<serde_json::Value>(body).map_err(|error| {
        AppError::with_details("github_error", "GitHub 响应解析失败。", error.to_string())
    })?;
    let Some(items) = value.as_array() else {
        return Err(AppError::new("github_error", "GitHub 响应不是数组。"));
    };
    let next_url = headers
        .get(LINK)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_link_header_next);
    Ok(GithubJsonArrayPage {
        items: items.clone(),
        next_url,
    })
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use super::*;
    use crate::adapters::{GithubHttpAdapter, GithubHttpFuture, GithubHttpResponse};
    use reqwest::header::{HeaderMap, HeaderValue};

    struct FakeGithubHttp {
        responses: Mutex<VecDeque<GithubHttpResponse>>,
        requests: Mutex<Vec<(String, HeaderMap)>>,
    }

    impl FakeGithubHttp {
        fn returning(response: GithubHttpResponse) -> Self {
            Self {
                responses: Mutex::new([response].into()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn responding(responses: impl IntoIterator<Item = GithubHttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl GithubHttpAdapter for FakeGithubHttp {
        fn execute(&self, request: reqwest::Request) -> GithubHttpFuture<'_> {
            self.requests
                .lock()
                .unwrap()
                .push((request.url().to_string(), request.headers().clone()));
            let response = self.responses.lock().unwrap().pop_front().unwrap();
            Box::pin(async move { Ok(response) })
        }
    }

    #[test]
    fn pagination_classifies_fake_transport_429_without_network() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("30"));
        let transport = FakeGithubHttp::returning(GithubHttpResponse {
            status: 429,
            headers,
            body: Ok(br#"{"message":"slow down"}"#.to_vec()),
        });

        let error = tauri::async_runtime::block_on(fetch_json_array_paginated(
            &transport,
            "https://api.github.test/repositories".to_string(),
            "fictional-token",
            "repo_account",
        ))
        .unwrap_err();

        assert_eq!(error.code, "github_secondary_rate_limited");
        assert!(error.details.unwrap().contains("retry-after=30"));
    }

    #[test]
    fn pagination_rejects_fake_transport_invalid_json_without_network() {
        let transport = FakeGithubHttp::returning(GithubHttpResponse {
            status: 200,
            headers: HeaderMap::new(),
            body: Ok(b"{ definitely-not-json".to_vec()),
        });

        let error = tauri::async_runtime::block_on(fetch_json_array_paginated(
            &transport,
            "https://api.github.test/repositories".to_string(),
            "fictional-token",
            "repo_account",
        ))
        .unwrap_err();

        assert_eq!(error.code, "github_error");
        assert_eq!(error.message, "GitHub 响应解析失败。");
    }

    #[test]
    fn pagination_follows_link_and_preserves_auth_and_accept_headers() {
        let mut first_headers = HeaderMap::new();
        first_headers.insert(
            LINK,
            HeaderValue::from_static("<https://api.github.test/repositories?page=2>; rel=\"next\""),
        );
        let transport = FakeGithubHttp::responding([
            GithubHttpResponse {
                status: 200,
                headers: first_headers,
                body: Ok(br#"[{"id":1}]"#.to_vec()),
            },
            GithubHttpResponse {
                status: 200,
                headers: HeaderMap::new(),
                body: Ok(br#"[{"id":2}]"#.to_vec()),
            },
        ]);

        let items = tauri::async_runtime::block_on(fetch_json_array_paginated_with_accept(
            &transport,
            "https://api.github.test/repositories?page=1".to_string(),
            "fictional-token",
            "application/vnd.github.star+json",
            "repo_account",
        ))
        .unwrap();

        assert_eq!(items.len(), 2);
        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests[1].0, "https://api.github.test/repositories?page=2");
        for (_, headers) in requests.iter() {
            assert_eq!(
                headers.get(reqwest::header::AUTHORIZATION).unwrap(),
                "Bearer fictional-token"
            );
            assert_eq!(
                headers.get(reqwest::header::ACCEPT).unwrap(),
                "application/vnd.github.star+json"
            );
            assert_eq!(headers.get("x-github-api-version").unwrap(), "2022-11-28");
        }
    }

    #[test]
    fn page_parser_preserves_rejection_and_non_success_status_contracts() {
        let forbidden = parse_json_array_page(
            403,
            &HeaderMap::new(),
            br#"{"message":"forbidden"}"#,
            "repo_account",
        )
        .unwrap_err();
        assert_eq!(forbidden.code, "github_forbidden");

        let unexpected = parse_json_array_page(
            502,
            &HeaderMap::new(),
            br#"{"message":"upstream unavailable"}"#,
            "none",
        )
        .unwrap_err();
        assert_eq!(unexpected.code, "github_error");
        assert_eq!(unexpected.message, "GitHub 分页响应异常。");
        assert_eq!(unexpected.details.as_deref(), Some("502"));
    }

    #[test]
    fn page_parser_rejects_valid_json_with_the_wrong_top_level_shape() {
        let error =
            parse_json_array_page(200, &HeaderMap::new(), br#"{"items":[]}"#, "repo_account")
                .unwrap_err();

        assert_eq!(error.code, "github_error");
        assert_eq!(error.message, "GitHub 响应不是数组。");
    }
}
