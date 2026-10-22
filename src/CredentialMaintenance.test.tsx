import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CredentialAgentGuide } from "./CredentialAgentGuide";
import { CredentialDetail } from "./CredentialDetail";
import { CredentialMaintenance } from "./CredentialMaintenance";
import { CredentialRecovery } from "./CredentialRecovery";
import { CredentialSettings } from "./CredentialSettings";
import { DemoCredentialTransport } from "./demoCredentialTransport";
import type { CredentialRequest, CredentialResults, CredentialTransport } from "./credentialTypes";

const master = "synthetic-master-123";
function intercept(real: CredentialTransport, handler: (request: CredentialRequest) => unknown): CredentialTransport {
  return { request: async <R extends CredentialRequest>(request: R): Promise<CredentialResults[R["action"]]> => {
    const result = handler(request);
    return result === undefined ? real.request(request) : await result as CredentialResults[R["action"]];
  } };
}
async function fileFixture() {
  const real = new DemoCredentialTransport();
  await real.request({ action: "create", password: master, confirmPassword: master });
  const record = await real.request({ action: "save", type: "generic", name: "Synthetic file", metadata: {}, note: "", secrets: {}, files: [{ field: "attachment", name: "sample.bin", bytesBase64: "/wAB" }] });
  return { real, record };
}

describe("credential maintenance", () => {
  it("selects an export destination before verification and uses the fresh session after dialog blur", async () => {
    const user = userEvent.setup();
    const { real, record } = await fileFixture();
    const calls: CredentialRequest[] = [];
    const transport = intercept(real, (request) => {
      calls.push(request);
      if (request.action === "prepare_export") { fireEvent.blur(window); return { selectionId: "owned-ticket", name: "sample.bin" }; }
      if (request.action === "export_file") return { exported: true };
      return undefined;
    });
    const message = vi.fn();
    render(<CredentialDetail record={record} transport={transport} language="zh" onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={message} />);
    await user.click(screen.getByRole("button", { name: "导出原文件 sample.bin" }));
    expect(calls.some((request) => request.action === "verify" || request.action === "export_file")).toBe(false);
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "验证并继续" }));
    await waitFor(() => expect(message).toHaveBeenCalledWith(expect.stringContaining("原文件已导出")));
    const verification = calls.find((request) => request.action === "verify");
    const exported = calls.find((request) => request.action === "export_file");
    expect(exported).toEqual(expect.objectContaining({ selectionId: "owned-ticket", field: "attachment", sessionId: verification && "sessionId" in verification ? verification.sessionId : "missing" }));
    expect(calls.some((request) => request.action === "read_fields" || request.action === "copy_secret")).toBe(false);
  });

  it("does not request verification or export after cancelling the save dialog", async () => {
    const user = userEvent.setup();
    const { real, record } = await fileFixture();
    const calls: CredentialRequest[] = [];
    const transport = intercept(real, (request) => { calls.push(request); return request.action === "prepare_export" ? { selectionId: null } : undefined; });
    render(<CredentialDetail record={record} transport={transport} language="zh" onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "导出原文件 sample.bin" }));
    expect(screen.queryByRole("dialog", { name: "验证主密码" })).not.toBeInTheDocument();
    expect(calls.some((request) => request.action === "verify" || request.action === "export_file")).toBe(false);
  });

  it("does not reuse a verified session when an outstanding export picker blurs the window", async () => {
    const user = userEvent.setup();
    const { real, record } = await fileFixture();
    let finish: (value: CredentialResults["prepare_export"]) => void = () => undefined;
    const picker = new Promise<CredentialResults["prepare_export"]>((resolve) => { finish = resolve; });
    const calls: CredentialRequest[] = [];
    const transport = intercept(real, (request) => {
      calls.push(request);
      if (request.action === "prepare_export") return picker;
      if (request.action === "inspect_files") return { keyParsed: null, certificateParsed: null, pairMatches: null, chainStatus: "not_provided", verificationScope: "local_files_only", limitations: [] };
      if (request.action === "export_file") return { exported: true };
      return undefined;
    });
    const message = vi.fn();
    render(<CredentialDetail record={{ ...record, type: "ssh" }} transport={transport} language="zh" onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={message} />);
    await user.click(screen.getByRole("button", { name: "检查文件" }));
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "验证并继续" }));
    await screen.findByText("当前详情已验证；切换记录、关闭或离开窗口后需重新验证。");
    const firstVerification = calls.find((request) => request.action === "verify");
    await user.click(screen.getByRole("button", { name: "导出原文件 sample.bin" }));
    fireEvent.blur(window);
    await act(async () => finish({ selectionId: "fresh-ticket", name: "sample.bin" }));
    expect(screen.getByRole("dialog", { name: "验证主密码" })).toBeInTheDocument();
    expect(calls.some((request) => request.action === "export_file")).toBe(false);
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "验证并继续" }));
    await waitFor(() => expect(message).toHaveBeenCalledWith(expect.stringContaining("原文件已导出")));
    const verifications = calls.filter((request) => request.action === "verify");
    expect(verifications).toHaveLength(2);
    expect(verifications[1].sessionId).not.toBe(firstVerification?.sessionId);
    expect(calls.find((request) => request.action === "export_file")).toEqual(expect.objectContaining({ sessionId: verifications[1].sessionId, selectionId: "fresh-ticket", field: "attachment" }));
    expect(calls.some((request) => request.action === "read_fields" || request.action === "copy_secret")).toBe(false);
  });

  it("drops a destination selection returned after its record drawer closes", async () => {
    const user = userEvent.setup();
    const { real, record } = await fileFixture();
    let finish: (value: CredentialResults["prepare_export"]) => void = () => undefined;
    const picker = new Promise<CredentialResults["prepare_export"]>((resolve) => { finish = resolve; });
    const calls: CredentialRequest[] = [];
    const transport = intercept(real, (request) => { calls.push(request); return request.action === "prepare_export" ? picker : undefined; });
    const { unmount } = render(<CredentialDetail record={record} transport={transport} language="zh" onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "导出原文件 sample.bin" }));
    unmount();
    await act(async () => finish({ selectionId: "late-ticket" }));
    expect(calls.some((request) => request.action === "verify" || request.action === "export_file")).toBe(false);
  });

  it("verifies before checking TLS files and distinguishes an unknown pairing from a mismatch", async () => {
    const user = userEvent.setup();
    const { real, record } = await fileFixture();
    const calls: CredentialRequest[] = [];
    const transport = intercept(real, (request) => {
      calls.push(request);
      if (request.action === "inspect_files") return { keyParsed: null, certificateParsed: true, pairMatches: null, chainStatus: "not_provided", verificationScope: "local_files_only", limitations: ["key_format_unsupported"] };
      return undefined;
    });
    render(<CredentialDetail record={{ ...record, type: "tls" }} transport={transport} language="zh" onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "检查文件" }));
    expect(calls.some((request) => request.action === "inspect_files")).toBe(false);
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "验证并继续" }));
    expect(await screen.findByText("证书与私钥：未验证配对")).toBeInTheDocument();
    expect(screen.queryByText("证书与私钥：不匹配")).not.toBeInTheDocument();
    expect(calls.some((request) => request.action === "read_fields" || request.action === "copy_secret")).toBe(false);
    fireEvent.blur(window);
    expect(screen.queryByText("证书与私钥：未验证配对")).not.toBeInTheDocument();
  });

  it("keeps the old master password on failure and locks after a successful change", async () => {
    const user = userEvent.setup();
    const { real } = await fileFixture();
    await real.request({ action: "share", enabled: true });
    const status = vi.fn();
    const close = vi.fn();
    render(<CredentialMaintenance mode="password" transport={real} language="zh" demo onClose={close} onStatus={status} onMessage={vi.fn()} />);
    await user.type(screen.getByLabelText("当前主密码"), "wrong-password");
    await user.type(screen.getByLabelText("新主密码", { exact: true }), "synthetic-new-123");
    await user.type(screen.getByLabelText("再次输入新主密码"), "synthetic-new-123");
    await user.click(screen.getByRole("button", { name: "确认修改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("主密码不正确");
    expect(close).not.toHaveBeenCalled();
    expect((await real.request({ action: "status" })).locked).toBe(false);
    await user.type(screen.getByLabelText("当前主密码"), master);
    await user.type(screen.getByLabelText("新主密码", { exact: true }), "synthetic-new-123");
    await user.type(screen.getByLabelText("再次输入新主密码"), "synthetic-new-123");
    await user.click(screen.getByRole("button", { name: "确认修改" }));
    await waitFor(() => expect(status).toHaveBeenCalledWith(expect.objectContaining({ locked: true, sharingRequested: true })));
    await expect(real.request({ action: "unlock", password: master })).rejects.toEqual({ code: "vault_verification_failed" });
    await expect(real.request({ action: "unlock", password: "synthetic-new-123" })).resolves.toEqual(expect.objectContaining({ sharing: true }));
  });

  it("previews a backup before replacement and keeps secrets out of the confirmation", async () => {
    const user = userEvent.setup();
    const { real } = await fileFixture();
    const calls: CredentialRequest[] = [];
    const transport = intercept(real, (request) => {
      calls.push(request);
      if (request.action === "restore_pick") return real.request({ action: "lock" }).then(() => ({ selectionId: "backup-ticket", name: "synthetic.srtvault" }));
      if (request.action === "restore_preview") return { restoreId: "restore-ticket", vaultId: "other-vault", recordCount: 8, fileCount: 3, sameVault: false, replacesExisting: true };
      if (request.action === "restore_commit") return real.request({ action: "status" });
      return undefined;
    });
    const close = vi.fn();
    const status = vi.fn();
    render(<CredentialRecovery transport={transport} language="zh" demo={false} onClose={close} onStatus={status} onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "选择备份文件" }));
    await user.type(await screen.findByLabelText("备份的主密码"), master);
    await user.click(screen.getByRole("button", { name: "验证备份" }));
    expect(await screen.findByText("已验证：8 条凭据，3 个文件。")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(master)).not.toBeInTheDocument();
    expect(calls.some((request) => request.action === "restore_commit")).toBe(false);
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ locked: true }));
    await user.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(calls.find((request) => request.action === "restore_commit")).toEqual({ action: "restore_commit", restoreId: "restore-ticket" });
  });

  it("opening and cancelling the restore dialog alone does not lock or change the vault", async () => {
    const user = userEvent.setup();
    const { real } = await fileFixture();
    const calls = vi.spyOn(real, "request");
    const close = vi.fn();
    render(<StrictMode><CredentialRecovery transport={real} language="zh" demo={false} onClose={close} onStatus={vi.fn()} onMessage={vi.fn()} /></StrictMode>);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(close).toHaveBeenCalledOnce();
    expect(calls.mock.calls).toHaveLength(0);
  });

  it("a wrong backup password leaves recovery uncommitted and cancellation keeps the old vault locked", async () => {
    const user = userEvent.setup();
    const { real } = await fileFixture();
    const calls: CredentialRequest[] = [];
    const transport = intercept(real, (request) => {
      calls.push(request);
      if (request.action === "restore_pick") return real.request({ action: "lock" }).then(() => ({ selectionId: "backup-ticket", name: "synthetic.srtvault" }));
      if (request.action === "restore_preview") return Promise.reject({ code: "password_or_backup_invalid" });
      return undefined;
    });
    const close = vi.fn();
    const status = vi.fn();
    render(<CredentialRecovery transport={transport} language="zh" demo={false} onClose={close} onStatus={status} onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "选择备份文件" }));
    await user.type(await screen.findByLabelText("备份的主密码"), "wrong");
    await user.click(screen.getByRole("button", { name: "验证备份" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("备份主密码不正确");
    expect(calls.some((request) => request.action === "restore_commit")).toBe(false);
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ locked: true }));
    await expect(real.request({ action: "unlock", password: master })).resolves.toEqual(expect.objectContaining({ locked: false }));
  });

  it("does not report backup success after cancelling the native destination picker", async () => {
    const user = userEvent.setup();
    const { real } = await fileFixture();
    const transport = intercept(real, (request) => request.action === "backup_create" ? { created: false, cancelled: true } : undefined);
    const message = vi.fn();
    render(<CredentialMaintenance mode="backup" transport={transport} language="zh" demo={false} onClose={vi.fn()} onStatus={vi.fn()} onMessage={message} />);
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "选择位置并备份" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "选择位置并备份" })).toBeDisabled());
    expect(message).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "创建加密备份" })).toBeInTheDocument();
  });

  it("keeps demo file actions explicit and allows cleanup retry while locked", async () => {
    const user = userEvent.setup();
    const { real } = await fileFixture();
    await real.request({ action: "lock" });
    let cleanupFailed = true;
    const transport = intercept(real, (request) => {
      if (request.action === "retry_cleanup") { cleanupFailed = false; return real.request({ action: "status" }); }
      if (request.action === "status") return real.request(request).then((value) => ({ ...value, cleanupFailed }));
      return undefined;
    });
    render(<CredentialSettings transport={transport} language="zh" demo onOpenVault={vi.fn()} copyText={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "重试清理" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试清理" })).not.toBeInTheDocument());
    await expect(real.request({ action: "restore_pick" })).rejects.toEqual({ code: "demo_native_only" });
  });
});

describe("Agent guide selection", () => {
  it("ignores a stale client response and only copies a freshly generated selected guide", async () => {
    const user = userEvent.setup();
    const { real } = await fileFixture();
    let finish: (result: CredentialResults["agent_guide"]) => void = () => undefined;
    const old = new Promise<CredentialResults["agent_guide"]>((resolve) => { finish = resolve; });
    const transport = intercept(real, (request) => {
      if (request.action !== "agent_guide") return undefined;
      return request.client === "codex" ? old : { client: request.client, text: "Selected DeepSeek guide without secrets", ready: true, reason: null, serverName: "synthetic-service" };
    });
    const copy = vi.fn().mockResolvedValue(undefined);
    render(<CredentialAgentGuide transport={transport} language="zh" copyText={copy} onClose={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Agent"), "deepseek_harness");
    await screen.findByText("Selected DeepSeek guide without secrets");
    await act(async () => finish({ client: "codex", text: "Stale Codex guide", ready: true, reason: null, serverName: "synthetic-service" }));
    expect(screen.queryByText("Stale Codex guide")).not.toBeInTheDocument();
    expect(copy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "复制说明给 Agent" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("Selected DeepSeek guide without secrets"));
  });

  it("refuses copying when readiness is revoked between display and click", async () => {
    const user = userEvent.setup();
    const { real } = await fileFixture();
    let ready = true;
    const transport = intercept(real, (request) => request.action === "agent_guide" ? { client: request.client, text: "Synthetic guide", ready, reason: ready ? null : "agent_sharing_required", serverName: "synthetic-service" } : undefined);
    const copy = vi.fn();
    render(<CredentialAgentGuide transport={transport} language="zh" copyText={copy} onClose={vi.fn()} />);
    await screen.findByText("Synthetic guide");
    ready = false;
    await user.click(screen.getByRole("button", { name: "复制说明给 Agent" }));
    expect(copy).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("开启本机 Agent 访问");
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "复制说明给 Agent" })).toBeDisabled();
  });
});
