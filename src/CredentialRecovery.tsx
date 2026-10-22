import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "./UiPrimitives";
import { credentialError } from "./credentialTypes";
import type { CredentialRestorePreview, CredentialStatus, CredentialTransport } from "./credentialTypes";

export function CredentialRecovery({ transport, language, demo, onClose, onStatus, onMessage }: {
  transport: CredentialTransport; language: string; demo: boolean; onClose: () => void;
  onStatus: (status: CredentialStatus) => void; onMessage: (message: string) => void;
}) {
  const zh = language === "zh";
  const [selection, setSelection] = useState<{ selectionId: string; name: string } | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<CredentialRestorePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const finished = useRef(false);
  const started = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (started.current && !finished.current) void transport.request({ action: "restore_cancel" }).catch(() => undefined);
    };
  }, [transport]);

  async function choose() {
    started.current = true;
    setPending(true); setError(""); setPassword(""); setPreview(null); setSelection(null);
    try {
      const chosen = await transport.request({ action: "restore_pick" });
      if (!active.current) { void transport.request({ action: "restore_cancel" }).catch(() => undefined); return; }
      const status = await transport.request({ action: "status" });
      if (!active.current) return;
      onStatus(status);
      if (chosen.selectionId) setSelection({ selectionId: chosen.selectionId, name: chosen.name ?? (zh ? "已选备份" : "Selected backup") });
    } catch (failure) {
      if (active.current) {
        setError(credentialError(failure, language));
        try { const status = await transport.request({ action: "status" }); if (active.current) onStatus(status); } catch { /* Keep the original error. */ }
      }
    } finally { if (active.current) setPending(false); }
  }
  async function inspect() {
    if (!selection || !password || pending) return;
    const submittedPassword = password;
    setPassword(""); setPending(true); setError("");
    try {
      const result = await transport.request({ action: "restore_preview", selectionId: selection.selectionId, password: submittedPassword });
      if (active.current) setPreview(result);
    } catch (failure) { if (active.current) setError(credentialError(failure, language)); }
    finally { if (active.current) setPending(false); }
  }
  async function commit() {
    if (!preview || pending) return;
    setPending(true); setError("");
    try {
      const result = await transport.request({ action: "restore_commit", restoreId: preview.restoreId });
      if (!active.current) return;
      finished.current = true;
      onStatus(result);
      onMessage(result.restartRequired
        ? (zh ? "备份已恢复，但凭据服务未能重启。请重新打开软件，再使用备份的主密码解锁。" : "The backup was restored, but the credential service could not restart. Reopen the app and unlock with the backup's master password.")
        : (zh ? "恢复完成，凭据库保持锁定。请使用备份的主密码解锁。" : "Restored. The vault remains locked; unlock it with the backup's master password."));
      onClose();
    } catch (failure) { if (active.current) setError(credentialError(failure, language)); }
    finally { if (active.current) setPending(false); }
  }
  async function cancel() {
    if (pending) return;
    if (!started.current) { finished.current = true; onClose(); return; }
    setPending(true); setPassword(""); setError("");
    try {
      const result = await transport.request({ action: "restore_cancel" });
      if (!active.current) return;
      finished.current = true; onStatus(result); onClose();
    } catch (failure) { if (active.current) setError(credentialError(failure, language)); }
    finally { if (active.current) setPending(false); }
  }
  return <Modal title={zh ? "从加密备份恢复" : "Restore encrypted backup"} closeLabel={zh ? "关闭恢复" : "Close restore"} onClose={() => void cancel()}
    footer={<><Button disabled={pending} onClick={() => void cancel()}>{zh ? "取消" : "Cancel"}</Button>{preview
      ? <Button variant="primary" pending={pending} onClick={() => void commit()}>{zh ? "确认恢复" : "Confirm restore"}</Button>
      : <Button variant="primary" pending={pending} disabled={!selection || !password} onClick={() => void inspect()}>{zh ? "验证备份" : "Verify backup"}</Button>}</>}>
    <p>{zh ? "选择备份时会先锁定当前库。验证通过后才会替换；取消后原库仍可重新解锁。" : "Selecting a backup first locks the current vault. Replacement only happens after verification; cancelling leaves the original vault available to unlock."}</p>
    <Button disabled={pending || demo} onClick={() => void choose()}>{selection ? (zh ? "重新选择备份" : "Choose another backup") : (zh ? "选择备份文件" : "Choose backup file")}</Button>
    {selection && <p className="credential-file-name">{selection.name}</p>}
    {demo && <p className="credential-hint">{zh ? "浏览器演示不读取或恢复真实备份，请在桌面版使用。" : "The browser demo cannot read or restore real backups. Use the desktop app."}</p>}
    {selection && !preview && <form onSubmit={(event) => { event.preventDefault(); void inspect(); }}><label className="credential-field"><span>{zh ? "备份的主密码" : "Backup master password"}</span><input type="password" autoComplete="off" disabled={pending} value={password} onChange={(event) => setPassword(event.target.value)} /></label></form>}
    {preview && <div className="credential-restore-summary"><p>{zh ? `已验证：${preview.recordCount} 条凭据，${preview.fileCount} 个文件。` : `Verified: ${preview.recordCount} records and ${preview.fileCount} files.`}</p>
      <p>{preview.replacesExisting ? (zh ? "将替换当前库；切换前保留当前库的加密恢复副本。" : "This replaces the current vault. An encrypted recovery copy is retained before switching.") : (zh ? "将直接创建恢复后的库，无需先建立空库。" : "The restored vault will be created directly; no empty vault is needed.")}</p>
      <p>{preview.sameVault ? (zh ? "同机同库保留现有共享授权；恢复后仍需手动解锁。" : "Existing local authorization is retained for the same vault; manual unlock is still required.") : (zh ? "恢复为不同库或新设备时，Agent 访问默认关闭，需要重新开启。" : "Agent access defaults to off for a different vault or new device and must be enabled again.")}</p></div>}
    {error && <p className="credential-error" role="alert">{error}</p>}
  </Modal>;
}
