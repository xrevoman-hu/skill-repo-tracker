import type {
  CredentialRecord, CredentialRequest, CredentialResults, CredentialSession, CredentialStatus, CredentialTransport,
} from "./credentialTypes";
import { newCredentialSessionId } from "./credentialTypes";

/** Browser-only in-memory preview. It never writes secrets to the OS clipboard. */
export class DemoCredentialTransport implements CredentialTransport {
  private state: CredentialStatus = {
    exists: false, locked: true, vaultId: "demo-vault", sharing: false,
    sharingRequested: false, authorizationError: null, cleanupFailed: false,
  };
  private password = "";
  private records = new Map<string, CredentialRecord>();
  private values = new Map<string, Record<string, string>>();
  private sessions = new Map<string, CredentialSession>();
  private invalidated = new Set<string>();

  async request<R extends CredentialRequest>(request: R): Promise<CredentialResults[R["action"]]> {
    const result = this.dispatch(request);
    return JSON.parse(JSON.stringify(result)) as CredentialResults[R["action"]];
  }

  private fail(code: string): never { throw { code }; }
  private unlocked() { if (this.state.locked) this.fail("vault_locked"); }
  private record(id: string, version?: number): CredentialRecord {
    const record = this.records.get(id);
    if (!record) this.fail("record_not_found");
    if (version !== undefined && record.version !== version) this.fail("record_conflict");
    return record;
  }
  private verified(request: CredentialSession) {
    this.unlocked();
    this.record(request.recordId, request.expectedVersion);
    const session = this.sessions.get(request.sessionId);
    if (!session || session.recordId !== request.recordId || session.expectedVersion !== request.expectedVersion) {
      this.fail("session_invalid");
    }
  }
  private dispatch(request: CredentialRequest): unknown {
    if (request.action === "status") return this.state;
    if (request.action === "agent_guide") return {
      client: request.client, text: "浏览器演示：不能复制可执行配置。正式桌面版会生成本机 bridge 路径与所选 Agent 配置，且不含主密码或访问码。",
      ready: false, reason: "demo_native_only", serverName: "",
    };
    if (["prepare_export", "export_file", "inspect_files", "backup_create", "restore_pick", "restore_preview", "restore_commit"].includes(request.action)) this.fail("demo_native_only");
    if (request.action === "restore_cancel" || request.action === "retry_cleanup") return this.state;
    if (request.action === "invalidate_session") {
      this.invalidated.add(request.sessionId);
      this.sessions.delete(request.sessionId);
      return { invalidated: true };
    }
    if (request.action === "lock") {
      this.sessions.clear();
      this.state = { ...this.state, locked: true, sharing: false };
      return this.state;
    }
    if (request.action === "create") {
      if (this.state.exists) this.fail("vault_exists");
      if ([...request.password].length < 12 || new TextEncoder().encode(request.password).length > 1024) this.fail("password_length_invalid");
      if (request.password !== request.confirmPassword) this.fail("password_confirmation_mismatch");
      this.password = request.password;
      this.state = { ...this.state, exists: true, locked: false };
      return this.state;
    }
    if (request.action === "unlock") {
      if (!this.state.exists || this.password !== request.password) this.fail("vault_verification_failed");
      this.state = { ...this.state, locked: false, sharing: this.state.sharingRequested };
      return this.state;
    }
    this.unlocked();
    if (request.action === "change_password") {
      if (this.password !== request.oldPassword) this.fail("vault_verification_failed");
      if ([...request.newPassword].length < 12 || new TextEncoder().encode(request.newPassword).length > 1024) this.fail("password_length_invalid");
      if (request.newPassword !== request.confirmPassword) this.fail("password_confirmation_mismatch");
      this.password = request.newPassword;
      this.sessions.clear();
      this.state = { ...this.state, locked: true, sharing: false };
      return this.state;
    }
    if (request.action === "share") {
      this.state = { ...this.state, sharing: request.enabled, sharingRequested: request.enabled };
      return this.state;
    }
    if (request.action === "reset_access" || request.action === "authorize_access") return this.state;
    if (request.action === "list") {
      const query = (request.query ?? "").toLocaleLowerCase();
      return { records: [...this.records.values()].filter((record) => (
        (!request.type || record.type === request.type)
        && [record.name, record.note, ...Object.values(record.metadata)].join(" ").toLocaleLowerCase().includes(query)
      )) };
    }
    if (request.action === "detail") return this.record(request.recordId);
    if (request.action === "delete") {
      this.record(request.recordId, request.expectedVersion);
      this.records.delete(request.recordId);
      this.values.delete(request.recordId);
      return { deleted: true };
    }
    if (request.action === "save") {
      const old = request.recordId ? this.record(request.recordId, request.expectedVersion) : undefined;
      const recordId = old?.recordId ?? newCredentialSessionId();
      const secrets = new Map(Object.entries(this.values.get(recordId) ?? {}));
      const files = new Map((old?.files ?? []).map((file) => [file.field, file]));
      for (const [field, value] of Object.entries(request.secrets)) {
        if (request.type === "generic" && field === "attachment" && value !== null) this.fail("record_files_invalid");
        if (value === null) secrets.delete(field);
        else secrets.set(field, value);
        files.delete(field);
      }
      for (const file of request.files ?? []) {
        const bytes = Uint8Array.from(atob(file.bytesBase64), (character) => character.charCodeAt(0));
        let textReadable = true;
        try { secrets.set(file.field, new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { textReadable = false; secrets.delete(file.field); }
        files.set(file.field, { field: file.field, name: file.name, size: bytes.length, textReadable });
      }
      const record: CredentialRecord = {
        recordId, type: request.type, name: request.name, metadata: request.metadata,
        note: request.note, version: (old?.version ?? 0) + 1, updatedAt: new Date().toISOString(),
        secretFields: [...new Set([...secrets.entries()].filter(([, value]) => value !== "").map(([field]) => field).concat([...files.keys()]))], files: [...files.values()],
      };
      this.values.set(recordId, Object.fromEntries(secrets));
      this.records.set(recordId, record);
      return record;
    }
    if (request.action === "verify") {
      this.record(request.recordId, request.expectedVersion);
      if (this.invalidated.has(request.sessionId)) this.fail("session_invalidated");
      if (this.password !== request.password) this.fail("vault_verification_failed");
      this.sessions.set(request.sessionId, request);
      return { verified: true };
    }
    if (request.action === "read_fields" || request.action === "copy_secret") {
      this.verified(request);
      const fields = request.action === "copy_secret" ? [request.field] : request.fields;
      const values = this.values.get(request.recordId) ?? {};
      for (const field of fields) if (!(field in values)) this.fail("file_not_text");
      if (request.action === "copy_secret") return { copied: true, simulated: true, cleanupAfterSeconds: 30 };
      return { recordId: request.recordId, fields: Object.fromEntries(fields.map((field) => [field, values[field]])) };
    }
    this.fail("invalid_request");
  }
}
