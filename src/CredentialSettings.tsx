import { useEffect, useState } from "react";
import { Button, Modal } from "./UiPrimitives";
import { credentialError } from "./credentialTypes";
import { CredentialMaintenance } from "./CredentialMaintenance";
import { CredentialRecovery } from "./CredentialRecovery";
import type { CredentialRequest, CredentialStatus, CredentialTransport } from "./credentialTypes";
import "./credentials.css";

export function CredentialSettings({ transport, language, onOpenVault, demo }: {
  transport: CredentialTransport; language: string; onOpenVault: () => void; demo: boolean;
}) {
  const zh = language === "zh";
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [maintenance, setMaintenance] = useState<"password" | "backup" | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<"enable" | "disable" | "reset" | null>(null);
  useEffect(() => {
    let active = true;
    void transport.request({ action: "status" }).then((value) => { if (active) setStatus(value); }).catch((failure: unknown) => { if (active) setError(credentialError(failure, language)); });
    return () => { active = false; };
  }, [transport]);
  async function act(request: CredentialRequest) {
    setPending(true); setError("");
    try { await transport.request(request); setStatus(await transport.request({ action: "status" })); setConfirm(null); }
    catch (failure) { setError(credentialError(failure, language)); }
    finally { setPending(false); }
  }
  return <section className="settings-section wide credential-settings" aria-label={zh ? "凭据库设置" : "Credential vault settings"}>
    <header className="settings-section-header"><h2>{zh ? "凭据库" : "Credential vault"}</h2></header>
    <p className="credential-hint">{zh ? "主密码用于手动解锁和查看；Agent 共用访问码由软件管理。" : "Use your master password to unlock and view records. The app manages a shared Agent access code."}</p>
    <div className="credential-setting-row"><div><strong>{zh ? "凭据库状态" : "Vault status"}</strong><p>{!status ? (zh ? "正在检查" : "Checking") : !status.exists ? (zh ? "尚未创建" : "Not created") : status.locked ? (zh ? "已锁定，授权仍保留" : "Locked; authorization retained") : (zh ? "已解锁，重开软件后需手动解锁" : "Unlocked; reopening the app requires manual unlock")}</p></div>
      <Button onClick={status?.exists && !status.locked ? () => void act({ action: "lock" }) : onOpenVault} disabled={pending}>{status?.exists && !status.locked ? (zh ? "立即锁定" : "Lock now") : (zh ? "前往凭据库" : "Open vault")}</Button>
    </div>
    <div className="credential-setting-row"><div><strong>{zh ? "主密码" : "Master password"}</strong><p>{zh ? "修改后需要重新解锁；Agent 访问码保留。" : "Unlock again after changing it; the Agent access code is retained."}</p></div><Button disabled={pending || !status?.exists || status.locked} onClick={() => setMaintenance("password")}>{zh ? "修改主密码" : "Change master password"}</Button></div>
    <div className="credential-setting-row"><div><strong>{zh ? "加密备份" : "Encrypted backup"}</strong><p>{status?.lastBackupAt ? (zh ? `上次成功备份：${status.lastBackupAt}` : `Last successful backup: ${status.lastBackupAt}`) : (zh ? "上次成功备份：尚无记录" : "No successful backup recorded")}</p></div><Button disabled={pending || !status?.exists || status.locked} onClick={() => setMaintenance("backup")}>{zh ? "创建备份" : "Create backup"}</Button></div>
    <div className="credential-setting-row"><div><strong>{zh ? "从备份恢复" : "Restore from backup"}</strong><p>{zh ? "验证加密备份后恢复；恢复期间保持锁定。" : "Restore after verifying an encrypted backup; the vault stays locked during recovery."}</p></div><Button disabled={pending || !status} onClick={() => setRecovering(true)}>{zh ? "恢复备份" : "Restore backup"}</Button></div>
    <div className="credential-setting-row"><div><strong>{zh ? "允许本机 Agent 读取凭据" : "Allow local Agents to read credentials"}</strong><p>{zh ? "共享范围包含当前与以后新增的全部凭据。" : "Sharing includes all existing and future credentials."}</p></div>
      <Button disabled={pending || !status?.exists || status.locked} onClick={() => setConfirm(status?.sharingRequested ? "disable" : "enable")}>{status?.sharingRequested ? (zh ? "关闭访问" : "Disable access") : (zh ? "开启访问" : "Enable access")}</Button>
    </div>
    <div className="credential-setting-row"><div><strong>{zh ? "共用访问码" : "Shared access code"}</strong><p>{zh ? "长期保留；重置使旧访问码与旧会话失效。" : "Retained until reset. Reset invalidates the old code and sessions."}</p></div><Button disabled={pending || !status?.exists || status.locked} onClick={() => setConfirm("reset")}>{zh ? "重置访问码" : "Reset access code"}</Button></div>
    {status?.authorizationError && <div className="credential-setting-row"><div><strong>{zh ? "需要系统授权" : "System authorization required"}</strong><p>{zh ? "解锁后点击恢复授权，并在 macOS 系统窗口确认。" : "Unlock the vault, then restore authorization in the macOS system dialog."}</p></div><Button pending={pending} disabled={status.locked} onClick={() => void act({ action: "authorize_access" })}>{zh ? "恢复系统授权" : "Restore system authorization"}</Button></div>}
    <p className="credential-hint">{demo ? (zh ? "浏览器演示不会建立授权或访问钥匙串。" : "Browser demo does not authorize access or use Keychain.") : (zh ? "凭据页右上角提供所选 Agent 的接入说明；开启共享不代表客户端已连接。" : "Use the selected Agent guide at the top of the vault page. Enabling sharing does not mean a client is connected.")}</p>
    <p className="credential-hint">{zh ? "Agent 读取后，原文可能保留在客户端历史中。退出后停止新读取；移除应用不会自动删除凭据库、导出文件或系统钥匙串中的接入材料。" : "Agents may retain returned secrets in history. Exiting stops new reads; removing the app does not automatically delete the vault, exported files or Keychain access material."}</p>
    {status?.clipboard?.error && <p className="credential-error" role="alert">{zh ? "剪贴板清理未完成，请自行检查。" : "Clipboard cleanup is incomplete. Please check it manually."}</p>}
    {status?.cleanupFailed && <div className="credential-setting-row"><p className="credential-error" role="alert">{zh ? "受管文件清理未完成，秘密读取暂停。" : "Managed-file cleanup is incomplete. Secret reads are paused."}{status.cleanupRemaining !== undefined ? ` (${status.cleanupRemaining})` : ""}</p><Button pending={pending} onClick={() => void act({ action: "retry_cleanup" })}>{zh ? "重试清理" : "Retry cleanup"}</Button></div>}
    {message && <p role="status">{message}</p>}
    {error && <p className="credential-error" role="alert">{error}</p>}
    {maintenance && <CredentialMaintenance mode={maintenance} transport={transport} language={language} demo={demo} onClose={() => setMaintenance(null)} onStatus={setStatus} onMessage={setMessage} />}
    {recovering && <CredentialRecovery transport={transport} language={language} demo={demo} onClose={() => setRecovering(false)} onStatus={setStatus} onMessage={setMessage} />}
    {confirm && <Modal title={confirm === "reset" ? (zh ? "重置共用访问码" : "Reset shared access code") : confirm === "enable" ? (zh ? "开启 Agent 访问" : "Enable Agent access") : (zh ? "关闭 Agent 访问" : "Disable Agent access")}
      closeLabel={zh ? "关闭" : "Close"} onClose={() => { if (!pending) setConfirm(null); }} footer={<><Button disabled={pending} onClick={() => setConfirm(null)}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" pending={pending}
        onClick={() => void act(confirm === "reset" ? { action: "reset_access" } : { action: "share", enabled: confirm === "enable" })}>{zh ? "确认" : "Confirm"}</Button></>}>
      <p>{confirm === "reset" ? (zh ? "旧码和旧会话将失效，凭据与主密码不变。" : "The old code and sessions will stop working. Records and the master password remain unchanged.") : confirm === "enable" ? (zh ? "所有本机已配置 Agent 共用全库读取权限，覆盖已有和新增凭据。返回原文可能进入客户端上下文和历史。" : "All configured local Agents share access to existing and future credentials. Returned secrets may enter their context and history.") : (zh ? "停止后续 Agent 读取，凭据、主密码和访问码保留。已经交付的内容无法撤回。" : "Stop future Agent reads while retaining credentials, password and access code. Already delivered content cannot be recalled.")}</p>
      {error && <p className="credential-error" role="alert">{error}</p>}
    </Modal>}
  </section>;
}
