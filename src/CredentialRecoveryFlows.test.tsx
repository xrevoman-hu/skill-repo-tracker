import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CredentialMaintenance } from "./CredentialMaintenance";
import { CredentialRecovery } from "./CredentialRecovery";
import { CredentialSettings } from "./CredentialSettings";
import type { CredentialRequest, CredentialResults, CredentialStatus, CredentialTransport } from "./credentialTypes";

const master = "synthetic-master-123";
const nextMaster = "synthetic-next-master-123";
const state = (patch: Partial<CredentialStatus> = {}): CredentialStatus => ({
  exists: true, locked: true, vaultId: "synthetic-vault", sharing: false, sharingRequested: false,
  authorizationError: null, cleanupFailed: false, ...patch,
});
const preview: CredentialResults["restore_preview"] = {
  restoreId: "synthetic-restore", vaultId: "synthetic-vault", recordCount: 8, fileCount: 3,
  sameVault: true, replacesExisting: false,
};
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
      const value = handler(request);
      if (value !== undefined) return await value as CredentialResults[R["action"]];
      if (request.action === "status" || request.action === "restore_cancel") return state() as CredentialResults[R["action"]];
      throw new Error(`Unexpected action: ${request.action}`);
    },
  };
  return { transport, calls };
}
function recovery(transport: CredentialTransport, language = "zh", demo = false) {
  const callbacks = { onClose: vi.fn(), onStatus: vi.fn(), onMessage: vi.fn() };
  return { ...render(<CredentialRecovery transport={transport} language={language} demo={demo} {...callbacks} />), ...callbacks };
}
function maintenance(transport: CredentialTransport, mode: "password" | "backup", language = "zh", demo = false) {
  const callbacks = { onClose: vi.fn(), onStatus: vi.fn(), onMessage: vi.fn() };
  return { ...render(<CredentialMaintenance mode={mode} transport={transport} language={language} demo={demo} {...callbacks} />), ...callbacks };
}
async function chooseAndVerify(user: ReturnType<typeof userEvent.setup>, language = "zh") {
  await user.click(screen.getByRole("button", { name: language === "zh" ? "选择备份文件" : "Choose backup file" }));
  await user.type(await screen.findByLabelText(language === "zh" ? "备份的主密码" : "Backup master password"), master);
  await user.click(screen.getByRole("button", { name: language === "zh" ? "验证备份" : "Verify backup" }));
}

describe("encrypted backup recovery boundaries", () => {
  it("leaves a cancelled picker locked without manufacturing a selected file or success", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => request.action === "restore_pick" ? { selectionId: null } : undefined);
    const { onStatus, onMessage, onClose } = recovery(transport, "en");
    await user.click(screen.getByRole("button", { name: "Choose backup file" }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ locked: true })));
    expect(screen.queryByLabelText("Backup master password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify backup" })).toBeDisabled();
    expect(onMessage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls.some((request) => request.action === "restore_cancel")).toBe(true);
    expect(calls.some((request) => request.action === "restore_commit")).toBe(false);
  });

  it("preserves the picker failure when even the subsequent status refresh fails", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => {
      if (request.action === "restore_pick") throw { code: "backup_source_inside_vault" };
      if (request.action === "status") throw { code: "credential_host_unavailable" };
      return undefined;
    });
    const { onStatus, onMessage } = recovery(transport);
    await user.click(screen.getByRole("button", { name: "选择备份文件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请从凭据库目录之外选择备份");
    expect(screen.getByRole("button", { name: "选择备份文件" })).toBeEnabled();
    expect(onStatus).not.toHaveBeenCalled(); expect(onMessage).not.toHaveBeenCalled();
    expect(calls.some((request) => request.action === "restore_preview" || request.action === "restore_commit")).toBe(false);
  });

  it("cancels recovery when a native picker completes after the component unmounts", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialResults["restore_pick"]>();
    const { transport, calls } = transportFor((request) => request.action === "restore_pick" ? pending.promise : undefined);
    const { unmount, onStatus, onMessage } = recovery(transport);
    await user.click(screen.getByRole("button", { name: "选择备份文件" }));
    unmount();
    await act(async () => pending.resolve({ selectionId: "late-selection", name: "synthetic.srtvault" }));
    expect(calls.some((request) => request.action === "restore_cancel")).toBe(true);
    expect(calls.some((request) => request.action === "status" || request.action === "restore_preview")).toBe(false);
    expect(onStatus).not.toHaveBeenCalled(); expect(onMessage).not.toHaveBeenCalled();
  });

  it("does not publish a stale status returned after the restore view closes", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialStatus>();
    const { transport, calls } = transportFor((request) => {
      if (request.action === "restore_pick") return { selectionId: "synthetic-selection" };
      if (request.action === "status") return pending.promise;
      return undefined;
    });
    const { unmount, onStatus } = recovery(transport);
    await user.click(screen.getByRole("button", { name: "选择备份文件" }));
    await waitFor(() => expect(calls.some((request) => request.action === "status")).toBe(true));
    unmount();
    await act(async () => pending.resolve(state()));
    expect(onStatus).not.toHaveBeenCalled();
    expect(calls.some((request) => request.action === "restore_cancel")).toBe(true);
  });

  it("ignores a rejected picker after close instead of refreshing an unrelated view", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialResults["restore_pick"]>();
    const { transport, calls } = transportFor((request) => request.action === "restore_pick" ? pending.promise : undefined);
    const { unmount, onStatus } = recovery(transport);
    await user.click(screen.getByRole("button", { name: "选择备份文件" }));
    unmount();
    await act(async () => pending.reject({ code: "selected_file_unavailable" }));
    expect(calls.some((request) => request.action === "status")).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("clears a verified preview and password when another backup is chosen", async () => {
    const user = userEvent.setup();
    let picks = 0;
    const { transport, calls } = transportFor((request) => {
      if (request.action === "restore_pick") return { selectionId: `synthetic-selection-${++picks}` };
      if (request.action === "restore_preview") return preview;
      return undefined;
    });
    recovery(transport, "en");
    await chooseAndVerify(user, "en");
    expect(await screen.findByText("Verified: 8 records and 3 files.")).toBeInTheDocument();
    expect(screen.getByText(/restored vault will be created directly/)).toBeInTheDocument();
    expect(screen.getByText(/Existing local authorization is retained/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(master)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose another backup" }));
    expect(await screen.findByText("Selected backup")).toBeInTheDocument();
    expect(screen.queryByText("Verified: 8 records and 3 files.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm restore" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Backup master password")).toHaveValue("");
    expect(calls.some((request) => request.action === "restore_commit")).toBe(false);
  });

  it("erases a submitted backup password while verification is pending and cancels late previews on unmount", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialResults["restore_preview"]>();
    const { transport, calls } = transportFor((request) => {
      if (request.action === "restore_pick") return { selectionId: "synthetic-selection", name: "synthetic.srtvault" };
      if (request.action === "restore_preview") return pending.promise;
      return undefined;
    });
    const { unmount, onMessage, onClose } = recovery(transport);
    await chooseAndVerify(user);
    expect(screen.getByLabelText("备份的主密码")).toHaveValue("");
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    unmount();
    await act(async () => pending.resolve(preview));
    expect(onMessage).not.toHaveBeenCalled();
    expect(calls.some((request) => request.action === "restore_commit")).toBe(false);
    expect(calls.some((request) => request.action === "restore_cancel")).toBe(true);
  });

  it("reports integrity failure without offering a restore confirmation", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => {
      if (request.action === "restore_pick") return { selectionId: "synthetic-selection" };
      if (request.action === "restore_preview") throw { code: "backup_integrity_failed" };
      return undefined;
    });
    const { onMessage } = recovery(transport, "en");
    await chooseAndVerify(user, "en");
    expect(await screen.findByRole("alert")).toHaveTextContent("Backup integrity checking failed");
    expect(screen.getByLabelText("Backup master password")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Confirm restore" })).not.toBeInTheDocument();
    expect(calls.some((request) => request.action === "restore_commit")).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("does not call a changed backup restored; a later success includes the restart failure warning", async () => {
    const user = userEvent.setup();
    let commits = 0;
    const { transport, calls } = transportFor((request) => {
      if (request.action === "restore_pick") return { selectionId: "synthetic-selection", name: "synthetic.srtvault" };
      if (request.action === "restore_preview") return { ...preview, sameVault: false, replacesExisting: true };
      if (request.action === "restore_commit") { if (++commits === 1) throw { code: "backup_preview_changed" }; return state({ restartRequired: true }); }
      return undefined;
    });
    const { onMessage, onClose, onStatus, unmount } = recovery(transport, "en");
    await chooseAndVerify(user, "en");
    expect(await screen.findByText(/encrypted recovery copy is retained before switching/)).toBeInTheDocument();
    expect(screen.getByText(/Agent access defaults to off/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("backup changed after verification");
    expect(onClose).not.toHaveBeenCalled(); expect(onMessage).not.toHaveBeenCalled();
    // A changed source must be reselected and reverified before the next attempt.
    await user.click(screen.getByRole("button", { name: "Choose another backup" }));
    await user.type(await screen.findByLabelText("Backup master password"), master);
    await user.click(screen.getByRole("button", { name: "Verify backup" }));
    await user.click(await screen.findByRole("button", { name: "Confirm restore" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ locked: true, restartRequired: true }));
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("backup was restored, but the credential service could not restart"));
    expect(onMessage.mock.calls[0][0]).not.toContain("Disk sync");
    unmount();
    expect(calls.some((request) => request.action === "restore_cancel")).toBe(false);
  });

  it.each([
    { language: "zh", restartRequired: false, completed: "恢复完成，凭据库保持锁定", warning: "磁盘同步未确认，请保留备份并核对数据" },
    { language: "zh", restartRequired: true, completed: "备份已恢复，但凭据服务未能重启", warning: "磁盘同步未确认，请保留备份并核对数据" },
    { language: "en", restartRequired: false, completed: "Restored. The vault remains locked", warning: "Disk sync is unconfirmed. Keep the backup and check the data" },
    { language: "en", restartRequired: true, completed: "backup was restored, but the credential service could not restart", warning: "Disk sync is unconfirmed. Keep the backup and check the data" },
  ])("keeps a completed restore successful with an independent sync warning ($language, restart=$restartRequired)", async ({ language, restartRequired, completed, warning }) => {
    const user = userEvent.setup();
    const result = state({ restartRequired, durabilityWarning: true });
    const { transport, calls } = transportFor((request) => {
      if (request.action === "restore_pick") return { selectionId: "synthetic-selection" };
      if (request.action === "restore_preview") return preview;
      if (request.action === "restore_commit") return result;
      return undefined;
    });
    const { onMessage, onStatus, onClose, unmount } = recovery(transport, language);
    await chooseAndVerify(user, language);
    await user.click(await screen.findByRole("button", { name: language === "zh" ? "确认恢复" : "Confirm restore" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onStatus).toHaveBeenLastCalledWith(result);
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0]).toContain(completed);
    expect(onMessage.mock.calls[0][0]).toContain(warning);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();
    expect(calls.filter((request) => request.action === "restore_commit")).toHaveLength(1);
    expect(calls.some((request) => request.action === "restore_cancel")).toBe(false);
  });

  it("keeps the dialog open when cancellation fails and lets the user retry", async () => {
    const user = userEvent.setup();
    let cancellations = 0;
    const { transport } = transportFor((request) => {
      if (request.action === "restore_pick") return { selectionId: "synthetic-selection" };
      if (request.action === "restore_cancel") { if (++cancellations === 1) throw { code: "cleanup_failed" }; return state(); }
      return undefined;
    });
    const { onClose, onStatus, onMessage } = recovery(transport, "en");
    await user.click(screen.getByRole("button", { name: "Choose backup file" }));
    await user.type(await screen.findByLabelText("Backup master password"), master);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cleanup is incomplete");
    expect(screen.getByLabelText("Backup master password")).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ locked: true }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("does not deliver a recovery result into a view that has already unmounted", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialStatus>();
    const { transport } = transportFor((request) => {
      if (request.action === "restore_pick") return { selectionId: "synthetic-selection" };
      if (request.action === "restore_preview") return preview;
      if (request.action === "restore_commit") return pending.promise;
      return undefined;
    });
    const { onMessage, onClose, onStatus, unmount } = recovery(transport);
    await chooseAndVerify(user);
    await user.click(await screen.findByRole("button", { name: "确认恢复" }));
    const updatesBeforeClose = onStatus.mock.calls.length;
    unmount();
    await act(async () => pending.resolve(state()));
    expect(onStatus).toHaveBeenCalledTimes(updatesBeforeClose);
    expect(onMessage).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
});

describe("password and backup maintenance feedback", () => {
  it("blocks password mismatch locally and clears submitted passwords on backend rejection", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor((request) => request.action === "change_password" ? Promise.reject({ code: "vault_verification_failed" }) : undefined);
    const { onClose, onMessage } = maintenance(transport, "password", "en");
    await user.type(screen.getByLabelText("Current master password"), master);
    await user.type(screen.getByLabelText("New master password", { exact: true }), nextMaster);
    await user.type(screen.getByLabelText("Confirm new master password"), "different-synthetic-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByRole("alert")).toHaveTextContent("passwords do not match");
    expect(calls).toHaveLength(0);
    await user.clear(screen.getByLabelText("Confirm new master password"));
    await user.type(screen.getByLabelText("Confirm new master password"), nextMaster);
    fireEvent.submit(screen.getByLabelText("Current master password").closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("password or vault could not be verified");
    for (const label of ["Current master password", "New master password", "Confirm new master password"]) expect(screen.getByLabelText(label, { exact: true })).toHaveValue("");
    expect(onMessage).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(calls).toEqual([{ action: "change_password", oldPassword: master, newPassword: nextMaster, confirmPassword: nextMaster }]);
  });

  it("locks after changing the password and explains the retained Agent code", async () => {
    const user = userEvent.setup();
    const { transport } = transportFor((request) => request.action === "change_password" ? state({ sharing: true, sharingRequested: true }) : undefined);
    const { onStatus, onMessage, onClose } = maintenance(transport, "password", "en");
    await user.type(screen.getByLabelText("Current master password"), master);
    await user.type(screen.getByLabelText("New master password", { exact: true }), nextMaster);
    await user.type(screen.getByLabelText("Confirm new master password"), nextMaster);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ locked: true, sharingRequested: true }));
    expect(onMessage).toHaveBeenCalledWith("Master password changed; the Agent access code is retained. Unlock with the new password.");
  });

  it("ignores Escape while backup is pending and reports every partial completion warning", async () => {
    const user = userEvent.setup();
    const pending = deferred<CredentialResults["backup_create"]>();
    const { transport } = transportFor((request) => {
      if (request.action === "backup_create") return pending.promise;
      if (request.action === "status") throw { code: "credential_host_unavailable" };
      return undefined;
    });
    const { onClose, onMessage, onStatus } = maintenance(transport, "backup", "en");
    await user.type(screen.getByLabelText("Master password", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "Choose location and back up" }));
    expect(screen.getByLabelText("Master password", { exact: true })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ created: true, warnings: ["backup_metadata_failed", "backup_sync_unconfirmed", "backup_cleanup_failed"] }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onStatus).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("Encrypted backup created"));
    for (const notice of ["backup time could not be recorded", "Disk sync is unconfirmed. Keep the backup and check the data", "Encrypted staging cleanup is incomplete", "Status refresh failed"]) expect(onMessage.mock.calls[0][0]).toContain(notice);
  });

  it("reports a completed backup with the shared sync warning in Chinese", async () => {
    const user = userEvent.setup();
    const { transport } = transportFor((request) => request.action === "backup_create" ? { created: true, warning: "backup_sync_unconfirmed" } : undefined);
    const { onMessage, onStatus, onClose } = maintenance(transport, "backup");
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "选择位置并备份" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onMessage.mock.calls[0][0]).toContain("加密备份已创建");
    expect(onMessage.mock.calls[0][0]).toContain("磁盘同步未确认，请保留备份并核对数据");
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ locked: true }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("labels a simulated backup explicitly and preserves a singular warning", async () => {
    const user = userEvent.setup();
    const { transport } = transportFor((request) => request.action === "backup_create" ? { created: true, simulated: true, warning: "backup_metadata_failed" } : undefined);
    const { onMessage, onStatus } = maintenance(transport, "backup");
    await user.type(screen.getByLabelText("主密码", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "选择位置并备份" }));
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("仅演示备份，未写入真实文件。 备份时间未能登记。"));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ locked: true }));
  });

  it("does not replace a backup failure with a success toast and requires fresh password input to retry", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { transport } = transportFor((request) => {
      if (request.action === "backup_create") { if (++attempts === 1) throw { code: "backup_destination_exists" }; return { created: true }; }
      return undefined;
    });
    const { onClose, onMessage } = maintenance(transport, "backup", "en");
    await user.type(screen.getByLabelText("Master password", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "Choose location and back up" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("destination already exists");
    expect(screen.getByRole("button", { name: "Choose location and back up" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled(); expect(onMessage).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Master password", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "Choose location and back up" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("Restoring it requires its original master password"));
  });

  it("cannot submit a real backup from browser demo even through the form", async () => {
    const user = userEvent.setup();
    const { transport, calls } = transportFor(() => undefined);
    const { onClose } = maintenance(transport, "backup", "en", true);
    expect(screen.getByText(/browser demo cannot create real encrypted backups/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Master password", { exact: true }), master);
    fireEvent.submit(screen.getByLabelText("Master password", { exact: true }).closest("form")!);
    expect(screen.getByRole("button", { name: "Choose location and back up" })).toBeDisabled();
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("maintenance embedded in credential settings", () => {
  it("updates settings after a real backup and a later password change without creating another vault", async () => {
    const user = userEvent.setup();
    let current = state({ locked: false });
    const { transport, calls } = transportFor((request) => {
      if (request.action === "status") return current;
      if (request.action === "backup_create") { current = { ...current, lastBackupAt: "2026-10-22T01:00:00Z" }; return { created: true }; }
      if (request.action === "change_password") { current = { ...current, locked: true }; return current; }
      return undefined;
    });
    render(<CredentialSettings transport={transport} language="en" demo={false} onOpenVault={vi.fn()} copyText={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create backup" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Create backup" }));
    await user.type(screen.getByLabelText("Master password", { exact: true }), master);
    await user.click(screen.getByRole("button", { name: "Choose location and back up" }));
    await screen.findByText("Last successful backup: 2026-10-22T01:00:00Z");
    expect(screen.getByRole("status")).toHaveTextContent("Encrypted backup created");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change master password" }));
    await user.type(screen.getByLabelText("Current master password"), master);
    await user.type(screen.getByLabelText("New master password", { exact: true }), nextMaster);
    await user.type(screen.getByLabelText("Confirm new master password"), nextMaster);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByText("Locked; authorization retained");
    expect(screen.getByRole("status")).toHaveTextContent("Master password changed");
    expect(calls.some((request) => request.action === "create" || request.action === "reset_access")).toBe(false);
  });
});
