import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "./UiPrimitives";
import { CREDENTIAL_LIMITS, CREDENTIAL_TYPES, credentialError } from "./credentialTypes";
import type { CredentialFileInput, CredentialRecord, CredentialSave, CredentialType } from "./credentialTypes";
import {
  credentialFileInput, credentialFileLabel, credentialLabel, credentialTypeLabel, FILE_FIELDS, METADATA_FIELDS, REQUIRED_METADATA,
  SECRET_FIELDS, validateCredential,
} from "./credentialForm";

type Props = {
  record: CredentialRecord | null;
  language: string;
  onSave: (input: CredentialSave) => Promise<void>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
};
export function CredentialEditor({ record, language, onSave, onClose, onDirtyChange }: Props) {
  const zh = language === "zh";
  const [type, setType] = useState<CredentialType>(record?.type ?? "website");
  const [name, setName] = useState(record?.name ?? "");
  const [metadata, setMetadata] = useState<Record<string, string>>({ ...record?.metadata });
  const [otherEngine, setOtherEngine] = useState(Boolean(record?.metadata.engine && !["MySQL", "PostgreSQL"].includes(record.metadata.engine)));
  const [note, setNote] = useState(record?.note ?? "");
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [files, setFiles] = useState<CredentialFileInput[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const fileGeneration = useRef(0);
  useEffect(() => () => { fileGeneration.current += 1; }, []);
  const dirty = () => onDirtyChange(true);

  async function chooseFile(field: string, file?: File) {
    if (!file) return;
    const generation = ++fileGeneration.current;
    setReading(true);
    setFailure("");
    try {
      const input = await credentialFileInput(field, file);
      if (generation !== fileGeneration.current) return;
      const next = [...files.filter((item) => item.field !== field), input];
      const bytes = next.reduce((sum, item) => sum + atob(item.bytesBase64).length, 0);
      if (bytes > CREDENTIAL_LIMITS.fileBytes) throw { code: "credential_file_size" };
      setFiles(next);
      setSecrets((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== field)));
      dirty();
    } catch {
      if (generation === fileGeneration.current) setFailure(zh ? "未能读取文件。文件不能为空；本次附件合计最多 16 MiB。" : "Could not read the file. Files must be non-empty; combined attachments may not exceed 16 MiB.");
    } finally { if (generation === fileGeneration.current) setReading(false); }
  }
  async function save() {
    const input: CredentialSave = {
      action: "save", recordId: record?.recordId, expectedVersion: record?.version,
      type, name, metadata, note, secrets: Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== "")), files,
    };
    const validation = validateCredential(input, record, language);
    setErrors(validation);
    if (Object.keys(validation).length) return;
    setPending(true);
    setFailure("");
    try { await onSave(input); }
    catch (error) { setFailure(credentialError(error, language)); }
    finally { setPending(false); }
  }
  function changeSecret(field: string, value: string) {
    fileGeneration.current += 1;
    setReading(false);
    setSecrets({ ...secrets, [field]: value });
    if (value !== "") setFiles((current) => current.filter((file) => file.field !== field));
    dirty();
  }
  function metadataField(field: string) {
    const optionalMail = ["imapHost", "imapPort", "smtpHost", "smtpPort"].includes(field);
    if (optionalMail) return null;
    return <label className="credential-field" key={field}>
      <span>{credentialLabel(field, language)}{REQUIRED_METADATA[type].includes(field) ? " *" : ""}</span>
      {field === "engine" ? <>
        <select value={otherEngine ? "other" : metadata.engine ?? ""} onChange={(event) => {
          setOtherEngine(event.target.value === "other"); setMetadata({ ...metadata, engine: event.target.value === "other" ? "" : event.target.value }); dirty();
        }}><option value="">{zh ? "选择引擎" : "Choose an engine"}</option><option>MySQL</option><option>PostgreSQL</option><option value="other">{zh ? "其他" : "Other"}</option></select>
        {otherEngine && <input aria-label={zh ? "其他数据库引擎" : "Other database engine"} value={metadata.engine ?? ""} onChange={(event) => { setMetadata({ ...metadata, engine: event.target.value }); dirty(); }} />}
      </> : field === "passwordKind" ? <select value={metadata[field] ?? "normal"} onChange={(event) => { setMetadata({ ...metadata, [field]: event.target.value }); dirty(); }}>
        <option value="normal">{zh ? "普通密码" : "Password"}</option><option value="application">{zh ? "应用专用密码" : "App password"}</option>
      </select> : <input value={metadata[field] ?? ""} aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? `credential-error-${field}` : undefined}
        onChange={(event) => { setMetadata({ ...metadata, [field]: event.target.value }); dirty(); }} autoComplete="off" />}
      {errors[field] && <small id={`credential-error-${field}`} className="credential-error">{errors[field]}</small>}
    </label>;
  }
  return <aside className="credential-drawer" role="dialog" aria-label={zh ? "编辑凭据" : "Credential editor"}>
    <header><h2>{record ? (zh ? "编辑凭据" : "Edit credential") : (zh ? "新增凭据" : "New credential")}</h2>
      <button className="credential-icon-button" type="button" aria-label={zh ? "关闭编辑" : "Close editor"} disabled={pending} onClick={onClose}><X size={18} /></button>
    </header>
    <form className="credential-editor" onSubmit={(event) => { event.preventDefault(); if (!pending && !reading) void save(); }}>
      <div className="credential-drawer-scroll">
        <label className="credential-field"><span>{zh ? "类型" : "Type"}</span><select value={type} disabled={Boolean(record) || pending}
          onChange={(event) => { setType(event.target.value as CredentialType); setMetadata({}); setOtherEngine(false); setSecrets({}); setFiles([]); setErrors({}); fileGeneration.current += 1; setReading(false); dirty(); }}>
          {CREDENTIAL_TYPES.map((kind) => <option value={kind} key={kind}>{credentialTypeLabel(kind, language)}</option>)}
        </select></label>
        <label className="credential-field"><span>{zh ? "名称 *" : "Name *"}</span><input value={name} autoFocus aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "credential-error-name" : undefined} onChange={(event) => { setName(event.target.value); dirty(); }} />
          {errors.name && <small id="credential-error-name" className="credential-error">{errors.name}</small>}
        </label>
        {METADATA_FIELDS[type].map(metadataField)}
        {type === "email" && <details className="credential-mail-options"><summary>{zh ? "服务器信息（可选）" : "Server details (optional)"}</summary>
          {["imapHost", "imapPort", "smtpHost", "smtpPort"].map((field) => <label key={field} className="credential-field"><span>{credentialLabel(field, language)}</span>
            <input value={metadata[field] ?? ""} onChange={(event) => { setMetadata({ ...metadata, [field]: event.target.value }); dirty(); }} />
            {errors[field] && <small className="credential-error">{errors[field]}</small>}
          </label>)}
        </details>}
        {SECRET_FIELDS[type].map((field) => <label className="credential-field" key={field}>
          <span>{credentialLabel(field, language)}{field === "passphrase" ? (zh ? "（可选）" : " (optional)") : ""}</span>
          {["password", "passphrase", "token"].includes(field)
            ? <input type="password" autoComplete="off" value={secrets[field] ?? ""} disabled={secrets[field] === null}
              aria-invalid={Boolean(errors[field])} onChange={(event) => changeSecret(field, event.target.value)}
              placeholder={record ? (zh ? "留空保留已保存值" : "Leave blank to keep the saved value") : ""} />
            : <textarea rows={4} autoComplete="off" value={secrets[field] ?? ""} disabled={secrets[field] === null}
              aria-invalid={Boolean(errors[field])} onChange={(event) => changeSecret(field, event.target.value)}
              placeholder={record ? (zh ? "留空保留已保存值" : "Leave blank to keep the saved value") : ""} />}
          {record?.secretFields.includes(field) && ["passphrase", "certificate", "privateKey", "chain", "value"].includes(field) && <span className="credential-clear-secret">
            <input type="checkbox" checked={secrets[field] === null} onChange={(event) => { setSecrets({ ...secrets, [field]: event.target.checked ? null : "" }); dirty(); }} />
            {zh ? "清除已保存值" : "Clear the saved value"}
          </span>}
          {errors[field] && <small className="credential-error">{errors[field]}</small>}
        </label>)}
        {(FILE_FIELDS[type] ?? []).map((field) => <label className="credential-field credential-file-input" key={field}>
          <span>{credentialFileLabel(field, language)}</span>
          <small>{secrets[field] === null ? (zh ? "保存后移除现有文件" : "Existing file will be removed on save") : secrets[field] ? (zh ? "保存后以文本替换现有文件" : "Text will replace the existing file on save") : files.find((file) => file.field === field)?.name ?? record?.files.find((file) => file.field === field)?.name ?? (zh ? "导入文件本体，不依赖原文件路径" : "Import the file itself, independent of its source path")}</small>
          <input type="file" aria-label={credentialFileLabel(field, language)} disabled={reading || pending}
            onChange={(event) => { void chooseFile(field, event.target.files?.[0]); event.target.value = ""; }} />
          {type === "generic" && record?.files.some((file) => file.field === field) && <Button onClick={() => {
            setFiles((current) => current.filter((file) => file.field !== field)); setSecrets({ ...secrets, [field]: secrets[field] === null ? "" : null }); dirty();
          }}>{secrets[field] === null ? (zh ? "保留已保存文件" : "Keep saved file") : (zh ? "移除已保存文件" : "Remove saved file")}</Button>}
          {errors[field] && <small className="credential-error">{errors[field]}</small>}
        </label>)}
        {record && <p className="credential-hint">{zh ? "旧秘密不会预填。查看或复制请返回详情验证主密码。" : "Saved secrets are not prefilled. Return to details and verify to view or copy them."}</p>}
        <p className="credential-hint">{zh ? "秘密文本最多 1 MiB；本次文件合计最多 16 MiB。保存不连接目标服务。" : "Secret text: 1 MiB maximum. Combined files: 16 MiB maximum. Saving does not connect to the target service."}</p>
        {type === "tls" && <p className="credential-hint">{zh ? "证书与私钥独立保管，配对和有效期尚未验证。" : "Certificate and key are stored separately; pairing and expiry are unverified."}</p>}
        {type === "tls" && <p className="credential-hint">{zh ? "同一证书或私钥可输入文本或选择文件；新输入会替换该项原来的保存形式。" : "For each certificate or key, enter text or choose a file. New input replaces the previous form of that item."}</p>}
        <label className="credential-field"><span>{zh ? "备注" : "Notes"}</span><textarea rows={3} value={note} onChange={(event) => { setNote(event.target.value); dirty(); }} /></label>
        {failure && <p className="credential-error" role="alert">{failure}</p>}
      </div>
      <footer><Button onClick={onClose} disabled={pending}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" type="submit" pending={pending || reading} pendingLabel={reading ? (zh ? "读取文件…" : "Reading…") : (zh ? "保存中…" : "Saving…")}>{zh ? "保存" : "Save"}</Button></footer>
    </form>
  </aside>;
}
