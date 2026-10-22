import { useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, FileKey, LockKeyhole, Pencil, X } from "lucide-react";
import { Button, Modal } from "./UiPrimitives";
import { credentialError, credentialErrorCode, newCredentialSessionId } from "./credentialTypes";
import type { CredentialRecord, CredentialTransport } from "./credentialTypes";
import { credentialLabel, credentialTypeLabel } from "./credentialForm";

type Props = {
  record: CredentialRecord;
  transport: CredentialTransport;
  language: string;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMessage: (message: string) => void;
  onSecretCopied?: () => void;
  onUnavailable?: () => void;
};
type SecretAction = { field: string; kind: "show" | "copy" };

export function CredentialDetail({ record, transport, language, onClose, onEdit, onDelete, onMessage, onSecretCopied, onUnavailable }: Props) {
  const zh = language === "zh";
  const [shown, setShown] = useState<Record<string, string>>({});
  const [verified, setVerified] = useState(false);
  const [verify, setVerify] = useState<SecretAction | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const session = useRef<string>(newCredentialSessionId());
  const currentVerified = useRef("");
  const active = useRef(true);
  const drawer = useRef<HTMLElement | null>(null);

  function invalidate() {
    const previous = session.current;
    session.current = newCredentialSessionId();
    currentVerified.current = "";
    setShown({}); setVerified(false); setVerify(null); setPassword(""); setPending(false);
    void transport.request({ action: "invalidate_session", sessionId: previous }).catch(() => {
      if (active.current) setError(zh ? "未能确认验证会话已结束，请锁定凭据库。" : "Could not confirm session invalidation. Lock the vault.");
    });
  }
  useEffect(() => {
    active.current = true;
    session.current = newCredentialSessionId();
    currentVerified.current = "";
    setShown({}); setVerified(false); setVerify(null); setPassword(""); setPending(false);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const blur = () => invalidate();
    window.addEventListener("blur", blur);
    return () => {
      active.current = false;
      window.removeEventListener("blur", blur);
      const previous = session.current;
      session.current = "";
      currentVerified.current = "";
      void transport.request({ action: "invalidate_session", sessionId: previous }).catch(() => undefined);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [transport]);

  function valid(id: string) { return Boolean(id) && active.current && session.current === id; }
  function failed(failure: unknown, id: string) {
    if (!valid(id)) return;
    const code = credentialErrorCode(failure);
    if (["credential_host_unavailable", "vault_locked", "human_session_invalid", "human_verification_required", "stale_generation", "record_version_conflict"].includes(code)) invalidate();
    setError(credentialError(failure, language));
    if (code === "credential_host_unavailable" || code === "vault_locked") onUnavailable?.();
  }
  async function execute(action: SecretAction, id: string) {
    const identity = { recordId: record.recordId, expectedVersion: record.version, sessionId: id };
    if (!valid(id)) return;
    if (action.kind === "copy") {
      const result = await transport.request({ action: "copy_secret", ...identity, field: action.field });
      if (valid(id) && result.copied) {
        onMessage(result.simulated
          ? (zh ? "演示复制完成，未写入系统剪贴板。" : "Copy simulated; the system clipboard was not changed.")
          : (zh ? "已复制。30 秒后尝试清理本次剪贴板内容。" : "Copied. Cleanup of this clipboard item will be attempted after 30 seconds."));
        if (!result.simulated) onSecretCopied?.();
      }
    } else {
      const result = await transport.request({ action: "read_fields", ...identity, fields: [action.field] });
      if (valid(id) && result.recordId === record.recordId && typeof result.fields[action.field] === "string") {
        setShown((values) => ({ ...values, [action.field]: result.fields[action.field] }));
      }
    }
  }
  async function requestAction(action: SecretAction) {
    setError("");
    if (!session.current || currentVerified.current !== session.current) { setVerify(action); return; }
    const id = session.current;
    setPending(true);
    try { await execute(action, id); }
    catch (failure) { failed(failure, id); }
    finally { if (valid(id)) setPending(false); }
  }
  async function authenticate() {
    if (!verify || pending) return;
    const action = verify;
    const id = session.current;
    setPending(true); setError("");
    try {
      const result = await transport.request({ action: "verify", recordId: record.recordId, expectedVersion: record.version, password, sessionId: id });
      if (!valid(id) || !result.verified) return;
      currentVerified.current = id;
      setVerified(true); setVerify(null); setPassword("");
      await execute(action, id);
    } catch (failure) { failed(failure, id); }
    finally { if (valid(id)) setPending(false); }
  }
  const fields = [...new Set([...record.secretFields, ...record.files.filter((file) => file.textReadable).map((file) => file.field)])]
    .filter((field) => !record.files.some((file) => file.field === field && !file.textReadable));
  return <aside className="credential-drawer" role="dialog" ref={drawer} aria-label={zh ? "凭据详情" : "Credential details"}>
    <header><div><h2>{record.name}</h2><span className="credential-tag">{credentialTypeLabel(record.type, language)}</span></div>
      <button type="button" className="credential-icon-button" aria-label={zh ? "关闭详情" : "Close details"} onClick={onClose}><X size={18} /></button>
    </header>
    <div className="credential-detail-actions"><span>{zh ? "更新于 " : "Updated "}{record.updatedAt.slice(0, 10)}</span><Button onClick={onEdit}><Pencil size={14} />{zh ? "编辑" : "Edit"}</Button></div>
    <div className="credential-drawer-scroll">
      <dl className="credential-metadata">{Object.entries(record.metadata).filter(([, value]) => value).map(([key, value]) => <div key={key}><dt>{credentialLabel(key, language)}</dt><dd>{value}</dd></div>)}</dl>
      {record.files.map((file) => <div className="credential-file-card" key={file.field}><FileKey size={18} /><div><strong>{file.name}</strong><small>{file.size.toLocaleString()} bytes · {file.textReadable ? (zh ? "可读文本" : "Readable text") : (zh ? "二进制文件" : "Binary file")}</small></div></div>)}
      {record.files.some((file) => !file.textReadable) && <p className="credential-hint">{zh ? "二进制文件已加密保管，当前版本暂不支持导出原文件。" : "Binary files are stored encrypted. Original-file export is not yet supported in this version."}</p>}
      {fields.map((field) => <section className="credential-secret" key={field}>
        <div className="credential-secret-label"><strong>{credentialLabel(field, language)}</strong><div>
          <button className="credential-icon-button" type="button" disabled={pending}
            aria-label={`${field in shown ? (zh ? "隐藏" : "Hide ") : (zh ? "显示" : "Show ")}${credentialLabel(field, language)}`}
            onClick={() => field in shown ? setShown((values) => Object.fromEntries(Object.entries(values).filter(([key]) => key !== field))) : void requestAction({ field, kind: "show" })}>
            {field in shown ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button className="credential-icon-button" type="button" disabled={pending} aria-label={`${zh ? "复制" : "Copy "}${credentialLabel(field, language)}`}
            onClick={() => void requestAction({ field, kind: "copy" })}><Copy size={16} /></button>
        </div></div>
        {field in shown ? <pre className="credential-secret-value">{shown[field]}</pre> : <div className="credential-masked" aria-label={zh ? "内容已隐藏" : "Content hidden"}>••••••••</div>}
      </section>)}
      <p className="credential-hint"><LockKeyhole size={13} /> {verified ? (zh ? "当前详情已验证；切换记录、关闭或离开窗口后需重新验证。" : "Verified for these details. Switching, closing or leaving the window ends verification.") : (zh ? "查看或复制时验证主密码。" : "Verify your master password to view or copy.")}</p>
      {error && !verify && <p role="alert" className="credential-error">{error}</p>}
      <section className="credential-note"><h3>{zh ? "备注" : "Notes"}</h3><p>{record.note || (zh ? "暂无备注" : "No notes")}</p></section>
    </div>
    <footer><button className="credential-danger-link" type="button" onClick={onDelete}>{zh ? "删除凭据" : "Delete credential"}</button><span>{zh ? "秘密默认隐藏" : "Secrets hidden by default"}</span></footer>
    {verify && <Modal title={zh ? "验证主密码" : "Verify master password"} closeLabel={zh ? "关闭验证" : "Close verification"}
      onClose={() => invalidate()} footer={<><Button onClick={() => invalidate()}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" pending={pending} onClick={() => void authenticate()}>{zh ? "验证并继续" : "Verify and continue"}</Button></>}>
      <p>{zh ? `验证后${verify.kind === "copy" ? "复制" : "显示"}「${record.name}」的${credentialLabel(verify.field, language)}。` : `Verify to ${verify.kind} ${credentialLabel(verify.field, language)} for ${record.name}.`}</p>
      <form onSubmit={(event) => { event.preventDefault(); void authenticate(); }}><label className="credential-field"><span>{zh ? "主密码" : "Master password"}</span><input type="password" autoComplete="off" data-autofocus value={password} onChange={(event) => setPassword(event.target.value)} /></label></form>
      {error && <p role="alert" className="credential-error">{error}</p>}
    </Modal>}
  </aside>;
}
