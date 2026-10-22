import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialDetail } from "./CredentialDetail";
import { api } from "./api";
import { TauriAppService } from "./appService";
import { DemoCredentialTransport } from "./demoCredentialTransport";
import type { CredentialRecord, CredentialRequest, CredentialResults, CredentialTransport } from "./credentialTypes";

const nativeEvents = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: nativeEvents.listen }));

const master = "synthetic-focus-master";
const secret = " synthetic native focus secret\n ";
type BlurSubscription = (callback: () => void) => Promise<() => void>;
// Keep the regression compatible with the old transport until production is changed.
type NativeTransport = CredentialTransport & { onBlur: BlurSubscription };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(overrides: { registration?: Promise<() => void>; verification?: Promise<CredentialResults["verify"]>; read?: Promise<CredentialResults["read_fields"]> } = {}) {
  const real = new DemoCredentialTransport();
  await real.request({ action: "create", password: master, confirmPassword: master });
  const record = await real.request({ action: "save", type: "website", name: "Synthetic native focus", metadata: {}, note: "", secrets: { password: secret } });
  const calls: CredentialRequest[] = [];
  const unsubscribe = vi.fn();
  let notify: () => void = () => undefined;
  const onBlur = vi.fn<BlurSubscription>((callback) => {
    notify = callback;
    return overrides.registration ?? Promise.resolve(unsubscribe);
  });
  const transport: NativeTransport = {
    onBlur,
    request: async <R extends CredentialRequest>(request: R): Promise<CredentialResults[R["action"]]> => {
      calls.push(request);
      if (request.action === "verify" && overrides.verification) return await overrides.verification as CredentialResults[R["action"]];
      if (request.action === "read_fields" && overrides.read) return await overrides.read as CredentialResults[R["action"]];
      return real.request(request);
    },
  };
  return { record, transport, calls, unsubscribe, onBlur, blur: () => notify() };
}

function showDetail(record: CredentialRecord, transport: CredentialTransport) {
  return render(<CredentialDetail record={record} transport={transport} language="zh"
    onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={vi.fn()} />);
}

async function verify(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("主密码", { exact: true }), master);
  await user.click(screen.getByRole("button", { name: "验证并继续" }));
}

beforeEach(() => { nativeEvents.listen.mockReset().mockResolvedValue(vi.fn()); });
afterEach(() => { vi.restoreAllMocks(); });

describe("native credential focus invalidation", () => {
  it("hides an already revealed secret on native blur without a DOM blur and asks for verification again", async () => {
    const user = userEvent.setup();
    const state = await fixture();
    const { container } = showDetail(state.record, state.transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await verify(user);
    expect(container.querySelector(".credential-secret-value")?.textContent).toBe(secret);
    const verifiedSession = state.calls.find((request) => request.action === "verify")?.sessionId;

    act(() => state.blur());

    expect(container.querySelector(".credential-secret-value")).toBeNull();
    expect(screen.queryByText(/当前详情已验证/)).not.toBeInTheDocument();
    expect(state.calls).toContainEqual({ action: "invalidate_session", sessionId: verifiedSession });
    await user.click(screen.getByRole("button", { name: "复制密码" }));
    expect(screen.getByRole("dialog", { name: "验证主密码" })).toBeInTheDocument();
    expect(state.calls.filter((request) => request.action === "copy_secret")).toHaveLength(0);
  });

  it("rejects a secret read that finishes after native blur", async () => {
    const user = userEvent.setup();
    const read = deferred<CredentialResults["read_fields"]>();
    const state = await fixture({ read: read.promise });
    const { container } = showDetail(state.record, state.transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await verify(user);
    expect(state.calls.some((request) => request.action === "read_fields")).toBe(true);
    act(() => state.blur());
    await act(async () => read.resolve({ recordId: state.record.recordId, fields: { password: secret } }));
    expect(container.querySelector(".credential-secret-value")).toBeNull();
    expect(screen.getByRole("button", { name: "显示密码" })).toBeEnabled();
  });

  it("rejects late verification after native blur before requesting a secret", async () => {
    const user = userEvent.setup();
    const verification = deferred<CredentialResults["verify"]>();
    const state = await fixture({ verification: verification.promise });
    showDetail(state.record, state.transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await verify(user);
    act(() => state.blur());
    await act(async () => verification.resolve({ verified: true }));
    expect(screen.queryByRole("dialog", { name: "验证主密码" })).not.toBeInTheDocument();
    expect(state.calls.some((request) => request.action === "read_fields")).toBe(false);
    expect(screen.queryByText(/当前详情已验证/)).not.toBeInTheDocument();
  });

  it("waits for native listener registration before allowing a secret action", async () => {
    const user = userEvent.setup();
    const registration = deferred<() => void>();
    const state = await fixture({ registration: registration.promise });
    const { container } = showDetail(state.record, state.transport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    expect(screen.queryByRole("dialog", { name: "验证主密码" })).not.toBeInTheDocument();
    expect(state.calls.some((request) => request.action === "verify" || request.action === "read_fields")).toBe(false);

    await act(async () => registration.resolve(state.unsubscribe));
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await verify(user);
    expect(container.querySelector(".credential-secret-value")?.textContent).toBe(secret);
  });

  it("fails closed when native listener registration is rejected", async () => {
    const user = userEvent.setup();
    const registration = deferred<() => void>();
    const state = await fixture({ registration: registration.promise });
    showDetail(state.record, state.transport);
    // The test owns a rejection handler even on the old implementation, which
    // never subscribes; the regression should fail on visible behavior, not an unhandled rejection.
    void registration.promise.catch(() => undefined);
    await act(async () => registration.reject(new Error("synthetic event subscription failure")));
    expect(screen.getByRole("alert")).not.toHaveTextContent("synthetic event subscription failure");
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await user.click(screen.getByRole("button", { name: "复制密码" }));
    expect(screen.queryByRole("dialog", { name: "验证主密码" })).not.toBeInTheDocument();
    expect(state.calls.some((request) => request.action === "verify" || request.action === "read_fields" || request.action === "copy_secret")).toBe(false);
  });

  it("releases a listener whose registration finishes after the detail has closed", async () => {
    const registration = deferred<() => void>();
    const state = await fixture({ registration: registration.promise });
    const rendered = showDetail(state.record, state.transport);
    rendered.unmount();
    const before = state.calls.length;
    await act(async () => registration.resolve(state.unsubscribe));
    expect(state.unsubscribe).toHaveBeenCalledTimes(1);
    act(() => state.blur());
    expect(state.calls).toHaveLength(before);
  });

  it("retains one native subscription across DOM and native invalidations and disposes it on close", async () => {
    const state = await fixture();
    const rendered = showDetail(state.record, state.transport);
    await act(async () => undefined);
    fireEvent.blur(window);
    act(() => state.blur());
    expect(state.onBlur).toHaveBeenCalledTimes(1);
    rendered.unmount();
    await act(async () => undefined);
    expect(state.unsubscribe).toHaveBeenCalledTimes(1);
    const before = state.calls.length;
    act(() => state.blur());
    expect(state.calls).toHaveLength(before);
  });

  it("ignores a queued callback from a disposed subscription after the transport changes", async () => {
    const user = userEvent.setup();
    const first = await fixture();
    const next = await fixture();
    const rendered = showDetail(first.record, first.transport);
    await act(async () => undefined);
    rendered.rerender(<CredentialDetail record={next.record} transport={next.transport} language="zh"
      onClose={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onMessage={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await verify(user);
    expect(rendered.container.querySelector(".credential-secret-value")?.textContent).toBe(secret);
    const before = next.calls.length;
    act(() => first.blur());
    expect(next.calls).toHaveLength(before);
    expect(rendered.container.querySelector(".credential-secret-value")?.textContent).toBe(secret);
    act(() => next.blur());
    expect(rendered.container.querySelector(".credential-secret-value")).toBeNull();
  });

  it("does not open an export picker or inspect files when native registration fails", async () => {
    const user = userEvent.setup();
    const registration = deferred<() => void>();
    const state = await fixture({ registration: registration.promise });
    showDetail({ ...state.record, type: "tls", files: [{ field: "certificate", name: "synthetic.pem", size: 12, textReadable: true }] }, state.transport);
    await act(async () => registration.reject(new Error("synthetic event subscription failure")));
    await user.click(screen.getByRole("button", { name: "检查文件" }));
    await user.click(screen.getByRole("button", { name: "导出原文件 synthetic.pem" }));
    expect(screen.queryByRole("dialog", { name: "验证主密码" })).not.toBeInTheDocument();
    expect(state.calls.some((request) => request.action === "prepare_export" || request.action === "inspect_files" || request.action === "export_file")).toBe(false);
  });

  it("handles asynchronous native unlisten failure without restoring data or emitting an unhandled rejection", async () => {
    const state = await fixture({ registration: Promise.resolve(() => Promise.reject(new Error("synthetic unlisten failure"))) });
    const rendered = showDetail(state.record, state.transport);
    await act(async () => undefined);
    rendered.unmount();
    await act(async () => undefined);
    const before = state.calls.length;
    act(() => state.blur());
    expect(state.calls).toHaveLength(before);
  });

  it("uses the AppService native event adapter to clear visible data without a DOM event", async () => {
    const user = userEvent.setup();
    const state = await fixture();
    vi.spyOn(api, "credentialRequest").mockImplementation(state.transport.request);
    const service = new TauriAppService();
    const { container } = showDetail(state.record, service.credentialTransport);
    await user.click(screen.getByRole("button", { name: "显示密码" }));
    await verify(user);
    expect(container.querySelector(".credential-secret-value")?.textContent).toBe(secret);

    const subscription = nativeEvents.listen.mock.calls.find(([name]) => name === "tauri://blur");
    expect(subscription?.[2]).toEqual({ target: { kind: "Window", label: "main" } });
    act(() => subscription?.[1]({ event: "tauri://blur", id: 1, payload: null }));
    expect(container.querySelector(".credential-secret-value")).toBeNull();
    expect(screen.getByRole("button", { name: "显示密码" })).toBeInTheDocument();
  });
});
