import { useState } from "react";
import { Button, Modal } from "./UiPrimitives";
import { credentialDurabilityNotice, credentialError } from "./credentialTypes";
import type { CredentialStatus, CredentialTransport } from "./credentialTypes";

export function CredentialMaintenance({ mode, transport, language, demo, onClose, onStatus, onMessage }: {
  mode: "password" | "backup"; transport: CredentialTransport; language: string; demo: boolean;
  onClose: () => void; onStatus: (status: CredentialStatus) => void; onMessage: (message: string) => void;
}) {
  const zh = language === "zh";
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function saveMaintenance() {
    if (pending || !oldPassword || (mode === "backup" && demo)) return;
    if (mode === "password" && newPassword !== confirmation) { setError(credentialError({ code: "password_confirmation_mismatch" }, language)); return; }
    setPending(true); setError("");
    const old = oldPassword;
    const next = newPassword;
    const confirm = confirmation;
    setOldPassword(""); setNewPassword(""); setConfirmation("");
    try {
      if (mode === "password") {
        onStatus(await transport.request({ action: "change_password", oldPassword: old, newPassword: next, confirmPassword: confirm }));
        onMessage(zh ? "主密码已修改，Agent 访问码保留。请用新密码重新解锁。" : "Master password changed; the Agent access code is retained. Unlock with the new password.");
      } else {
        const result = await transport.request({ action: "backup_create", password: old });
        if (!result.created) return;
        const warnings = result.warnings ?? (result.warning ? [result.warning] : []);
        let notice = result.simulated ? (zh ? "仅演示备份，未写入真实文件。" : "Backup simulated; no real file was written.") : (zh ? "加密备份已创建。恢复时需要此备份创建时的主密码。" : "Encrypted backup created. Restoring it requires its original master password.");
        if (warnings.includes("backup_metadata_failed")) notice += zh ? " 备份时间未能登记。" : " The backup time could not be recorded.";
        if (warnings.includes("backup_sync_unconfirmed")) notice += credentialDurabilityNotice(zh);
        if (warnings.includes("backup_cleanup_failed")) notice += zh ? " 加密暂存清理未完成。" : " Encrypted staging cleanup is incomplete.";
        try { onStatus(await transport.request({ action: "status" })); }
        catch { notice += zh ? " 状态刷新失败，请重新打开凭据页核对。" : " Status refresh failed; reopen the vault page to check."; }
        onMessage(notice);
      }
      onClose();
    } catch (failure) { setError(credentialError(failure, language)); }
    finally { setPending(false); }
  }
  return <Modal title={mode === "password" ? (zh ? "修改主密码" : "Change master password") : (zh ? "创建加密备份" : "Create encrypted backup")}
    closeLabel={zh ? "关闭" : "Close"} onClose={() => { if (!pending) onClose(); }}
    footer={<><Button disabled={pending} onClick={onClose}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" pending={pending} disabled={!oldPassword || (mode === "backup" && demo)} onClick={() => void saveMaintenance()}>{mode === "password" ? (zh ? "确认修改" : "Change password") : (zh ? "选择位置并备份" : "Choose location and back up")}</Button></>}>
    <p>{mode === "password" ? (zh ? "成功后锁定凭据库并结束旧会话；失败保留旧密码与原库。已有备份和恢复副本仍使用创建时的密码。" : "Success locks the vault and ends old sessions. Failure preserves the old password and vault. Existing backups and recovery copies keep their original password.") : (zh ? "备份包含加密后的凭据与原文件，不包含设备访问码。请妥善保管备份和主密码。" : "The backup contains encrypted credentials and original files, without the device access code. Keep the backup and master password safe.")}</p>
    {demo && mode === "backup" && <p className="credential-hint">{zh ? "浏览器演示不生成真实加密备份，请在桌面版使用。" : "The browser demo cannot create real encrypted backups. Use the desktop app."}</p>}
    <form onSubmit={(event) => { event.preventDefault(); if (mode !== "backup" || !demo) void saveMaintenance(); }}>
      <label className="credential-field"><span>{mode === "password" ? (zh ? "当前主密码" : "Current master password") : (zh ? "主密码" : "Master password")}</span><input data-autofocus type="password" autoComplete="off" disabled={pending} value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} /></label>
      {mode === "password" && <><label className="credential-field"><span>{zh ? "新主密码" : "New master password"}</span><input type="password" autoComplete="off" disabled={pending} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label className="credential-field"><span>{zh ? "再次输入新主密码" : "Confirm new master password"}</span><input type="password" autoComplete="off" disabled={pending} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <p className="credential-hint">{zh ? "至少 12 个字符，最多 1024 个 UTF-8 字节。" : "At least 12 characters, at most 1024 UTF-8 bytes."}</p></>}
    </form>{error && <p className="credential-error" role="alert">{error}</p>}
  </Modal>;
}
