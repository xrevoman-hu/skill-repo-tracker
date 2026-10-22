import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CredentialsView } from "./CredentialsView";
import { CredentialDetail } from "./CredentialDetail";
import { CredentialEditor } from "./CredentialEditor";
import { DemoCredentialTransport } from "./demoCredentialTransport";
import type { CredentialRequest, CredentialResults, CredentialTransport } from "./credentialTypes";

const master = "synthetic-master-123";
const secret = "  synthetic-secret\nwith-newline  ";
async function fixture() {
  const transport = new DemoCredentialTransport();
  await transport.request({ action: "create", password: master, confirmPassword: master });
  const record = await transport.request({ action: "save", type: "website", name: "Sample website", metadata: { url: "https://example.test", username: "demo" }, note: "", secrets: { password: secret } });
  return { transport, record };
}
function view(transport: CredentialTransport, copyText = vi.fn().mockResolvedValue(undefined)) {
  return <CredentialsView transport={transport} language="zh" theme="light" compact={false} demo
    copyText={copyText} confirmDiscard={() => true} onOpenSettings={vi.fn()} onDirtyChange={vi.fn()}
    registerLeaveGuard={() => () => undefined} />;
}

describe("credential user flows", () => {
  it("requires fresh verification after StrictMode remounts the detail effects", async () => {
    const user = userEvent.setup();
    const { transport, record } = await fixture();
    const calls = vi.spyOn(transport, "request");
    const { container } = render(<StrictMode><CredentialDetail record={record} transport={transport} language="zh" onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={vi.fn()} /></StrictMode>);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.getByRole("dialog", { name: "验证主密码" })).toBeInTheDocument();
    expect(calls.mock.calls.some(([request]) => request.action === "read_fields")).toBe(false);
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "验证并继续" }));
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(secret));
    const verified = calls.mock.calls.find(([request]) => request.action === "verify")?.[0];
    expect(verified).toEqual(expect.objectContaining({ sessionId: expect.stringMatching(/^[a-f0-9]{32}$/) }));
  });

  it("copies only a freshly checked record locator without reading a secret or granting access", async () => {
    const user = userEvent.setup();
    const { transport, record } = await fixture();
    const calls = vi.spyOn(transport, "request");
    const copy = vi.fn().mockResolvedValue(undefined);
    render(view(transport, copy));
    await user.click(await screen.findByRole("button", { name: "使用" }));
    await waitFor(() => expect(copy).toHaveBeenCalledOnce());
    const text = copy.mock.calls[0][0] as string;
    expect(text).toContain(record.recordId);
    expect(text).toContain('"vaultId":"demo-vault"');
    expect(text).not.toContain(secret);
    expect(calls.mock.calls.some(([request]) => ["verify", "read_fields", "share", "copy_secret"].includes(request.action))).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent("已复制使用指令");
  });

  it("verifies before native secret copy without first fetching or showing the value", async () => {
    const user = userEvent.setup();
    const { transport } = await fixture();
    const calls = vi.spyOn(transport, "request");
    render(view(transport));
    await user.click(await screen.findByRole("button", { name: "Sample website" }));
    await user.click(await screen.findByRole("button", { name: "复制密码" }));
    const modal = screen.getByRole("dialog", { name: "验证主密码" });
    await user.type(within(modal).getByLabelText("主密码", { exact: true }), master);
    await user.click(within(modal).getByRole("button", { name: "验证并继续" }));
    await waitFor(() => expect(calls.mock.calls.some(([request]) => request.action === "copy_secret")).toBe(true));
    expect(calls.mock.calls.some(([request]) => request.action === "read_fields")).toBe(false);
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("未写入系统剪贴板");
  });

  it("discards a verification response that arrives after the window loses focus", async () => {
    const user = userEvent.setup();
    const { transport: real, record } = await fixture();
    let finish: (value: { verified: boolean }) => void = () => undefined;
    const delayed = new Promise<{ verified: boolean }>((resolve) => { finish = resolve; });
    const requests: CredentialRequest[] = [];
    const transport: CredentialTransport = {
      request: <R extends CredentialRequest>(request: R): Promise<CredentialResults[R["action"]]> => {
        requests.push(request);
        if (request.action === "verify") return delayed as Promise<CredentialResults[R["action"]]>;
        return real.request(request);
      },
    };
    render(<CredentialDetail record={record} transport={transport} language="zh" onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "验证并继续" }));
    fireEvent.blur(window);
    await act(async () => finish({ verified: true }));
    expect(requests.some((request) => request.action === "invalidate_session")).toBe(true);
    expect(requests.some((request) => request.action === "read_fields" || request.action === "copy_secret")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "验证主密码" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("内容已隐藏")).toBeInTheDocument();
  });

  it("keeps saved secrets out of edit fields and omits blank values from a metadata update", async () => {
    const user = userEvent.setup();
    const { record } = await fixture();
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CredentialEditor record={record} language="zh" onSave={save} onClose={vi.fn()} onDirtyChange={vi.fn()} />);
    expect(screen.getByPlaceholderText("留空保留已保存值")).toHaveValue("");
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("账号 / 用户名 *"));
    await user.type(screen.getByLabelText("账号 / 用户名 *"), "changed");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ recordId: record.recordId, expectedVersion: 1, secrets: {}, metadata: expect.objectContaining({ username: "changed" }) }));
  });

  it("removes list and detail content immediately when locked, keeping the guide non-executable", async () => {
    const user = userEvent.setup();
    const { transport } = await fixture();
    render(view(transport));
    await user.click(await screen.findByRole("button", { name: "Sample website" }));
    await user.click(screen.getByRole("button", { name: "锁定" }));
    expect(await screen.findByRole("heading", { name: "凭据库已锁定" })).toBeInTheDocument();
    expect(screen.queryByText("Sample website")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Agent 接入说明" }));
    expect(screen.getByRole("button", { name: "复制说明给 Agent" })).toBeDisabled();
    expect(screen.getByText(/不能复制可执行配置/)).toBeInTheDocument();
  });

  it("hides previously displayed values when the credential host disconnects", async () => {
    const user = userEvent.setup();
    const { transport: real } = await fixture();
    const transport: CredentialTransport = {
      request: async <R extends CredentialRequest>(request: R): Promise<CredentialResults[R["action"]]> => {
        if (request.action === "copy_secret") {
          await real.request({ action: "lock" });
          throw { code: "credential_host_unavailable" };
        }
        return real.request(request);
      },
    };
    const { container } = render(view(transport));
    await user.click(await screen.findByRole("button", { name: "Sample website" }));
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "验证并继续" }));
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(secret));
    await user.click(screen.getByRole("button", { name: "复制密码" }));
    expect(await screen.findByRole("heading", { name: "凭据库已锁定" })).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByText("Sample website")).not.toBeInTheDocument();
  });
});
