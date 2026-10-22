import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("credential command boundary", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({ ok: true, data: { verified: true } });
  });
  it("passes human identity and optimistic record version through the single registered command", async () => {
    const { api } = await import("./api");
    const request = { action: "verify" as const, recordId: "synthetic-record", expectedVersion: 3, sessionId: "synthetic-session", password: "synthetic-master" };
    await api.credentialRequest(request);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("credential_request", { request });
  });
  it("copies by record field without returning the secret to the frontend", async () => {
    const { api } = await import("./api");
    invoke.mockResolvedValue({ ok: true, data: { copied: true, cleanupAfterSeconds: 30 } });
    const request = { action: "copy_secret" as const, recordId: "synthetic-record", expectedVersion: 3, sessionId: "synthetic-session", field: "password" };
    expect(await api.credentialRequest(request)).toEqual({ copied: true, cleanupAfterSeconds: 30 });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("credential_request", { request });
  });
});
