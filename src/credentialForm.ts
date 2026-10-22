import { CREDENTIAL_LIMITS } from "./credentialTypes";
import type { CredentialFileInput, CredentialRecord, CredentialSave, CredentialType } from "./credentialTypes";

export const CREDENTIAL_LABELS: Record<CredentialType, [string, string]> = {
  website: ["网站账号", "Website"], ssh: ["SSH 私钥", "SSH key"], tls: ["SSL / TLS", "SSL / TLS"],
  database_instance: ["数据库实例账号", "Database instance"], database_user: ["数据库用户", "Database user"],
  email: ["邮箱账号", "Email"], api_token: ["API Token", "API token"], generic: ["通用秘密", "Secret"],
};
export const FIELD_LABELS: Record<string, [string, string]> = {
  url: ["网址", "Website URL"], host: ["主机", "Host"], port: ["端口", "Port"],
  username: ["账号 / 用户名", "Account / username"], database: ["数据库名", "Database name"],
  engine: ["数据库引擎", "Database engine"], email: ["邮箱地址", "Email address"],
  service: ["服务地址", "Service URL"], purpose: ["用途", "Purpose"], domain: ["域名", "Domain"],
  passwordKind: ["密码用途", "Password type"], imapHost: ["IMAP 主机", "IMAP host"], imapPort: ["IMAP 端口", "IMAP port"],
  smtpHost: ["SMTP 主机", "SMTP host"], smtpPort: ["SMTP 端口", "SMTP port"],
  password: ["密码", "Password"], passphrase: ["私钥口令", "Key passphrase"], token: ["Token", "Token"],
  value: ["秘密内容", "Secret content"], certificate: ["证书原文", "Certificate"],
  privateKey: ["私钥原文", "Private key"], chain: ["证书链", "Certificate chain"],
  attachment: ["秘密附件原文", "Secret attachment content"],
};
export const METADATA_FIELDS: Record<CredentialType, string[]> = {
  website: ["url", "username"], ssh: ["host", "port", "username"], tls: ["domain"],
  database_instance: ["engine", "host", "port", "username", "database"],
  database_user: ["engine", "host", "port", "database", "username"],
  email: ["email", "username", "passwordKind", "imapHost", "imapPort", "smtpHost", "smtpPort"],
  api_token: ["service", "purpose"], generic: ["purpose"],
};
export const SECRET_FIELDS: Record<CredentialType, string[]> = {
  website: ["password"], ssh: ["passphrase"], tls: ["certificate", "privateKey", "chain", "passphrase"],
  database_instance: ["password"], database_user: ["password"], email: ["password"], api_token: ["token"], generic: ["value"],
};
export const FILE_FIELDS: Partial<Record<CredentialType, string[]>> = {
  ssh: ["privateKey"], tls: ["certificate", "privateKey", "chain"], generic: ["attachment"],
};
export const REQUIRED_METADATA: Record<CredentialType, string[]> = {
  website: ["url", "username"], ssh: [], tls: [], database_instance: ["engine", "host", "port", "username"],
  database_user: ["engine", "host", "port", "username", "database"], email: ["email", "username"], api_token: [], generic: [],
};
export function credentialLabel(key: string, language: string) {
  return FIELD_LABELS[key]?.[language === "zh" ? 0 : 1] ?? key;
}
export function credentialTypeLabel(type: CredentialType, language: string) {
  return CREDENTIAL_LABELS[type][language === "zh" ? 0 : 1];
}
export function credentialFileLabel(field: string, language: string) {
  const labels: Record<string, [string, string]> = {
    privateKey: ["私钥文件", "Private key file"], certificate: ["证书文件", "Certificate file"],
    chain: ["证书链文件", "Certificate chain file"], attachment: ["秘密文件", "Secret file"],
  };
  return labels[field]?.[language === "zh" ? 0 : 1] ?? credentialLabel(field, language);
}
export function credentialLocation(record: CredentialRecord) {
  return record.metadata.url || record.metadata.host || record.metadata.email || record.metadata.domain || record.metadata.service || record.metadata.purpose || "—";
}
export function validateCredential(input: CredentialSave, original: CredentialRecord | null, language: string): Record<string, string> {
  const errors = new Map<string, string>();
  const text = (zh: string, en: string) => language === "zh" ? zh : en;
  if (!input.name.trim()) errors.set("name", text("请输入名称。", "Enter a name."));
  for (const key of REQUIRED_METADATA[input.type]) {
    if (!input.metadata[key]?.trim()) errors.set(key, text("此项为必填。", "This field is required."));
  }
  for (const key of ["port", "imapPort", "smtpPort"]) {
    const port = input.metadata[key];
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) errors.set(key, text("端口须为 1–65535 的整数。", "Use an integer from 1 to 65535."));
  }
  if (input.type === "website" && input.metadata.url) {
    try {
      const url = new URL(input.metadata.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { errors.set("url", text("请输入不含账号密码的 HTTP / HTTPS 网址。", "Enter an HTTP / HTTPS URL without credentials.")); }
  }
  if (input.metadata.host && /[\s/@?#]/.test(input.metadata.host)) {
    errors.set("host", text("请输入主机名或 IP，不使用连接串。", "Enter a hostname or IP, not a connection string."));
  }
  const has = (key: string) => input.secrets[key] !== undefined
    ? Boolean(input.secrets[key])
    : Boolean(original?.secretFields.includes(key) || original?.files.some((file) => file.field === key) || input.files?.some((file) => file.field === key));
  const required = ["website", "database_instance", "database_user", "email"].includes(input.type)
    ? "password" : input.type === "api_token" ? "token" : "";
  if (required && !has(required)) errors.set(required, text("请填写秘密值。", "Enter the secret value."));
  if (input.type === "ssh" && !input.files?.some((file) => file.field === "privateKey") && !original?.files.some((file) => file.field === "privateKey")) errors.set("privateKey", text("请选择私钥文件。", "Choose a private key file."));
  if (input.type === "tls" && !has("certificate") && !has("privateKey")) errors.set("certificate", text("至少保存一份证书或私钥。", "Add a certificate or private key."));
  if (input.type === "generic" && !has("value") && !has("attachment")) errors.set("value", text("请填写秘密文本或选择文件。", "Enter secret text or choose a file."));
  for (const [key, value] of Object.entries(input.secrets)) {
    if (value && new TextEncoder().encode(value).length > CREDENTIAL_LIMITS.secretBytes) errors.set(key, text("秘密文本不能超过 1 MiB。", "Secret text cannot exceed 1 MiB."));
  }
  return Object.fromEntries(errors);
}
export async function credentialFileInput(field: string, file: File): Promise<CredentialFileInput> {
  if (!file.size || file.size > CREDENTIAL_LIMITS.fileBytes) throw { code: "credential_file_size" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return { field, name: file.name, bytesBase64: btoa(binary) };
}
