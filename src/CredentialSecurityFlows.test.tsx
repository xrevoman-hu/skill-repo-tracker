import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CredentialAgentGuide } from "./CredentialAgentGuide";
import { CredentialDetail } from "./CredentialDetail";
import { CredentialSettings } from "./CredentialSettings";
import type { CredentialFileInspection, CredentialRecord, CredentialRequest, CredentialResults, CredentialStatus, CredentialTransport } from "./credentialTypes";

const master = "synthetic-master-123";
const secret = "  synthetic secret\nwith original whitespace  ";
const record: CredentialRecord = {
  recordId: "synthetic-record", type: "website", name: "Synthetic account", version: 4,
  updatedAt: "2026-10-22T00:00:00Z", metadata: { username: "synthetic-user", url: "https://example.test", unused: "" },
  note: "Synthetic note", secretFields: ["password"], files: [],
};
const status = (patch: Partial<CredentialStatus> = {}): CredentialStatus => ({
  exists: true, locked: false, vaultId: "synthetic-vault", sharing: false, sharingRequested: false,
  authorizationError: null, cleanupFailed: false, ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transportFor(handler: (request: CredentialRequest) => unknown) {
  const calls: CredentialRequest[] = [];
  const transport: CredentialTransport = {
    request: async <R extends CredentialRequest>(request: R): Promise<CredentialResults[R["action"]]> => {
      calls.push(request);
      const result = handler(request);
      if (result !== undefined) return await result as CredentialResults[R["action"]];
      if (request.action === "invalidate_session") return { invalidated: true } as CredentialResults[R["action"]];
      if (request.action === "verify") return { verified: true } as CredentialResults[R["action"]];
      throw new Error(`Unexpected action: ${request.action}`);
    },
  };
  return { transport, calls };
}
function detail(transport: CredentialTransport, options: { value?: CredentialRecord; language?: string } = {}) {
  const callbacks = { onClose: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onMessage: vi.fn(), onSecretCopied: vi.fn(), onUnavailable: vi.fn() };
  return { ...render(<CredentialDetail record={options.value ?? record} transport={transport} language={options.language ?? "zh"} {...callbacks} />), ...callbacks };
}
async function authenticate(user: ReturnType<typeof userEvent.setup>, language = "zh") {
  await user.type(screen.getByLabelText(language === "zh" ? "主密码" : "Master password", { exact: true }), master);
  await user.click(screen.getByRole("button", { name: language === "zh" ? "验证并继续" : "Verify and continue" }));
}

describe("credential detail security boundaries", () => {
  it("keeps a rejected password inside verification and never requests secret fields", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => request.action === "verify" ? Promise.reject({ code: "vault_verification_failed" }) : undefined);
    detail(transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await authenticate(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("主密码不正确");
    expect(screen.getByRole("dialog", { name: "验证主密码" })).toBeInTheDocument();
    expect(calls.some((request) => request.action === "read_fields")).toBe(false);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByLabelText("主密码", { exact: true })).not.toBeInTheDocument();
    expect(calls.some((request) => request.action === "invalidate_session")).toBe(true);
  });

  it("cancels an in-flight verification without letting its late success reveal a value", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialResults["verify"]>();
    const { transport, calls } = transportFor((request) => request.action === "verify" ? pending.promise : undefined);
    detail(transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await authenticate(user);
    await user.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => pending.resolve({ verified: true }));
    expect(calls.some((request) => request.action === "read_fields")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "验证主密码" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByLabelText("主密码", { exact: true })).toHaveValue("");
  });

  it("drops a late read after blur and surfaces failed invalidation without exposing the value", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialResults["read_fields"]>();
    const { transport } = transportFor((request) => {
      if (request.action === "read_fields") return pending.promise;
      if (request.action === "invalidate_session") return Promise.reject({ code: "credential_host_unavailable" });
      return undefined;
    });
    const { container } = detail(transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await authenticate(user);
    fireEvent.blur(window);
    await act(async () => pending.resolve({ recordId: record.recordId, fields: { password: secret } }));
    expect(container.querySelector(".credential-secret-value")).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent("未能确认验证会话已结束，请锁定凭据库");
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByRole("dialog", { name: "验证主密码" })).toBeInTheDocument();
  });

  it("hides previously revealed data on a version conflict and requires verification again", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => {
      if (request.action === "read_fields") return { recordId: record.recordId, fields: { password: secret } };
      if (request.action === "copy_secret") return Promise.reject({ code: "record_version_conflict" });
      return undefined;
    });
    const { container, onUnavailable, onMessage } = detail(transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await authenticate(user);
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(secret));
    await user.click(screen.getByRole("button", { name: "复制密码" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("记录已更新");
    expect(container.querySelector(".credential-secret-value")).toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(calls.find((request) => request.action === "copy_secret")).toEqual(expect.objectContaining({ recordId: record.recordId, expectedVersion: 4, field: "password" }));
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByRole("dialog", { name: "验证主密码" })).toBeInTheDocument();
  });

  it("does not show a response addressed to a different record", async () => {
    const user = userEvent.setup();
    const { transport } = transportFor((request) => request.action === "read_fields" ? { recordId: "another-record", fields: { password: secret } } : undefined);
    const { container } = detail(transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await authenticate(user);
    expect(container.querySelector(".credential-secret-value")).toBeNull();
    expect(screen.getByLabelText("内容已隐藏")).toBeInTheDocument();
  });

  it.each([false, true])("distinguishes native copy from simulated copy (simulated=%s)", async (simulated) => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => request.action === "copy_secret" ? { copied: true, simulated } : undefined);
    const { onMessage, onSecretCopied } = detail(transport, { language: "en" });
    await user.click(screen.getByRole("button", { name: "Copy Password" }));
    await authenticate(user, "en");
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.stringContaining(simulated ? "Copy simulated" : "after 30 seconds")));
    expect(onSecretCopied).toHaveBeenCalledTimes(simulated ? 0 : 1);
    expect(calls.some((request) => request.action === "read_fields")).toBe(false);
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });

  it("does not claim a copy when the backend reports copied=false", async () => {
    const user = userEvent.setup();
    const { transport } = transportFor((request) => request.action === "copy_secret" ? { copied: false } : undefined);
    const { onMessage, onSecretCopied } = detail(transport);
    await user.click(screen.getByRole("button", { name: "复制密码" }));
    await authenticate(user);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onSecretCopied).not.toHaveBeenCalled();
  });

  it("hides one revealed field without re-reading it and restores focus when details close", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => request.action === "read_fields" ? { recordId: record.recordId, fields: { password: secret } } : undefined);
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const { container, unmount, onEdit, onDelete, onClose } = detail(transport, { language: "en" });
    await user.click(screen.getByRole("button", { name: "Show Password" }));
    await authenticate(user, "en");
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(secret));
    await user.click(screen.getByRole("button", { name: "Hide Password" }));
    expect(container.querySelector(".credential-secret-value")).toBeNull();
    expect(calls.filter((request) => request.action === "read_fields")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Delete credential" }));
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(onEdit).toHaveBeenCalledOnce(); expect(onDelete).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
    unmount(); expect(opener).toHaveFocus(); opener.remove();
  });

  it.each([false, true])("never labels a failed or simulated export as a real file (exported=%s)", async (exported) => {
    const user = userEvent.setup();
    const value: CredentialRecord = { ...record, type: "generic", note: "", secretFields: [], files: [{ field: "attachment", name: "synthetic.bin", size: 3, textReadable: false, formatHint: "binary_or_unknown" }] };
    const { transport, calls } = transportFor((request) => {
      if (request.action === "prepare_export") return { selectionId: "synthetic-selection" };
      if (request.action === "export_file") return { exported, simulated: true };
      return undefined;
    });
    const { onMessage } = detail(transport, { value, language: "en" });
    expect(screen.getByText("Unknown format; original bytes stored")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export original file synthetic.bin" }));
    await authenticate(user, "en");
    if (exported) expect(onMessage).toHaveBeenCalledWith("Export simulated; no real file was created.");
    else expect(onMessage).not.toHaveBeenCalled();
    expect(calls.some((request) => request.action === "read_fields")).toBe(false);
  });

  it("reports a picker failure without asking for a password or declaring export success", async () => {
    const user = userEvent.setup();
    const value = { ...record, files: [{ field: "privateKey", name: "synthetic.key", size: 24, textReadable: true, formatHint: "openssh_private_key" }] };
    const { transport, calls } = transportFor((request) => request.action === "prepare_export" ? Promise.reject({ code: "selected_file_unavailable" }) : undefined);
    const { onMessage } = detail(transport, { value });
    expect(screen.getByText("OpenSSH · 仅识别文件头，未验证")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出原文件 synthetic.key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法访问所选文件或目录");
    expect(screen.queryByRole("dialog", { name: "验证主密码" })).not.toBeInTheDocument();
    expect(calls.some((request) => request.action === "export_file")).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it.each([
    { keyParsed: true, certificateParsed: true, pairMatches: true, chainStatus: "verified_against_supplied_chain", expected: ["Private key: Parsed", "Certificate and key: Public keys match", "Certificate chain: Verified against supplied chain"] },
    { keyParsed: false, certificateParsed: false, pairMatches: false, chainStatus: "not_verified", expected: ["Private key: Failed; check passphrase or format", "Certificate: Failed", "Certificate and key: Do not match", "Certificate chain: Not verified"] },
    { keyParsed: null, certificateParsed: null, pairMatches: null, chainStatus: "certificate_required", expected: ["Certificate: Not checked or unsupported", "Certificate and key: Pairing unverified", "Certificate chain: A parsed certificate is required"] },
  ] as const)("keeps TLS inspection evidence limited to local files: $chainStatus", async (scenario) => {
    const user = userEvent.setup();
    const result: CredentialFileInspection = { ...scenario, limitations: [], verificationScope: "local_files_only" };
    const { transport, calls } = transportFor((request) => request.action === "inspect_files" ? result : undefined);
    detail(transport, { value: { ...record, type: "tls", secretFields: [], note: "" }, language: "en" });
    await user.click(screen.getByRole("button", { name: "Check files" }));
    await authenticate(user, "en");
    for (const text of scenario.expected) expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByText(/does not prove service connectivity, public trust or deployability/)).toBeInTheDocument();
    expect(calls.some((request) => request.action === "read_fields")).toBe(false);
  });
});

describe("credential sharing settings", () => {
  it("does not enable operations after status loading fails", async () => {
    const { transport } = transportFor(() => Promise.reject({ code: "credential_host_unavailable" }));
    render(<CredentialSettings transport={transport} language="en" demo={false} onOpenVault={vi.fn()} copyText={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("credential service is unavailable");
    expect(screen.getByRole("button", { name: "Enable access" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore backup" })).toBeDisabled();
  });

  it("sends users to create a missing vault and keeps file operations disabled", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const { transport, calls } = transportFor((request) => request.action === "status" ? status({ exists: false, locked: true }) : undefined);
    render(<CredentialSettings transport={transport} language="en" demo onOpenVault={open} copyText={vi.fn()} />);
    await screen.findByText("Not created");
    await user.click(screen.getByRole("button", { name: "Open vault" }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Change master password" })).toBeDisabled();
    expect(screen.getByText("Browser demo does not authorize access or use Keychain.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(screen.getByRole("button", { name: "Choose backup file" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.every((request) => request.action === "status")).toBe(true);
  });

  it("requires explicit confirmation and waits for the completed sharing status", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialStatus>();
    let current = status();
    const { transport, calls } = transportFor((request) => {
      if (request.action === "status") return current;
      if (request.action === "share") return pending.promise;
      return undefined;
    });
    render(<CredentialSettings transport={transport} language="en" demo={false} onOpenVault={vi.fn()} copyText={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Enable access" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Enable access" }));
    expect(screen.getByText(/existing and future credentials. Returned secrets/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((request) => request.action === "share")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Enable access" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Enable Agent access" })).toBeInTheDocument();
    current = status({ sharing: true, sharingRequested: true });
    await act(async () => pending.resolve(current));
    expect(await screen.findByRole("button", { name: "Disable access" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.filter((request) => request.action === "share")).toEqual([{ action: "share", enabled: true }]);
  });

  it("can disable retained sharing even when the system authorization is unavailable", async () => {
    const user = userEvent.setup();
    let current = status({ sharingRequested: true, authorizationError: "credential_authorization_required", lastBackupAt: "2026-10-22T00:00:00Z" });
    const { transport, calls } = transportFor((request) => {
      if (request.action === "share") { current = status(); return current; }
      if (request.action === "status") return current;
      return undefined;
    });
    render(<CredentialSettings transport={transport} language="en" demo={false} onOpenVault={vi.fn()} copyText={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Disable access" }));
    expect(screen.getByText(/Already delivered content cannot be recalled/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("button", { name: "Enable access" })).toBeEnabled();
    expect(calls).toContainEqual({ action: "share", enabled: false });
    expect(screen.queryByRole("button", { name: "Restore system authorization" })).not.toBeInTheDocument();
  });

  it("keeps a failed reset reviewable and only closes the confirmation after a successful retry", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { transport, calls } = transportFor((request) => {
      if (request.action === "status") return status({ sharing: true, sharingRequested: true });
      if (request.action === "reset_access") { if (++attempts === 1) throw { code: "credential_authorization_cancelled" }; return status({ sharing: true, sharingRequested: true }); }
      return undefined;
    });
    render(<CredentialSettings transport={transport} language="zh" demo={false} onOpenVault={vi.fn()} copyText={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "重置访问码" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "重置访问码" }));
    await user.click(screen.getByRole("button", { name: "确认" }));
    const modal = screen.getByRole("dialog", { name: "重置共用访问码" });
    expect(await within(modal).findByRole("alert")).toHaveTextContent("系统钥匙串授权已取消");
    await user.click(within(modal).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((request) => request.action === "reset_access")).toHaveLength(2);
    expect(calls.some((request) => request.action === "share")).toBe(false);
  });

  it("restores system authorization explicitly, then locks without discarding sharing", async () => {
    const user = userEvent.setup();
    let current = status({ sharingRequested: true, authorizationError: "credential_authorization_required" });
    const { transport, calls } = transportFor((request) => {
      if (request.action === "status") return current;
      if (request.action === "authorize_access") { current = status({ sharing: true, sharingRequested: true }); return current; }
      if (request.action === "lock") { current = { ...current, locked: true }; return current; }
      return undefined;
    });
    render(<CredentialSettings transport={transport} language="en" demo={false} onOpenVault={vi.fn()} copyText={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Restore system authorization" }));
    await waitFor(() => expect(screen.queryByText("System authorization required")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Lock now" }));
    await screen.findByText("Locked; authorization retained");
    expect(screen.getByRole("button", { name: "Disable access" })).toBeDisabled();
    expect(calls.some((request) => request.action === "share" || request.action === "reset_access")).toBe(false);
  });

  it("reports pending clipboard and file cleanup independently while the vault is locked", async () => {
    const user = userEvent.setup();
    const { transport } = transportFor((request) => {
      if (request.action === "status") return status({ locked: true, cleanupFailed: true, cleanupRemaining: 2, clipboard: { owned: false, error: "cleanup_failed" }, authorizationError: "credential_authorization_required" });
      if (request.action === "retry_cleanup") throw { code: "cleanup_failed" };
      return undefined;
    });
    render(<CredentialSettings transport={transport} language="en" demo={false} onOpenVault={vi.fn()} copyText={vi.fn()} />);
    expect(await screen.findByText("Clipboard cleanup is incomplete. Please check it manually.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore system authorization" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry cleanup" }));
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("(2)"))).toBe(true);
    expect(screen.getByRole("button", { name: "Retry cleanup" })).toBeEnabled();
  });
});

describe("selected Agent guide delivery", () => {
  const guide = (client: CredentialResults["agent_guide"]["client"], patch: Partial<CredentialResults["agent_guide"]> = {}): CredentialResults["agent_guide"] => ({ client, text: `Synthetic ${client} guide`, ready: true, reason: null, serverName: "synthetic-service", ...patch });

  it("opens the selected client guide from settings and copies it without changing authorization", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => {
      if (request.action === "status") return status({ sharing: true, sharingRequested: true });
      if (request.action === "agent_guide") return guide(request.client);
      return undefined;
    });
    const copy = vi.fn().mockResolvedValue(undefined);
    const props = { transport, language: "en", demo: false, onOpenVault: vi.fn(), copyText: copy };
    render(<CredentialSettings {...props} />);
    await screen.findByText("Unlocked; reopening the app requires manual unlock");
    expect(calls.filter((request) => request.action === "agent_guide")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Agent connection guide" }));
    const dialog = screen.getByRole("dialog", { name: "Agent connection guide" });
    await within(dialog).findByText("Synthetic codex guide");
    expect(within(dialog).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Codex", "Claude Code", "WorkBuddy", "DeepSeek Harness", "通用 MCP / Generic MCP",
    ]);
    await user.selectOptions(within(dialog).getByLabelText("Agent"), "workbuddy");
    await within(dialog).findByText("Synthetic workbuddy guide");
    expect(within(dialog).queryByText("Synthetic codex guide")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Copy guide for Agent" }));
    expect(copy).toHaveBeenCalledExactlyOnceWith("Synthetic workbuddy guide");
    expect(calls.filter((request) => request.action === "agent_guide" && request.client === "workbuddy")).toHaveLength(2);
    expect(calls.every((request) => request.action === "status" || request.action === "agent_guide")).toBe(true);
    expect(props.onOpenVault).not.toHaveBeenCalled();
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Agent connection guide" }));
    expect(await screen.findByText("Synthetic codex guide")).toBeInTheDocument();
  });

  it("keeps settings help available for a locked demo vault without offering a copyable configuration", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => {
      if (request.action === "status") return status({ locked: true });
      if (request.action === "agent_guide") return guide(request.client, { ready: false, reason: "vault_locked" });
      return undefined;
    });
    const copy = vi.fn();
    const props = { transport, language: "zh", demo: true, onOpenVault: vi.fn(), copyText: copy };
    render(<CredentialSettings {...props} />);
    await screen.findByText("已锁定，授权仍保留");
    await user.click(screen.getByRole("button", { name: "Agent 接入说明" }));
    await screen.findByText("Synthetic codex guide");
    expect(screen.getByRole("button", { name: "复制说明给 Agent" })).toBeDisabled();
    expect(copy).not.toHaveBeenCalled();
    expect(calls.every((request) => request.action === "status" || request.action === "agent_guide")).toBe(true);
    await user.click(screen.getAllByRole("button", { name: "关闭" })[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("浏览器演示不会建立授权或访问钥匙串。")).toBeInTheDocument();
  });

  it("removes the previous guide on selection and does not copy after the new client request fails", async () => {
    const user = userEvent.setup();
    const { transport } = transportFor((request) => request.action === "agent_guide"
      ? request.client === "codex" ? guide(request.client) : Promise.reject({ code: "agent_bridge_unavailable" }) : undefined);
    const copy = vi.fn();
    render(<CredentialAgentGuide transport={transport} language="en" copyText={copy} onClose={vi.fn()} />);
    await screen.findByText("Synthetic codex guide");
    await user.selectOptions(screen.getByLabelText("Agent"), "workbuddy");
    expect(await screen.findByRole("alert")).toHaveTextContent("local bridge is unavailable");
    expect(screen.queryByText("Synthetic codex guide")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy guide for Agent" })).toBeDisabled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("rejects a guide for the wrong selected client even when its ready flag is true", async () => {
    const { transport } = transportFor((request) => request.action === "agent_guide" ? guide("claude_code") : undefined);
    render(<CredentialAgentGuide transport={transport} language="en" copyText={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("Generating guide…")).not.toBeInTheDocument());
    expect(screen.queryByText("Synthetic claude_code guide")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy guide for Agent" })).toBeDisabled();
  });

  it("explains unavailable configuration even without a reason code", async () => {
    const { transport } = transportFor((request) => request.action === "agent_guide" ? guide(request.client, { ready: false }) : undefined);
    render(<CredentialAgentGuide transport={transport} language="en" copyText={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText("The connection is not ready; configuration cannot be copied yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy guide for Agent" })).toBeDisabled();
  });

  it("does not claim clipboard success when the copy transport rejects", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => request.action === "agent_guide" ? guide(request.client) : undefined);
    const copy = vi.fn().mockRejectedValue(new Error("synthetic clipboard failure"));
    render(<CredentialAgentGuide transport={transport} language="en" copyText={copy} onClose={vi.fn()} />);
    await screen.findByText("Synthetic codex guide");
    await user.selectOptions(screen.getByLabelText("Agent"), "generic");
    await screen.findByText("Synthetic generic guide");
    await user.click(screen.getByRole("button", { name: "Copy guide for Agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy the connection guide");
    expect(screen.queryByText(/The selected guide was copied/)).not.toBeInTheDocument();
    expect(copy).toHaveBeenCalledWith("Synthetic generic guide");
    expect(calls.every((request) => request.action === "agent_guide")).toBe(true);
  });

  it("drops a copy readiness result that arrives after the guide closes", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialResults["agent_guide"]>();
    let requests = 0;
    const { transport } = transportFor((request) => request.action === "agent_guide" ? ++requests === 1 ? guide(request.client) : pending.promise : undefined);
    const copy = vi.fn();
    const { unmount } = render(<CredentialAgentGuide transport={transport} language="zh" copyText={copy} onClose={vi.fn()} />);
    await screen.findByText("Synthetic codex guide");
    await user.click(screen.getByRole("button", { name: "复制说明给 Agent" }));
    expect(screen.getByLabelText("Agent")).toBeDisabled();
    unmount();
    await act(async () => pending.resolve(guide("codex")));
    expect(copy).not.toHaveBeenCalled();
  });
});
