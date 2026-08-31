import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("prompt library API boundary", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({ ok: true, data: { accepted: true } });
  });

  it("keeps list filters and paging inside one request payload", async () => {
    const { api } = await import("./api");
    const request = {
      page: 2,
      pageSize: 50 as const,
      query: "研究",
      tagIds: ["tag-research", "tag-role"],
      tagMode: "all" as const,
      sort: "updatedDesc" as const,
    };

    await api.listPrompts(request);

    expect(invoke).toHaveBeenCalledWith("list_prompts", { request });
  });

  it("uses optimistic revisions for edit, pin, and delete", async () => {
    const { api } = await import("./api");

    await api.updatePrompt({
      id: "prompt-1",
      title: "Updated",
      content: "body",
      tagIds: ["tag-1"],
      expectedRevision: 3,
    });
    await api.setPromptPinned("prompt-1", true, 4);
    await api.deletePrompt("prompt-1", 5);

    expect(invoke).toHaveBeenNthCalledWith(1, "update_prompt", {
      request: {
        id: "prompt-1",
        title: "Updated",
        content: "body",
        tagIds: ["tag-1"],
        expectedRevision: 3,
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "set_prompt_pinned", {
      request: { id: "prompt-1", pinned: true, expectedRevision: 4 },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "delete_prompt", {
      request: { id: "prompt-1", expectedRevision: 5 },
    });
  });

  it("reorders prompts with revisioned neighbour anchors", async () => {
    const { api } = await import("./api");
    const request = {
      id: "prompt-2",
      previousId: "prompt-1",
      nextId: "prompt-3",
      expectedRevision: 7,
      expectedLibraryRevision: 19,
    };

    await api.reorderPrompt(request);

    expect(invoke).toHaveBeenCalledWith("reorder_prompt", { request });
  });

  it("passes an explicit global group boundary without neighbour anchors", async () => {
    const { api } = await import("./api");
    const request = {
      id: "prompt-2",
      previousId: null,
      nextId: null,
      boundary: "last" as const,
      expectedRevision: 7,
      expectedLibraryRevision: 19,
    };

    await api.reorderPrompt(request);

    expect(invoke).toHaveBeenCalledWith("reorder_prompt", { request });
  });

  it("preserves the mutually exclusive batch selection modes", async () => {
    const { api } = await import("./api");
    const explicit = { mode: "explicit" as const, ids: ["prompt-1", "prompt-2"] };
    const filtered = {
      mode: "filter" as const,
      filter: {
        query: "图像",
        tagIds: ["tag-image"],
        tagMode: "any" as const,
        sort: "updatedDesc" as const,
      },
      excludedIds: ["prompt-9"],
      expectedLibraryRevision: 42,
    };

    await api.exportPromptsZip(explicit);
    await api.exportPromptsZip(filtered);

    expect(invoke).toHaveBeenNthCalledWith(1, "export_prompts_zip", {
      request: { selection: explicit },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "export_prompts_zip", {
      request: { selection: filtered },
    });
  });

  it("keeps legacy v1 migration as the default and opts into v2 prompts explicitly", async () => {
    const { api } = await import("./api");

    await api.exportMigrationPackage();
    await api.exportMigrationPackage(true);

    expect(invoke).toHaveBeenNthCalledWith(1, "export_migration_package", {
      request: { includePrompts: false },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "export_migration_package", {
      request: { includePrompts: true },
    });
  });

  it("preflights a selected migration package before importing with an explicit conflict policy", async () => {
    const { api } = await import("./api");
    invoke.mockResolvedValue({ ok: true, data: {} });

    await api.previewPromptMigrationPackage();
    await api.importMigrationPackage(
      "/private/tmp/demo.srtmigration",
      "duplicate",
      "a".repeat(64),
      1234,
    );

    expect(invoke).toHaveBeenNthCalledWith(1, "preview_prompt_migration_package", {});
    expect(invoke).toHaveBeenNthCalledWith(2, "import_migration_package", {
      request: {
        path: "/private/tmp/demo.srtmigration",
        conflictStrategy: "duplicate",
        expectedPackageSha256: "a".repeat(64),
        expectedPackageSizeBytes: 1234,
      },
    });
  });

  it("keeps prompt sharing ZIP import separate from full-library migration", async () => {
    const { api } = await import("./api");

    await api.previewPromptsZipImport();
    await api.importPromptsZip({
      path: "/private/tmp/shared-prompts.zip",
      sha256: "b".repeat(64),
      sizeBytes: 4567,
      expectedLibraryRevision: 23,
      conflictStrategy: "duplicate",
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "preview_prompts_zip_import", {});
    expect(invoke).toHaveBeenNthCalledWith(2, "import_prompts_zip", {
      request: {
        path: "/private/tmp/shared-prompts.zip",
        sha256: "b".repeat(64),
        sizeBytes: 4567,
        expectedLibraryRevision: 23,
        conflictStrategy: "duplicate",
      },
    });
  });

  it("localizes key prompt and migration error codes in English without dropping details", async () => {
    const { localizedApiErrorMessage } = await import("./api");
    const promptError = Object.assign(new Error("中文提示"), {
      code: "prompt_revision_conflict",
      details: "expected=2, actual=3",
    });
    const migrationError = Object.assign(new Error("迁移包已变化"), {
      code: "migration_package_changed_since_preview",
      details: "expected_sha256=aaa, actual_sha256=bbb",
    });

    expect(localizedApiErrorMessage(promptError, "en", "Fallback")).toBe(
      "This prompt changed in another operation. Reload it and try again. (expected=2, actual=3)",
    );
    expect(localizedApiErrorMessage(migrationError, "en", "Fallback")).toBe(
      "The migration package changed after preview. Preview it again before importing. (expected_sha256=aaa, actual_sha256=bbb)",
    );
    expect(localizedApiErrorMessage(Object.assign(new Error("提示词数量过多"), {
      code: "prompt_migration_too_many_prompts",
      details: "limit=100000, actual=100001",
    }), "en", "Fallback")).toBe(
      "The migration package contains too many prompts. (limit=100000, actual=100001)",
    );
    expect(localizedApiErrorMessage(Object.assign(new Error("旧版 ZIP 不支持"), {
      code: "prompt_zip_legacy_unsupported",
    }), "en", "Fallback")).toBe(
      "This manifest-less prompt ZIP is from an older export and cannot be imported.",
    );
    expect(localizedApiErrorMessage(Object.assign(new Error("标签数量过多"), {
      code: "prompt_zip_too_many_tags",
    }), "en", "Fallback")).toBe(
      "The prompt ZIP contains too many unique tags.",
    );
    expect(localizedApiErrorMessage(Object.assign(new Error("元数据过大"), {
      code: "prompt_zip_metadata_too_large",
    }), "en", "Fallback")).toBe(
      "The prompt ZIP contains too much retained metadata.",
    );
    expect(localizedApiErrorMessage(Object.assign(new Error("排序已漂移"), {
      code: "prompt_reorder_drift",
    }), "en", "Fallback")).toBe(
      "The prompt library changed while reordering. Refresh and try again.",
    );
    expect(localizedApiErrorMessage(Object.assign(new Error("排序请求无效"), {
      code: "prompt_reorder_invalid_request",
    }), "en", "Fallback")).toBe(
      "The requested prompt position is invalid. Try moving it again.",
    );
  });
});
