import { useEffect, useRef, useState } from "react";
import { Copy, Download, Eye, EyeOff, FileKey, LockKeyhole, Pencil, X } from "lucide-react";
import { Button, Modal } from "./UiPrimitives";
import { credentialError, credentialErrorCode, newCredentialSessionId } from "./credentialTypes";
import type { CredentialFileInspection, CredentialRecord, CredentialTransport } from "./credentialTypes";
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
  onUnavailable?: (notice?: string) => void;
};
type SecretAction = { field: string; kind: "show" | "copy" | "inspect" } | { field: string; kind: "export"; selectionId: string };
const FORMAT_LABELS: Record<string, string> = { openssh_private_key: "OpenSSH", pem_encrypted_private_key: "PEM (encrypted)", pem_private_key: "PEM", pem_certificate: "PEM certificate", putty_private_key: "PuTTY / PPK", pkcs7_certificate: "PKCS#7", binary_or_unknown: "" };

export function CredentialDetail({ record, transport, language, onClose, onEdit, onDelete, onMessage, onSecretCopied, onUnavailable }: Props) {
  const zh = language === "zh";
  const [shown, setShown] = useState<Record<string, string>>({});
  const [verified, setVerified] = useState(false);
  const [verify, setVerify] = useState<SecretAction | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [inspection, setInspection] = useState<CredentialFileInspection | null>(null);
  const session = useRef("");
  const currentVerified = useRef("");
  const nativeReady = useRef<CredentialTransport | null>(null);
  const active = useRef(true);
  const exportGeneration = useRef(0);
  const drawer = useRef<HTMLElement | null>(null);

  function resetDetails() {
    session.current = newCredentialSessionId();
    currentVerified.current = "";
    setShown({}); setVerified(false); setVerify(null); setPassword(""); setPending(false); setInspection(null);
  }
  function focusUnavailable() { setError(credentialError("window_focus_unavailable", language)); }
  function canUseSecrets() {
    if (!transport.onBlur || nativeReady.current === transport) return true;
    focusUnavailable();
    return false;
  }
  function invalidate() {
    const previous = session.current;
    resetDetails();
    void transport.request({ action: "invalidate_session", sessionId: previous }).catch(() => {
      if (active.current) setError(zh ? "未能确认验证会话已结束，请锁定凭据库。" : "Could not confirm session invalidation. Lock the vault.");
    });
  }
  useEffect(() => {
    active.current = true;
    nativeReady.current = null;
    resetDetails();
    let disposed = false;
    let unlisten: (() => void | Promise<void>) | undefined;
    const release = () => { if (unlisten) void Promise.resolve().then(unlisten).catch(() => undefined); };
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const blur = () => { if (!disposed) invalidate(); };
    window.addEventListener("blur", blur);
    if (transport.onBlur) void transport.onBlur(blur).then((stop) => {
      unlisten = stop;
      if (disposed) release();
      else nativeReady.current = transport;
    }).catch(() => { if (!disposed) focusUnavailable(); });
    return () => {
      disposed = true;
      active.current = false;
      nativeReady.current = null;
      exportGeneration.current += 1;
      window.removeEventListener("blur", blur);
      release();
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
    if (["credential_host_unavailable", "vault_locked", "human_session_invalid", "human_verification_required", "stale_generation", "record_version_conflict", "export_cleanup_failed", "file_export_cleanup_failed"].includes(code)) invalidate();
    setError(credentialError(failure, language));
    if (["credential_host_unavailable", "vault_locked", "export_cleanup_failed", "file_export_cleanup_failed"].includes(code)) {
      onUnavailable?.(code === "export_cleanup_failed" || code === "file_export_cleanup_failed" ? credentialError(failure, language) : undefined);
    }
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
    } else if (action.kind === "inspect") {
      const result = await transport.request({ action: "inspect_files", ...identity });
      if (valid(id)) setInspection(result);
    } else if (action.kind === "export") {
      const result = await transport.request({ action: "export_file", ...identity, field: action.field, selectionId: action.selectionId });
      if (valid(id) && result.exported) onMessage(result.simulated
        ? (zh ? "演示导出完成，未创建真实文件。" : "Export simulated; no real file was created.")
        : (zh ? "原文件已导出。此副本由你保管，锁库不会删除。" : "The original file was exported. This copy is yours to manage and will not be removed when locking the vault."));
    } else {
      const result = await transport.request({ action: "read_fields", ...identity, fields: [action.field] });
      if (valid(id) && result.recordId === record.recordId && typeof result.fields[action.field] === "string") {
        setShown((values) => ({ ...values, [action.field]: result.fields[action.field] }));
      }
    }
  }
  async function chooseExport(field: string) {
    if (pending || !canUseSecrets()) return;
    const token = ++exportGeneration.current;
    setPending(true); setError("");
    try {
      const result = await transport.request({ action: "prepare_export", recordId: record.recordId, expectedVersion: record.version, field });
      if (!active.current || token !== exportGeneration.current || !result.selectionId) return;
      // The native save dialog may blur the window. Verify its new session after returning.
      await requestAction({ kind: "export", field, selectionId: result.selectionId });
    } catch (failure) { if (active.current && token === exportGeneration.current) setError(credentialError(failure, language)); }
    finally { if (active.current && token === exportGeneration.current) setPending(false); }
  }
  async function requestAction(action: SecretAction) {
    if (!canUseSecrets()) return;
    setError("");
    if (!session.current || currentVerified.current !== session.current) { setVerify(action); return; }
    const id = session.current;
    setPending(true);
    try { await execute(action, id); }
    catch (failure) { failed(failure, id); }
    finally { if (valid(id)) setPending(false); }
  }
  async function authenticate() {
    if (!verify || pending || !canUseSecrets()) return;
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
      {record.files.map((file) => <div className="credential-file-card" key={file.field}><FileKey size={18} /><div><strong>{file.name}</strong><small>{file.size.toLocaleString()} bytes · {file.textReadable ? (zh ? "可读文本" : "Readable text") : (zh ? "二进制文件" : "Binary file")}</small>{file.formatHint && <small>{FORMAT_LABELS[file.formatHint] ? `${FORMAT_LABELS[file.formatHint]} · ${zh ? "仅识别文件头，未验证" : "Header recognized; unverified"}` : (zh ? "格式未识别，仅保管原文件" : "Unknown format; original bytes stored")}</small>}</div>
        <Button disabled={pending} onClick={() => void chooseExport(file.field)} aria-label={`${zh ? "导出原文件 " : "Export original file "}${file.name}`}><Download size={14} />{zh ? "导出" : "Export"}</Button></div>)}
      {record.files.length > 0 && <p className="credential-hint">{zh ? "先选择保存位置，再验证并导出原字节。导出件由你保管。" : "Choose a destination, then verify to export the original bytes. You manage exported copies."}</p>}
      {(record.type === "ssh" || record.type === "tls") && <section className="credential-file-inspection"><Button disabled={pending} onClick={() => void requestAction({ field: "files", kind: "inspect" })}>{zh ? "检查文件" : "Check files"}</Button>
        {inspection && <div role="status"><p>{zh ? "私钥解析：" : "Private key: "}{inspection.keyParsed === null ? (zh ? "未检查或格式不支持" : "Not checked or unsupported") : inspection.keyParsed ? (zh ? "通过" : "Parsed") : (zh ? "未通过，请检查口令或格式" : "Failed; check passphrase or format")}</p>
          {record.type === "tls" && <><p>{zh ? "证书解析：" : "Certificate: "}{inspection.certificateParsed === null ? (zh ? "未检查或格式不支持" : "Not checked or unsupported") : inspection.certificateParsed ? (zh ? "通过" : "Parsed") : (zh ? "未通过" : "Failed")}</p>
            <p>{zh ? "证书与私钥：" : "Certificate and key: "}{inspection.pairMatches === null ? (zh ? "未验证配对" : "Pairing unverified") : inspection.pairMatches ? (zh ? "公钥匹配" : "Public keys match") : (zh ? "不匹配" : "Do not match")}</p>
            <p>{zh ? "证书链：" : "Certificate chain: "}{inspection.chainStatus === "verified_against_supplied_chain" ? (zh ? "通过所提供链的本地检查" : "Verified against supplied chain") : inspection.chainStatus === "not_provided" ? (zh ? "未提供" : "Not provided") : inspection.chainStatus === "certificate_required" ? (zh ? "需提供可解析证书" : "A parsed certificate is required") : (zh ? "未通过检查" : "Not verified")}</p></>}
          <p className="credential-hint">{zh ? "仅检查本地文件；不证明目标服务可连接、证书受公共信任或可部署。未检查主机名和吊销状态。" : "Local files only. This does not prove service connectivity, public trust or deployability. Hostname and revocation are not checked."}</p></div>}
        {!inspection && <p className="credential-hint">{zh ? "尚未验证。PEM 证书和私钥可做本地解析/配对检查；OpenSSH、PPK、PFX 等仍可保管和原样导出。" : "Unverified. PEM certificates and keys support local parsing and pairing checks. Other formats, including OpenSSH, PPK and PFX, can still be stored and exported unchanged."}</p>}
      </section>}
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
      <p className="credential-hint"><LockKeyhole size={13} /> {verified ? (zh ? "当前详情已验证；切换记录、关闭或离开窗口后需重新验证。" : "Verified for these details. Switching, closing or leaving the window ends verification.") : (zh ? "查看、复制或导出时验证主密码。" : "Verify your master password to view, copy or export.")}</p>
      {error && !verify && <p role="alert" className="credential-error">{error}</p>}
      <section className="credential-note"><h3>{zh ? "备注" : "Notes"}</h3><p>{record.note || (zh ? "暂无备注" : "No notes")}</p></section>
    </div>
    <footer><button className="credential-danger-link" type="button" onClick={onDelete}>{zh ? "删除凭据" : "Delete credential"}</button><span>{zh ? "秘密默认隐藏" : "Secrets hidden by default"}</span></footer>
    {verify && <Modal title={zh ? "验证主密码" : "Verify master password"} closeLabel={zh ? "关闭验证" : "Close verification"}
      onClose={() => invalidate()} footer={<><Button onClick={() => invalidate()}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" pending={pending} onClick={() => void authenticate()}>{zh ? "验证并继续" : "Verify and continue"}</Button></>}>
      <p>{verify.kind === "inspect" ? (zh ? `验证后检查「${record.name}」的文件，结果不包含秘密原文。` : `Verify to check the files for ${record.name}; results exclude secret contents.`) : zh ? `验证后${verify.kind === "copy" ? "复制" : verify.kind === "export" ? "导出" : "显示"}「${record.name}」的${credentialLabel(verify.field, language)}。` : `Verify to ${verify.kind} ${credentialLabel(verify.field, language)} for ${record.name}.`}</p>
      <form onSubmit={(event) => { event.preventDefault(); void authenticate(); }}><label className="credential-field"><span>{zh ? "主密码" : "Master password"}</span><input type="password" autoComplete="off" data-autofocus value={password} onChange={(event) => setPassword(event.target.value)} /></label></form>
      {error && <p role="alert" className="credential-error">{error}</p>}
    </Modal>}
  </aside>;
}
