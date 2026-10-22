use super::*;

#[test]
fn reviewed_domain_errors_offer_specific_recovery_without_echoing_untrusted_diagnostics() {
    for (code, guidance) in [
        ("password_or_vault_invalid", "主密码"),
        ("password_confirmation_mismatch", "不一致"),
        ("password_length_invalid", "1024字节"),
        ("password_retry_later", "稍后"),
        ("vault_locked", "解锁"),
        ("record_not_found", "不存在"),
        ("record_version_conflict", "重新加载"),
        ("human_verification_required", "重新验证"),
        ("human_session_invalid", "重新验证"),
        ("stale_generation", "重新验证"),
        ("record_required_fields_missing", "定位字段"),
        ("record_required_secret_missing", "秘密不能为空"),
        ("ssh_private_key_file_required", "导入私钥文件"),
        ("record_port_invalid", "65535"),
        ("record_url_invalid", "不含账号密码"),
        ("record_host_invalid", "不能包含连接串"),
        ("secret_limit_exceeded", "1MiB"),
        ("file_limit_exceeded", "16MiB"),
        ("too_many_file_leases", "先释放不再使用的文件租约"),
        ("file_not_text", "原文件导出"),
        ("secret_text_response_too_large", "原文件导出"),
        ("credential_authorization_required", "明确授权"),
        ("credential_authorization_denied", "明确授权"),
        ("credential_authorization_cancelled", "已取消"),
        ("password_or_backup_invalid", "备份文件"),
        ("backup_destination_exists", "新的文件名"),
        ("selected_file_changed", "重新选择"),
        ("backup_source_changed", "重新选择"),
        ("selected_file_is_managed", "目录以外"),
        ("backup_destination_inside_vault", "目录以外"),
        ("file_inspection_timeout", "未完成验证"),
        ("file_inspection_unavailable", "未完成验证"),
        ("file_passphrase_unsupported", "未完成验证"),
        ("password_change_failed", "保持原密码"),
        ("credential_host_already_running", "关闭占用"),
        ("export_cleanup_failed", "已锁定"),
        ("file_export_cleanup_failed", "原文件已导出"),
    ] {
        assert_eq!(error_code(code), code);
        assert!(
            message(code).contains(guidance),
            "missing recovery guidance for {code}"
        );
    }
    assert!(message("clipboard_changed").contains("未清除其他复制内容"));
    let untrusted = "synthetic secret in /untrusted/private/path";
    assert_eq!(error_code(untrusted), "credential_host_unavailable");
    assert!(!message(untrusted).contains("synthetic secret"));
    assert!(!message(untrusted).contains("/untrusted"));
    assert_ne!(
        message("export_cleanup_failed"),
        message("file_export_cleanup_failed")
    );
}
