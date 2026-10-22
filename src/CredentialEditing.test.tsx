import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialEditor } from "./CredentialEditor";
import { credentialFileInput, validateCredential } from "./credentialForm";
import { CREDENTIAL_LIMITS } from "./credentialTypes";
import type { CredentialRecord, CredentialSave, CredentialType } from "./credentialTypes";

function record(type: CredentialType, extra: Partial<CredentialRecord> = {}): CredentialRecord {
  return { recordId: "editing-fixture", type, name: "Saved fixture", metadata: {}, note: "", version: 7,
    updatedAt: "2026-10-22", secretFields: [], files: [], ...extra };
}
function editor(original: CredentialRecord | null = null, language = "en", onSave = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  const onDirtyChange = vi.fn();
  const rendered = render(<CredentialEditor record={original} language={language} onSave={onSave}
    onClose={onClose} onDirtyChange={onDirtyChange} />);
  return { ...rendered, onSave, onClose, onDirtyChange };
}
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }); }
function file(name = "fixture.bin", bytes = new Uint8Array([255, 0, 1])) {
  const value = new File([bytes], name);
  Object.defineProperty(value, "arrayBuffer", { value: async () => bytes.slice().buffer, configurable: true });
  return value;
}
async function upload(label: string, value = file()) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { files: [value] } });
  await screen.findByText(value.name, { exact: true });
}
function submit() { fireEvent.click(screen.getByRole("button", { name: /^Save$/ })); }

describe("credential editing and validation", () => {
  it.each<CredentialType>(["website", "ssh", "tls", "database_instance", "database_user", "email", "api_token", "generic"])(
    "creates %s through its actual fields without prefilled secrets", async (type) => {
      const { onSave, onDirtyChange } = editor();
      fireEvent.change(screen.getByRole("combobox", { name: /^Type$/ }), { target: { value: type } });
      change("Name *", `Synthetic ${type}`);
      change("Notes", "Synthetic-only acceptance data");
      if (type === "website") { change("Website URL *", "https://example.test/account"); change("Account / username *", "test-user"); }
      if (type === "ssh") { change("Host", "ssh.example.test"); change("Port", "22"); change("Key passphrase (optional)", "synthetic-passphrase"); await upload("Private key file"); }
      if (type === "tls") { change("Domain", "example.test"); change("Certificate", "synthetic certificate text"); }
      if (type === "database_instance" || type === "database_user") {
        fireEvent.change(screen.getByRole("combobox", { name: "Database engine *" }), { target: { value: "MySQL" } });
        change("Host *", "db.example.test"); change("Port *", "3306"); change("Account / username *", "app-user");
        change(type === "database_user" ? "Database name *" : "Database name", "synthetic_db");
      }
      if (type === "email") { change("Email address *", "user@example.test"); change("Account / username *", "mail-user"); }
      if (["website", "database_instance", "database_user", "email"].includes(type)) change("Password", "synthetic-password");
      if (type === "api_token") { change("Service URL", "https://api.example.test"); change("Token", "synthetic-api-token"); }
      if (type === "generic") { change("Purpose", "test purpose"); change("Secret content", "synthetic text"); }
      submit();
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      const saved = onSave.mock.calls[0][0] as CredentialSave;
      expect(saved).toMatchObject({ type, name: `Synthetic ${type}`, note: "Synthetic-only acceptance data" });
      expect(saved.recordId).toBeUndefined();
      expect(onDirtyChange).toHaveBeenCalledWith(true);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      if (type === "ssh") expect(saved.files).toEqual([{ field: "privateKey", name: "fixture.bin", bytesBase64: "/wAB" }]);
    },
  );

  it.each([
    ["website", "请填写秘密值。"], ["ssh", "请选择私钥文件。"], ["tls", "至少保存一份证书或私钥。"],
    ["database_instance", "请填写秘密值。"], ["database_user", "请填写秘密值。"],
    ["email", "请填写秘密值。"], ["api_token", "请填写秘密值。"], ["generic", "请填写秘密文本或选择文件。"],
  ])("blocks incomplete %s records before requesting a save", async (type, reason) => {
    const { onSave } = editor(null, "zh");
    fireEvent.change(screen.getByRole("combobox", { name: /^类型$/ }), { target: { value: type } });
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    expect(screen.getByText("请输入名称。")).toBeInTheDocument();
    for (const message of screen.getAllByText(reason)) expect(message).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("edits a custom database engine and metadata while preserving the existing password", async () => {
    const original = record("database_user", { metadata: { engine: "Oracle", host: "db.example.test", port: "1521", username: "app", database: "sample" }, secretFields: ["password"] });
    const { onSave } = editor(original);
    expect(screen.getByRole("combobox", { name: "Type" })).toBeDisabled();
    expect(screen.getByLabelText("Other database engine")).toHaveValue("Oracle");
    change("Other database engine", "CustomDB");
    fireEvent.change(screen.getByRole("combobox", { name: /Database engine/ }), { target: { value: "PostgreSQL" } });
    expect(screen.queryByLabelText("Other database engine")).not.toBeInTheDocument();
    change("Account / username *", "new-user");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      recordId: original.recordId, expectedVersion: 7, secrets: {}, metadata: { ...original.metadata, username: "new-user", engine: "PostgreSQL" },
    })));
  });

  it("lets a new database record choose a custom engine and rejects its empty name", () => {
    const { onSave } = editor();
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "database_instance" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Database engine *" }), { target: { value: "other" } });
    change("Name *", "custom database"); change("Host *", "db.example.test"); change("Port *", "5432");
    change("Account / username *", "app"); change("Password", "synthetic");
    submit();
    expect(screen.getByText("This field is required.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    change("Other database engine", "CustomDB");
    submit();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ engine: "CustomDB" }) }));
  });

  it("validates optional mail server ports and stores the application-password choice", async () => {
    const { onSave } = editor();
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "email" } });
    change("Name *", "mail"); change("Email address *", "user@example.test"); change("Account / username *", "user");
    change("Password", "synthetic");
    fireEvent.change(screen.getByRole("combobox", { name: "Password type" }), { target: { value: "application" } });
    fireEvent.click(screen.getByText("Server details (optional)"));
    const imapPort = screen.getByLabelText("IMAP port", { exact: true });
    const smtpPort = screen.getByLabelText("SMTP port", { exact: true });
    change("IMAP host", "imap.example.test"); change("IMAP port", "0"); change("SMTP host", "smtp.example.test"); change("SMTP port", "65536");
    submit();
    expect(screen.getAllByText("Use an integer from 1 to 65535.")).toHaveLength(2);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(imapPort, { target: { value: "993" } });
    fireEvent.change(smtpPort, { target: { value: "465" } });
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ passwordKind: "application", imapPort: "993", smtpPort: "465" }) })));
  });

  it("switching credential type discards unsaved fields and attachments", async () => {
    const { onSave } = editor();
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "ssh" } });
    change("Name *", "changed type"); change("Host", "old.example.test"); change("Key passphrase (optional)", "old-secret");
    await upload("Private key file");
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "api_token" } });
    change("Token", "new-token"); submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: "api_token", metadata: {}, secrets: { token: "new-token" }, files: [] })));
  });

  it("replacing a TLS attachment with text submits only the chosen new representation", async () => {
    const original = record("tls", { secretFields: ["certificate", "privateKey"], files: [{ field: "certificate", name: "old.crt", size: 4, textReadable: true }] });
    const { onSave } = editor(original);
    expect(screen.getByText("old.crt")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /^Certificate(?:\s*Clear the saved value)?$/ }), { target: { value: "synthetic replacement" } });
    expect(screen.getByText("Text will replace the existing file on save")).toBeInTheDocument();
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ secrets: { certificate: "synthetic replacement" }, files: [] })));
  });

  it("choosing a TLS file replaces the unsaved text for that field while preserving other fields", async () => {
    const { onSave } = editor(record("tls", { secretFields: ["certificate", "privateKey"] }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Certificate(?:\s*Clear the saved value)?$/ }), { target: { value: "temporary text" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^Private key/ }), { target: { value: "synthetic private key text" } });
    await upload("Certificate file", file("new.crt", new Uint8Array([65, 66])));
    expect(screen.getByRole("textbox", { name: /^Certificate(?:\s*Clear the saved value)?$/ })).toHaveValue("");
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      secrets: { privateKey: "synthetic private key text" }, files: [{ field: "certificate", name: "new.crt", bytesBase64: "QUI=" }],
    })));
  });

  it("clears an optional saved TLS key explicitly and allows undo before saving", async () => {
    const { onSave } = editor(record("tls", { secretFields: ["certificate", "privateKey"] }));
    const key = screen.getByRole("textbox", { name: /^Private key/ });
    const field = within(key.closest("label")!);
    fireEvent.click(field.getByRole("checkbox"));
    expect(key).toBeDisabled();
    fireEvent.click(field.getByRole("checkbox"));
    expect(key).toBeEnabled();
    fireEvent.click(field.getByRole("checkbox"));
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ secrets: { privateKey: null } })));
  });

  it("removes and restores a generic saved file without fetching its contents", async () => {
    const { onSave } = editor(record("generic", { secretFields: ["value", "attachment"], files: [{ field: "attachment", name: "old.bin", size: 3, textReadable: false }] }));
    fireEvent.click(screen.getByRole("button", { name: "Remove saved file" }));
    expect(screen.getByText("Existing file will be removed on save")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep saved file" }));
    expect(screen.getByText("old.bin")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove saved file" }));
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ secrets: { attachment: null }, files: [] })));
  });

  it("clearing an uploaded replacement keeps other TLS attachments and undo restores the saved-file choice", async () => {
    const original = record("tls", { secretFields: ["certificate", "privateKey"], files: [{ field: "certificate", name: "original.crt", size: 3, textReadable: true }] });
    const { onSave } = editor(original);
    await upload("Certificate file", file("replacement.crt"));
    await upload("Certificate chain file", file("keep.chain"));
    const certificateField = within(screen.getByRole("textbox", { name: /^Certificate(?:\s*Clear the saved value)?$/ }).closest("label")!);
    fireEvent.click(certificateField.getByRole("checkbox"));
    expect(screen.queryByText("replacement.crt")).not.toBeInTheDocument();
    expect(screen.getByText("keep.chain")).toBeInTheDocument();
    fireEvent.click(certificateField.getByRole("checkbox"));
    expect(screen.getByText("original.crt")).toBeInTheDocument();
    fireEvent.click(certificateField.getByRole("checkbox"));
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      secrets: { certificate: null }, files: [{ field: "chain", name: "keep.chain", bytesBase64: "/wAB" }],
    })));
  });

  it.each(["certificate", "chain"])("clearing a saved certificate cancels only its own in-flight read (%s)", async (field) => {
    let finish!: (bytes: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
    const value = file("late-replacement.bin");
    Object.defineProperty(value, "arrayBuffer", { value: () => pending, configurable: true });
    const { onSave } = editor(record("tls", { secretFields: ["certificate", "privateKey"] }));
    fireEvent.change(screen.getByLabelText(field === "certificate" ? "Certificate file" : "Certificate chain file", { exact: true }), { target: { files: [value] } });
    const certificateField = within(screen.getByRole("textbox", { name: /^Certificate(?:\s*Clear the saved value)?$/ }).closest("label")!);
    fireEvent.click(certificateField.getByRole("checkbox"));
    if (field === "chain") expect(screen.getByRole("button", { name: "Reading…" })).toBeDisabled();
    else expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();
    await act(async () => finish(new Uint8Array([255, 0, 1]).buffer));
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      secrets: { certificate: null },
      files: field === "certificate" ? [] : [{ field: "chain", name: "late-replacement.bin", bytesBase64: "/wAB" }],
    })));
  });

  it("removing a generic attachment prevents its pending replacement from returning", async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
    const value = file("late-attachment.bin");
    Object.defineProperty(value, "arrayBuffer", { value: () => pending, configurable: true });
    const { onSave } = editor(record("generic", { secretFields: ["value", "attachment"], files: [{ field: "attachment", name: "original.bin", size: 3, textReadable: false }] }));
    fireEvent.change(screen.getByLabelText("Secret file", { exact: true }), { target: { files: [value] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove saved file" }));
    await act(async () => finish(new Uint8Array([1, 2, 3]).buffer));
    expect(screen.queryByText("late-attachment.bin")).not.toBeInTheDocument();
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ secrets: { attachment: null }, files: [] })));
  });

  it.each(["en", "zh"])("keeps the draft after a save failure and permits a corrected retry (%s)", async (language) => {
    const onSave = vi.fn().mockRejectedValueOnce({ code: "record_conflict" }).mockResolvedValue(undefined);
    editor(record("generic", { secretFields: ["value"] }), language, onSave);
    fireEvent.change(screen.getByLabelText(language === "zh" ? "名称 *" : "Name *"), { target: { value: "Retained draft" } });
    const save = screen.getByRole("button", { name: language === "zh" ? /^保存$/ : /^Save$/ });
    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Retained draft")).toBeInTheDocument();
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });

  it.each(["en", "zh"])("rejects empty and oversized files with recoverable feedback (%s)", async (language) => {
    editor(record("ssh", { files: [{ field: "privateKey", name: "retained.key", size: 3, textReadable: false }], secretFields: ["privateKey"] }), language);
    const input = screen.getByLabelText(language === "zh" ? "私钥文件" : "Private key file", { exact: true });
    const oversized = file("oversized.key");
    Object.defineProperty(oversized, "size", { value: CREDENTIAL_LIMITS.fileBytes + 1 });
    for (const value of [new File([], "empty.key"), oversized]) {
      fireEvent.change(input, { target: { files: [value] } });
      expect(await screen.findByRole("alert")).toHaveTextContent(language === "zh" ? "文件不能为空" : "Files must be non-empty");
      expect(screen.getByText("retained.key")).toBeInTheDocument();
    }
    await upload(language === "zh" ? "私钥文件" : "Private key file", file("valid.key"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not attach a file whose read completes after changing type", async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
    const value = file("late.key");
    Object.defineProperty(value, "arrayBuffer", { value: () => pending, configurable: true });
    const { onSave } = editor();
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "ssh" } });
    change("Name *", "late-read fixture");
    fireEvent.change(screen.getByLabelText("Private key file"), { target: { files: [value] } });
    expect(screen.getByRole("button", { name: "Reading…" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "generic" } });
    change("Secret content", "new type content");
    await act(async () => finish(new Uint8Array([1, 2, 3]).buffer));
    expect(screen.queryByText("late.key")).not.toBeInTheDocument();
    submit();
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: "generic", files: [], secrets: { value: "new type content" } })));
  });

  it("reads binary files losslessly across the byte-encoding chunk boundary", async () => {
    const bytes = Uint8Array.from({ length: 8200 }, (_, index) => index % 256);
    const imported = await credentialFileInput("attachment", file("binary-fixture.bin", bytes));
    expect(imported.name).toBe("binary-fixture.bin");
    expect(Uint8Array.from(atob(imported.bytesBase64), (character) => character.charCodeAt(0))).toEqual(bytes);
  });

  it.each(["ftp://example.test", "not a URL", "https://user:secret@example.test"])("rejects unsafe website address %s", (url) => {
    const input: CredentialSave = { action: "save", type: "website", name: "fixture", metadata: { url, username: "test" }, note: "", secrets: { password: "synthetic" } };
    expect(validateCredential(input, null, "en").url).toBe("Enter an HTTP / HTTPS URL without credentials.");
  });

  it.each(["db.example.test/path", "db user", "user@host", "https://db.example.test"])("rejects a connection string instead of host: %s", (host) => {
    const input: CredentialSave = { action: "save", type: "database_instance", name: "fixture", metadata: { host, engine: "MySQL", port: "3306", username: "app" }, note: "", secrets: { password: "synthetic" } };
    expect(validateCredential(input, null, "zh").host).toBe("请输入主机名或 IP，不使用连接串。");
  });

  it("counts UTF-8 bytes for secret limits and accepts the exact boundary", () => {
    const input: CredentialSave = { action: "save", type: "generic", name: "fixture", metadata: {}, note: "", secrets: { value: "界".repeat(Math.floor(CREDENTIAL_LIMITS.secretBytes / 3)) + "x" } };
    expect(validateCredential(input, null, "en")).toEqual({});
    input.secrets.value += "x";
    expect(validateCredential(input, null, "en").value).toBe("Secret text cannot exceed 1 MiB.");
  });
});
