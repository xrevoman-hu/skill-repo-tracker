import { useEffect, useRef, useState } from "react";
import { BookOpenText, Copy, KeyRound, LockKeyhole, Plus, Search, Settings2 } from "lucide-react";
import { Button, Modal } from "./UiPrimitives";
import { CredentialDetail } from "./CredentialDetail";
import { CredentialEditor } from "./CredentialEditor";
import { CREDENTIAL_TYPES, credentialError, credentialErrorCode, credentialUsage } from "./credentialTypes";
import type { CredentialRecord, CredentialSave, CredentialStatus, CredentialTransport } from "./credentialTypes";
import { credentialLocation, credentialTypeLabel } from "./credentialForm";
import "./credentials.css";

type Props = {
  transport: CredentialTransport;
  language: string;
  theme: string;
  compact: boolean;
  demo: boolean;
  copyText: (text: string) => Promise<void>;
  confirmDiscard: () => boolean;
  onOpenSettings: () => void;
  onDirtyChange: (dirty: boolean) => void;
  registerLeaveGuard: (guard: () => Promise<boolean>) => () => void;
};

export function CredentialsView({ transport, language, theme, compact, demo, copyText, confirmDiscard, onOpenSettings, onDirtyChange, registerLeaveGuard }: Props) {
  const zh = language === "zh";
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [records, setRecords] = useState<CredentialRecord[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [selected, setSelected] = useState<CredentialRecord | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [help, setHelp] = useState(false);
  const [client, setClient] = useState("Codex");
  const [deleting, setDeleting] = useState(false);
  const generation = useRef(0);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const live = useRef(true);
  const clipboardCheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef({ dirty, pending });
  current.current = { dirty, pending };

  function changeDirty(value: boolean) { setDirty(value); onDirtyChange(value); }
  function clearRecords() { detailGeneration.current += 1; listGeneration.current += 1; setRecords([]); setSelected(null); setEditing(false); changeDirty(false); }
  async function refreshStatus() {
    const token = ++generation.current;
    setError("");
    try {
      const value = await transport.request({ action: "status" });
      if (!live.current || token !== generation.current) return;
      setStatus(value);
      if (value.locked) clearRecords();
    } catch (failure) {
      if (live.current && token === generation.current) {
        if (credentialErrorCode(failure) === "credential_host_unavailable") hideUnavailable();
        setError(credentialError(failure, language));
      }
    }
  }
  async function refreshList() {
    const token = ++listGeneration.current;
    setLoading(true);
    try {
      const result = await transport.request({ action: "list", query, type });
      if (live.current && token === listGeneration.current) setRecords(result.records);
    } catch (failure) {
      if (live.current && token === listGeneration.current) {
        if (credentialErrorCode(failure) === "credential_host_unavailable") hostUnavailable();
        else { setError(credentialError(failure, language)); void refreshStatus(); }
      }
    } finally { if (live.current && token === listGeneration.current) setLoading(false); }
  }
  function checkClipboardLater() {
    clearTimeout(clipboardCheck.current);
    clipboardCheck.current = setTimeout(() => {
      clipboardCheck.current = undefined;
      if (live.current) void refreshStatus();
    }, 31000);
  }
  function hideUnavailable() {
    generation.current += 1;
    clearRecords();
    setStatus((value) => value ? { ...value, locked: true, sharing: false } : value);
    setMessage(zh ? "凭据服务已断开，已隐藏内容。请重新解锁后继续。" : "The credential service disconnected. Content is hidden; unlock again to continue.");
  }
  function hostUnavailable() { hideUnavailable(); void refreshStatus(); }
  useEffect(() => {
    live.current = true;
    void refreshStatus();
    const focus = () => { if (!current.current.pending) void refreshStatus(); };
    window.addEventListener("focus", focus);
    return () => {
      live.current = false;
      window.removeEventListener("focus", focus);
      clearTimeout(clipboardCheck.current);
      generation.current += 1; listGeneration.current += 1; detailGeneration.current += 1;
    };
  }, [transport]);
  useEffect(() => {
    if (status && !status.locked) void refreshList();
  }, [transport, status?.locked, query, type]);
  useEffect(() => registerLeaveGuard(async () => {
    if (current.current.pending) return false;
    return !current.current.dirty || confirmDiscard();
  }), [registerLeaveGuard, confirmDiscard]);

  function mayDiscard() { return !dirty || confirmDiscard(); }
  function closeDetail() {
    if (pending || !mayDiscard()) return;
    detailGeneration.current += 1;
    setSelected(null); setEditing(false); changeDirty(false); setDeleting(false);
  }
  async function openRecord(record: CredentialRecord) {
    if (pending || !mayDiscard()) return;
    const token = ++detailGeneration.current;
    setSelected(null); setEditing(false); changeDirty(false); setError("");
    try {
      const detail = await transport.request({ action: "detail", recordId: record.recordId });
      if (live.current && token === detailGeneration.current) setSelected(detail);
    } catch (failure) {
      if (live.current && token === detailGeneration.current) {
        if (credentialErrorCode(failure) === "credential_host_unavailable") hostUnavailable();
        else setError(credentialError(failure, language));
      }
    }
  }
  function createRecord() {
    if (!mayDiscard()) return;
    detailGeneration.current += 1; setSelected(null); setEditing(true); changeDirty(false);
  }
  async function unlock() {
    if (!status || pending) return;
    if (!status.exists && password !== confirmation) { setError(zh ? "两次输入不一致，请检查确认密码。" : "The passwords do not match."); return; }
    const token = ++generation.current;
    setPending(true); setError("");
    try {
      const next = await transport.request(status.exists ? { action: "unlock", password } : { action: "create", password, confirmPassword: confirmation });
      if (live.current && token === generation.current) { setStatus(next); setPassword(""); setConfirmation(""); }
    } catch (failure) { if (live.current && token === generation.current) setError(credentialError(failure, language)); }
    finally { if (live.current && token === generation.current) setPending(false); }
  }
  async function lock() {
    if (!mayDiscard()) return;
    generation.current += 1;
    clearRecords(); setPassword(""); setConfirmation(""); setPending(true); setError("");
    setStatus((value) => value ? { ...value, locked: true, sharing: false } : value);
    try { const value = await transport.request({ action: "lock" }); if (live.current) setStatus(value); }
    catch (failure) { if (live.current) setError(credentialError(failure, language)); }
    finally { if (live.current) setPending(false); }
  }
  async function save(input: CredentialSave) {
    setPending(true);
    try {
      const value = await transport.request(input);
      if (!live.current) return;
      changeDirty(false); setEditing(false); setSelected(value);
      setMessage(zh ? "凭据已保存。" : "Credential saved.");
      await refreshList();
    } catch (failure) {
      if (live.current && credentialErrorCode(failure) === "credential_host_unavailable") hostUnavailable();
      throw failure;
    } finally { if (live.current) setPending(false); }
  }
  async function remove() {
    if (!selected || pending) return;
    setPending(true); setError("");
    try {
      await transport.request({ action: "delete", recordId: selected.recordId, expectedVersion: selected.version });
      if (!live.current) return;
      setSelected(null); setDeleting(false); setMessage(zh ? "凭据已删除。" : "Credential deleted."); await refreshList();
    } catch (failure) {
      if (live.current) {
        if (credentialErrorCode(failure) === "credential_host_unavailable") hostUnavailable();
        else setError(credentialError(failure, language));
      }
    }
    finally { if (live.current) setPending(false); }
  }
  async function useRecord(record: CredentialRecord) {
    if (!status || status.locked) return;
    const token = generation.current;
    try {
      const detail = await transport.request({ action: "detail", recordId: record.recordId });
      if (!live.current || token !== generation.current) return;
      await copyText(credentialUsage(status.vaultId, detail));
      if (live.current && token === generation.current) setMessage(zh ? "已复制使用指令，可粘贴给 Agent。" : "Usage instructions copied. Paste them into your Agent.");
    } catch (failure) {
      if (live.current && token === generation.current) {
        if (credentialErrorCode(failure) === "credential_host_unavailable") hostUnavailable();
        else setError(zh ? "未能复制使用指令，请检查凭据状态后重试。" : "Could not copy usage instructions. Check the credential and retry.");
      }
    }
  }
  const ready = Boolean(status && !status.locked);
  return <section className={`credentials-view ${compact ? "credential-compact" : ""}`} data-theme={theme} aria-label={zh ? "凭据库" : "Credential vault"}>
    <div className="credential-toolbar">
      <Button onClick={createRecord} disabled={!ready || pending}><Plus size={15} />{zh ? "新增凭据" : "New credential"}</Button>
      <label className="credential-search"><Search size={15} /><input type="search" maxLength={512} aria-label={zh ? "搜索凭据" : "Search credentials"} disabled={!ready}
        placeholder={zh ? "搜索名称、网址、账号或备注…" : "Search name, address, account or notes…"} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <select aria-label={zh ? "筛选凭据类型" : "Credential type filter"} disabled={!ready} value={type} onChange={(event) => setType(event.target.value)}><option value="">{zh ? "全部类型" : "All types"}</option>{CREDENTIAL_TYPES.map((kind) => <option key={kind} value={kind}>{credentialTypeLabel(kind, language)}</option>)}</select>
      <span className="credential-spacer" /><Button onClick={() => setHelp(true)}><BookOpenText size={15} />{zh ? "Agent 接入说明" : "Agent guide"}</Button>
      <Button onClick={onOpenSettings}><Settings2 size={15} />{zh ? "凭据设置" : "Vault settings"}</Button><Button onClick={() => void lock()} disabled={!ready || pending}><LockKeyhole size={15} />{zh ? "锁定" : "Lock"}</Button>
    </div>
    {demo && <p className="credential-demo-notice">{zh ? "浏览器演示：仅内存数据，不保存到加密库，不复制秘密到系统剪贴板。请勿输入真实凭据。" : "Browser demo: memory only; no encrypted persistence or secret clipboard writes. Do not enter real credentials."}</p>}
    {message && <div className="credential-message" role="status">{message}</div>}
    {status?.clipboard?.error && <p className="credential-error credential-page-error" role="alert">{zh ? "未能确认本次剪贴板清理完成，请自行检查。" : "Clipboard cleanup could not be confirmed. Please check it manually."}</p>}
    {ready ? <><div className="credential-results"><span>{zh ? `找到 ${records.length} 条凭据` : `${records.length} credentials`}{loading ? (zh ? " · 加载中…" : " · Loading…") : ""}</span><span>{status?.sharing ? (zh ? "Agent 访问已开启" : "Agent access enabled") : (zh ? "Agent 访问已关闭" : "Agent access disabled")}</span></div>
      {error && <p className="credential-error credential-page-error" role="alert">{error}</p>}
      <div className="credential-content">{records.length ? <div className="credential-grid">{records.map((record) => <article className={`credential-card ${selected?.recordId === record.recordId ? "selected" : ""}`} key={record.recordId}>
        <div className="credential-card-heading"><KeyRound size={17} /><h2><button type="button" onClick={() => void openRecord(record)}>{record.name}</button></h2></div>
        <span className="credential-tag">{credentialTypeLabel(record.type, language)}</span><div className="credential-card-locator"><span title={credentialLocation(record)}>{credentialLocation(record)}</span><span>{record.metadata.username || record.files[0]?.name || (zh ? "秘密内容已隐藏" : "Secrets hidden")}</span>{record.metadata.database && <span>{record.metadata.database}</span>}</div>
        <footer><time>{record.updatedAt.slice(0, 10)}</time><Button onClick={() => void useRecord(record)}><Copy size={13} />{zh ? "使用" : "Use"}</Button></footer>
      </article>)}</div> : <div className="credential-empty"><KeyRound size={32} /><h2>{query || type ? (zh ? "没有匹配的凭据" : "No matching credentials") : (zh ? "还没有凭据" : "No credentials yet")}</h2><p>{zh ? "保存账号密码，或导入私钥和证书文件。" : "Save accounts and passwords, or import keys and certificates."}</p><Button onClick={query || type ? () => { setQuery(""); setType(""); } : createRecord}>{query || type ? (zh ? "清除筛选" : "Clear filters") : (zh ? "新增凭据" : "New credential")}</Button></div>}</div>
    </> : <div className="credential-locked-area"><div className="credential-locked-card"><LockKeyhole size={30} /><h1>{!status ? (zh ? "正在读取凭据库状态" : "Checking the vault") : status.exists ? (zh ? "凭据库已锁定" : "Vault locked") : (zh ? "创建你的凭据库" : "Create your vault")}</h1>
      {status && <><p>{status.exists ? (zh ? "输入主密码后继续使用。已有 Agent 授权保留。" : "Enter your master password. Existing Agent authorization is retained.") : (zh ? "统一保存账号、密码、私钥和证书。" : "Keep accounts, passwords, keys and certificates together.")}</p>
        <form onSubmit={(event) => { event.preventDefault(); void unlock(); }}><label className="credential-field"><span>{zh ? "主密码" : "Master password"}</span><input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {!status.exists && <label className="credential-field"><span>{zh ? "再次输入主密码" : "Confirm master password"}</span><input type="password" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>}
          {!status.exists && <p className="credential-hint">{zh ? "至少 12 个字符，最多 1024 个 UTF-8 字节。主密码无法找回，请妥善记忆。" : "At least 12 characters; at most 1024 UTF-8 bytes. The master password cannot be recovered."}</p>}
          <Button variant="primary" type="submit" pending={pending}>{status.exists ? (zh ? "解锁凭据库" : "Unlock vault") : (zh ? "创建并解锁" : "Create and unlock")}</Button>
          {pending && <Button onClick={() => void lock()}>{zh ? "取消" : "Cancel"}</Button>}
        </form><p className="credential-hint">{zh ? "当前版本暂不支持从加密备份恢复。" : "Encrypted backup restore is not yet supported in this version."}</p></>}
      {error && <p className="credential-error" role="alert">{error}</p>}{!status && error && <Button onClick={() => void refreshStatus()}>{zh ? "重试" : "Retry"}</Button>}
    </div></div>}
    {ready && editing && <CredentialEditor key={selected?.recordId ?? "new"} record={selected} language={language} onSave={save} onClose={closeDetail} onDirtyChange={changeDirty} />}
    {ready && selected && !editing && <CredentialDetail key={`${selected.recordId}:${selected.version}`} record={selected} transport={transport} language={language} onClose={closeDetail} onEdit={() => setEditing(true)} onDelete={() => setDeleting(true)} onMessage={setMessage} onSecretCopied={checkClipboardLater} onUnavailable={hostUnavailable} />}
    {deleting && selected && <Modal title={zh ? "删除凭据" : "Delete credential"} closeLabel={zh ? "关闭" : "Close"} onClose={() => { if (!pending) setDeleting(false); }}
      footer={<><Button onClick={() => setDeleting(false)} disabled={pending}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" pending={pending} onClick={() => void remove()}>{zh ? "删除" : "Delete"}</Button></>}>
      <p>{zh ? `删除「${selected.name}」（${credentialTypeLabel(selected.type, language)}）及库内文件？已经导出或交给 Agent 的内容不会被撤回。` : `Delete “${selected.name}” and its stored files? Previously exported or delivered content cannot be recalled.`}</p>{error && <p className="credential-error" role="alert">{error}</p>}
    </Modal>}
    {help && <Modal title={zh ? "Agent 接入说明" : "Agent connection guide"} closeLabel={zh ? "关闭" : "Close"} onClose={() => setHelp(false)}
      footer={<><Button onClick={() => setHelp(false)}>{zh ? "关闭" : "Close"}</Button><Button disabled>{zh ? "复制说明给 Agent" : "Copy guide for Agent"}</Button></>}>
      <label className="credential-field"><span>Agent</span><select value={client} onChange={(event) => setClient(event.target.value)}>{["Codex", "Claude Code", "WorkBuddy", "DeepSeek Harness", "通用 MCP"].map((name) => <option key={name}>{name}</option>)}</select></label>
      <p>{zh ? `当前版本暂不支持生成 ${client} 的客户端接入配置，不能复制可执行配置。` : `This version cannot yet generate client configuration for ${client}. Executable configuration is not ready to copy.`}</p>
      <p className="credential-hint">{zh ? "请勿把主密码或访问码粘贴给 Agent。日常使用可复制卡片的记录定位指令；复制不代表客户端已连接。" : "Never paste the master password or access code into an Agent. Card instructions identify individual records; copying them does not connect a client."}</p>
    </Modal>}
  </section>;
}
