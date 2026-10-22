import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { CredentialsView } from "./CredentialsView";
import { DemoCredentialTransport } from "./demoCredentialTransport";
import type { CredentialRecord, CredentialRequest, CredentialResults, CredentialTransport } from "./credentialTypes";

const password = "synthetic-flow-password";
async function fixture() {
  const real = new DemoCredentialTransport();
  await real.request({ action: "create", password, confirmPassword: password });
  const first = await real.request({ action: "save", type: "generic", name: "First fixture", metadata: { purpose: "first purpose" }, note: "synthetic", secrets: { value: "first synthetic secret" } });
  const second = await real.request({ action: "save", type: "database_user", name: "Second fixture", metadata: { host: "db.example.test", database: "sample", username: "app" }, note: "", secrets: { password: "second synthetic secret" } });
  return { real, first, second };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function intercepted(real: CredentialTransport, handler: (request: CredentialRequest) => Promise<unknown> | undefined): CredentialTransport {
  return { request: async <R extends CredentialRequest>(request: R): Promise<CredentialResults[R["action"]]> => {
    const response = handler(request);
    return response === undefined ? real.request(request) : await response as CredentialResults[R["action"]];
  } };
}
function mount(transport: CredentialTransport, overrides: Partial<ComponentProps<typeof CredentialsView>> = {}) {
  let guard = async () => true;
  const copyText = vi.fn().mockResolvedValue(undefined);
  const onOpenSettings = vi.fn();
  const onDirtyChange = vi.fn();
  const unregister = vi.fn();
  const rendered = render(<CredentialsView transport={transport} language="en" theme="dark" compact demo
    copyText={copyText} confirmDiscard={() => true} onOpenSettings={onOpenSettings} onDirtyChange={onDirtyChange}
    registerLeaveGuard={(callback) => { guard = callback; return unregister; }} {...overrides} />);
  return { ...rendered, copyText, onOpenSettings, onDirtyChange, unregister, leave: () => guard() };
}
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }); }
async function openFirst() { fireEvent.click(await screen.findByRole("button", { name: /^First fixture$/ })); return screen.findByRole("dialog", { name: "Credential details" }); }

describe("credential page workflows", () => {
  it.each(["en", "zh"])("creates a vault only after matching valid passwords, then saves a new record (%s)", async (language) => {
    const real = new DemoCredentialTransport();
    const calls = vi.spyOn(real, "request");
    mount(real, { language });
    await screen.findByRole("heading", { name: language === "zh" ? "创建你的凭据库" : "Create your vault" });
    const masterLabel = language === "zh" ? "主密码" : "Master password";
    const confirmLabel = language === "zh" ? "再次输入主密码" : "Confirm master password";
    const create = screen.getByRole("button", { name: language === "zh" ? "创建并解锁" : "Create and unlock" });
    fill(masterLabel, "short"); fill(confirmLabel, "different"); fireEvent.click(create);
    expect(await screen.findByRole("alert")).toHaveTextContent(language === "zh" ? "两次输入不一致" : "The passwords do not match");
    expect(calls.mock.calls.some(([request]) => request.action === "create")).toBe(false);
    fill(confirmLabel, "short"); fireEvent.click(create);
    expect(await screen.findByRole("alert")).toHaveTextContent(language === "zh" ? "至少 12" : "at least 12");
    fill(masterLabel, password); fill(confirmLabel, password); fireEvent.click(create);
    await screen.findByRole("heading", { name: language === "zh" ? "还没有凭据" : "No credentials yet" });
    fireEvent.click(screen.getAllByRole("button", { name: language === "zh" ? "新增凭据" : "New credential" })[0]);
    fireEvent.change(screen.getByRole("combobox", { name: language === "zh" ? /^类型$/ : /^Type$/ }), { target: { value: "generic" } });
    fill(language === "zh" ? "名称 *" : "Name *", "Created through page");
    fill(language === "zh" ? "秘密内容" : "Secret content", "synthetic content");
    fireEvent.click(screen.getByRole("button", { name: language === "zh" ? /^保存$/ : /^Save$/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(language === "zh" ? "凭据已保存" : "Credential saved");
    expect(screen.queryByDisplayValue(password)).not.toBeInTheDocument();
    expect((await real.request({ action: "list" })).records).toHaveLength(1);
  });

  it("recovers an initial status failure and retries an incorrect unlock", async () => {
    const { real } = await fixture();
    await real.request({ action: "lock" });
    let first = true;
    const transport = intercepted(real, (request) => {
      if (request.action === "status" && first) { first = false; return Promise.reject({ code: "credential_host_unavailable" }); }
      return undefined;
    });
    mount(transport);
    expect(await screen.findByRole("alert")).toHaveTextContent("The credential service is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Vault locked" });
    fill("Master password", "incorrect synthetic password");
    fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    fill("Master password", password); fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
    await screen.findByRole("button", { name: "First fixture" });
    expect(screen.queryByLabelText("Master password")).not.toBeInTheDocument();
  });

  it("cancelling a pending unlock keeps later success from reopening the page", async () => {
    const { real } = await fixture();
    const unlocked = await real.request({ action: "status" });
    await real.request({ action: "lock" });
    const unlock = deferred<typeof unlocked>();
    const transport = intercepted(real, (request) => request.action === "unlock" ? unlock.promise : undefined);
    const { leave } = mount(transport);
    await screen.findByRole("heading", { name: "Vault locked" });
    fill("Master password", password); fireEvent.click(screen.getByRole("button", { name: "Unlock vault" }));
    await expect(leave()).resolves.toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Cancel$/ })).not.toBeInTheDocument());
    await act(async () => unlock.resolve(unlocked));
    expect(screen.getByRole("heading", { name: "Vault locked" })).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Master password")).toHaveValue("");
  });

  it("preserves list failure feedback through the status recheck and clears it after a successful search", async () => {
    const { real } = await fixture();
    let fail = true;
    const transport = intercepted(real, (request) => request.action === "list" && fail ? Promise.reject({ code: "cleanup_failed" }) : undefined);
    mount(transport);
    expect(await screen.findByRole("alert")).toHaveTextContent("Managed-file cleanup is incomplete");
    expect(screen.getByRole("heading", { name: "No credentials yet" })).toBeInTheDocument();
    fail = false;
    fill("Search credentials", "First");
    await screen.findByRole("button", { name: "First fixture" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a failed status recheck instead of masking it with the earlier list error", async () => {
    const { real } = await fixture();
    let failedList = false;
    const transport = intercepted(real, (request) => {
      if (request.action === "list") { failedList = true; return Promise.reject({ code: "cleanup_failed" }); }
      if (request.action === "status" && failedList) return Promise.reject({ code: "credential_host_unavailable" });
      return undefined;
    });
    mount(transport);
    expect(await screen.findByRole("alert")).toHaveTextContent("The credential service is unavailable");
    expect(screen.getByRole("heading", { name: "Vault locked" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Content is hidden");
  });

  it.each(["resolve", "reject"])("ignores an older search that settles by %s after the current search", async (outcome) => {
    const { real, first } = await fixture();
    const old = deferred<{ records: CredentialRecord[] }>();
    const transport = intercepted(real, (request) => request.action === "list" && request.query === "older" ? old.promise : undefined);
    mount(transport);
    await screen.findByRole("button", { name: "First fixture" });
    fill("Search credentials", "older");
    expect(screen.getByText(/Loading…/)).toBeInTheDocument();
    fill("Search credentials", "Second");
    await waitFor(() => expect(screen.queryByRole("button", { name: "First fixture" })).not.toBeInTheDocument());
    await act(async () => { if (outcome === "resolve") old.resolve({ records: [first] }); else old.reject({ code: "credential_host_unavailable" }); });
    expect(screen.getByRole("button", { name: "Second fixture" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "First fixture" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("filters by type and clears empty-result filters without losing stored records", async () => {
    const { real } = await fixture();
    const { onOpenSettings } = mount(real);
    await screen.findByRole("button", { name: "First fixture" });
    fireEvent.change(screen.getByRole("combobox", { name: "Credential type filter" }), { target: { value: "ssh" } });
    await screen.findByRole("heading", { name: "No matching credentials" });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findAllByRole("article")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Vault settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Agent guide" }));
    const guide = await screen.findByRole("dialog", { name: "Agent connection guide" });
    fireEvent.click(within(guide).getAllByRole("button", { name: /^Close$/ })[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["record_conflict", "credential_host_unavailable"])("handles a detail failure %s without showing a stale record", async (code) => {
    const { real } = await fixture();
    const transport = intercepted(real, (request) => {
      if (request.action !== "detail") return undefined;
      if (code === "credential_host_unavailable") return real.request({ action: "lock" }).then(() => { throw { code }; });
      return Promise.reject({ code });
    });
    mount(transport);
    fireEvent.click(await screen.findByRole("button", { name: "First fixture" }));
    if (code === "record_conflict") expect(await screen.findByRole("alert")).toHaveTextContent("This record changed");
    else await screen.findByRole("heading", { name: "Vault locked" });
    expect(screen.queryByRole("dialog", { name: "Credential details" })).not.toBeInTheDocument();
  });

  it("ignores detail results superseded by another selected record", async () => {
    const { real, first } = await fixture();
    const old = deferred<CredentialRecord>();
    const transport = intercepted(real, (request) => request.action === "detail" && request.recordId === first.recordId ? old.promise : undefined);
    mount(transport);
    fireEvent.click(await screen.findByRole("button", { name: "First fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Second fixture" }));
    const detail = await screen.findByRole("dialog", { name: "Credential details" });
    expect(within(detail).getByRole("heading", { name: "Second fixture" })).toBeInTheDocument();
    await act(async () => old.resolve(first));
    expect(within(detail).queryByRole("heading", { name: "First fixture" })).not.toBeInTheDocument();
  });

  it("keeps edits when discard is declined, and discards them only after confirmation", async () => {
    const { real } = await fixture();
    const confirmDiscard = vi.fn().mockReturnValue(false);
    const { leave, onDirtyChange } = mount(real, { confirmDiscard });
    const detail = await openFirst();
    fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    fill("Name *", "Unsaved name");
    await expect(leave()).resolves.toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Second fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "New credential" }));
    fireEvent.click(screen.getByRole("button", { name: /^Lock$/ }));
    expect(screen.getByDisplayValue("Unsaved name")).toBeInTheDocument();
    expect(confirmDiscard).toHaveBeenCalledTimes(5);
    confirmDiscard.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await expect(leave()).resolves.toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("prevents leaving during a save and refreshes cards only after success", async () => {
    const { real, first } = await fixture();
    const saving = deferred<CredentialRecord>();
    const transport = intercepted(real, (request) => request.action === "save" ? saving.promise : undefined);
    const { leave } = mount(transport);
    const detail = await openFirst();
    fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    fill("Name *", "Saved later");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await expect(leave()).resolves.toBe(false);
    expect(screen.getByRole("button", { name: "Close editor" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Second fixture" }));
    expect(screen.getByDisplayValue("Saved later")).toBeInTheDocument();
    await act(async () => saving.resolve({ ...first, name: "Saved later", version: 2 }));
    expect(await screen.findByRole("status")).toHaveTextContent("Credential saved");
    await expect(leave()).resolves.toBe(true);
    expect(screen.getByRole("dialog", { name: "Credential details" })).toHaveTextContent("Saved later");
  });

  it.each(["record_conflict", "credential_host_unavailable"])("retains or hides the editor appropriately after save failure %s", async (code) => {
    const { real } = await fixture();
    const transport = intercepted(real, (request) => {
      if (request.action !== "save") return undefined;
      if (code === "credential_host_unavailable") return real.request({ action: "lock" }).then(() => { throw { code }; });
      return Promise.reject({ code });
    });
    mount(transport);
    const detail = await openFirst();
    fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    fill("Name *", "Retain this draft");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    if (code === "record_conflict") {
      expect(await screen.findByRole("alert")).toHaveTextContent("This record changed");
      expect(screen.getByDisplayValue("Retain this draft")).toBeInTheDocument();
    } else {
      await screen.findByRole("heading", { name: "Vault locked" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }
  });

  it("cancels deletion, then reports a failed delete and permits retry without losing the record", async () => {
    const { real } = await fixture();
    let fail = true;
    const transport = intercepted(real, (request) => request.action === "delete" && fail ? Promise.reject({ code: "record_conflict" }) : undefined);
    mount(transport);
    await openFirst();
    fireEvent.click(screen.getByRole("button", { name: "Delete credential" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete credential" })).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Credential details" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete credential" }));
    const deletion = screen.getByRole("dialog", { name: "Delete credential" });
    fireEvent.click(within(deletion).getByRole("button", { name: /^Delete$/ }));
    expect(await within(deletion).findByRole("alert")).toHaveTextContent("This record changed");
    expect(screen.getByRole("button", { name: "First fixture" })).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(deletion).getByRole("button", { name: /^Delete$/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Credential deleted");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect((await real.request({ action: "list" })).records.map((item) => item.name)).toEqual(["Second fixture"]);
  });

  it("hides records on lock even if lock cleanup fails", async () => {
    const { real } = await fixture();
    const transport = intercepted(real, (request) => request.action === "lock" ? Promise.reject({ code: "cleanup_failed" }) : undefined);
    mount(transport);
    await openFirst();
    fireEvent.click(screen.getByRole("button", { name: /^Lock$/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Managed-file cleanup is incomplete");
    expect(screen.getByRole("heading", { name: "Vault locked" })).toBeInTheDocument();
  });

  it("shows clipboard cleanup failure from status and refreshes it on focus", async () => {
    const { real } = await fixture();
    let failure = true;
    const transport = intercepted(real, (request) => request.action === "status" ? real.request(request).then((status) => ({ ...status, clipboard: { owned: false, error: failure ? "clipboard_cleanup_failed" : null } })) : undefined);
    mount(transport);
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard cleanup could not be confirmed");
    failure = false;
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("reports failed usage copying without reading any secret fields", async () => {
    const { real } = await fixture();
    const calls = vi.spyOn(real, "request");
    const copyText = vi.fn().mockRejectedValue(new Error("clipboard unavailable"));
    mount(real, { copyText });
    const card = (await screen.findByRole("button", { name: "First fixture" })).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "Use" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy usage instructions");
    expect(copyText).toHaveBeenCalledOnce();
    expect(calls.mock.calls.some(([request]) => request.action === "read_fields" || request.action === "verify")).toBe(false);
  });

  it("does not copy a locator after locking during its freshness check", async () => {
    const { real, first } = await fixture();
    const detail = deferred<CredentialRecord>();
    const transport = intercepted(real, (request) => request.action === "detail" ? detail.promise : undefined);
    const { copyText } = mount(transport);
    const card = (await screen.findByRole("button", { name: "First fixture" })).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "Use" }));
    fireEvent.click(screen.getByRole("button", { name: /^Lock$/ }));
    await screen.findByRole("heading", { name: "Vault locked" });
    await act(async () => detail.resolve(first));
    expect(copyText).not.toHaveBeenCalled();
  });

  it("unregisters the leave guard and discards a list failure after unmounting", async () => {
    const { real } = await fixture();
    const list = deferred<{ records: CredentialRecord[] }>();
    const calls: CredentialRequest[] = [];
    const transport = intercepted(real, (request) => { calls.push(request); return request.action === "list" ? list.promise : undefined; });
    const { unmount, unregister } = mount(transport);
    await screen.findByRole("heading", { name: "No credentials yet" });
    unmount();
    const before = calls.length;
    await act(async () => list.reject({ code: "credential_host_unavailable" }));
    fireEvent.focus(window);
    expect(calls).toHaveLength(before);
    expect(unregister).toHaveBeenCalledOnce();
  });
});
