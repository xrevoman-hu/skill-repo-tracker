import { describe, expect, it, vi } from "vitest";

import { createPromptLibraryApi } from "./promptLibraryAdapter";

function client() {
  return {
    listPrompts: vi.fn().mockResolvedValue({ items: [] }),
    getPromptDetail: vi.fn().mockResolvedValue({ id: "prompt-1", content: "body" }),
    createPrompt: vi.fn().mockResolvedValue({ id: "created" }),
    updatePrompt: vi.fn().mockResolvedValue({ id: "prompt-1" }),
    deletePrompt: vi.fn().mockResolvedValue(undefined),
    setPromptPinned: vi.fn().mockResolvedValue({ id: "prompt-1" }),
    reorderPrompt: vi.fn().mockResolvedValue({ libraryRevision: 13 }),
    listPromptTags: vi.fn().mockResolvedValue([]),
    createPromptTag: vi.fn().mockResolvedValue({ id: "tag-1" }),
    renamePromptTag: vi.fn().mockResolvedValue({ id: "tag-1" }),
    mergePromptTags: vi.fn().mockResolvedValue({ id: "tag-2" }),
    deletePromptTag: vi.fn().mockResolvedValue(undefined),
    exportPromptMarkdown: vi.fn().mockResolvedValue({ path: "/tmp/prompt.md", cancelled: false, count: 1, bytes: 10, message: "done" }),
    exportPromptsZip: vi.fn().mockResolvedValue({ path: "/tmp/prompts.zip", cancelled: false, count: 2, bytes: 20, message: "done" }),
    previewPromptsZipImport: vi.fn().mockResolvedValue({
      path: "/tmp/shared.zip",
      fileName: "shared.zip",
      cancelled: false,
      sha256: "a".repeat(64),
      sizeBytes: 200,
      expectedLibraryRevision: 12,
      prompts: 4,
      totalContentBytes: 100,
      newPrompts: 2,
      identicalPrompts: 1,
      conflictingPrompts: 1,
      tagsToCreate: 3,
      tagsToReuse: 2,
      conflicts: [],
      valid: true,
      message: "ready",
    }),
    importPromptsZip: vi.fn().mockResolvedValue({
      inserted: 2,
      skippedSame: 1,
      keptLocal: 1,
      overwritten: 0,
      duplicated: 1,
      createdTags: 3,
      reusedTags: 2,
      libraryRevision: 13,
      message: "done",
    }),
  };
}

describe("prompt library view adapter", () => {
  it("maps view CRUD calls to the stable Tauri request shapes", async () => {
    const backend = client();
    const view = createPromptLibraryApi(backend as never);

    await view.getPrompt("prompt-1");
    await view.updatePrompt("prompt-1", 7, {
      title: "Title",
      content: "Body",
      tagIds: ["tag-1"],
      pinned: true,
    });
    await view.setPromptPinned("prompt-1", 8, false);
    await view.deletePrompt("prompt-1", 9);

    expect(backend.getPromptDetail).toHaveBeenCalledWith("prompt-1");
    expect(backend.updatePrompt).toHaveBeenCalledWith({
      id: "prompt-1",
      title: "Title",
      content: "Body",
      tagIds: ["tag-1"],
      pinned: true,
      expectedRevision: 7,
    });
    expect(backend.setPromptPinned).toHaveBeenCalledWith("prompt-1", false, 8);
    expect(backend.deletePrompt).toHaveBeenCalledWith("prompt-1", 9);
  });

  it("passes the mutually exclusive filtered selection through unchanged", async () => {
    const backend = client();
    const view = createPromptLibraryApi(backend as never);
    const selection = {
      mode: "filter" as const,
      filter: {
        query: "research",
        tagIds: ["tag-1"],
        tagMode: "all" as const,
        sort: "updatedDesc" as const,
      },
      excludedIds: ["prompt-3"],
      expectedLibraryRevision: 12,
    };

    const summary = await view.exportPrompts(selection);

    expect(backend.exportPromptsZip).toHaveBeenCalledWith(selection);
    expect(summary).toMatchObject({ cancelled: false, path: "/tmp/prompts.zip" });
  });

  it("passes revisioned prompt reordering through with neighbour anchors", async () => {
    const backend = client();
    const view = createPromptLibraryApi(backend as never);
    const request = {
      id: "prompt-2",
      previousId: "prompt-1",
      nextId: "prompt-3",
      expectedRevision: 5,
      expectedLibraryRevision: 12,
    };

    await expect(view.reorderPrompt(request)).resolves.toEqual({ libraryRevision: 13 });
    expect(backend.reorderPrompt).toHaveBeenCalledWith(request);
  });

  it("maps native prompt ZIP preview and import summaries to the view seam", async () => {
    const backend = client();
    const view = createPromptLibraryApi(backend as never);

    const preview = await view.previewPromptsZipImport();
    expect(preview).toMatchObject({
      path: "/tmp/shared.zip",
      libraryRevision: 12,
      promptCount: 4,
      newCount: 2,
      identicalCount: 1,
      conflictCount: 1,
    });

    const request = {
      path: "/tmp/shared.zip",
      sha256: "a".repeat(64),
      sizeBytes: 200,
      expectedLibraryRevision: 12,
      conflictStrategy: "duplicate" as const,
    };
    const result = await view.importPromptsZip(request);

    expect(backend.importPromptsZip).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({
      inserted: 2,
      skipped: 2,
      duplicated: 1,
      tagsCreated: 3,
      tagsReused: 2,
    });
  });

  it("maps a cancelled native ZIP picker to no preview", async () => {
    const backend = client();
    backend.previewPromptsZipImport.mockResolvedValue({
      ...await backend.previewPromptsZipImport(),
      cancelled: true,
      path: null,
    });
    const view = createPromptLibraryApi(backend as never);

    await expect(view.previewPromptsZipImport()).resolves.toBeNull();
  });

  it("returns cancellation summaries from the native save dialog unchanged", async () => {
    const backend = client();
    backend.exportPromptMarkdown.mockResolvedValue({
      path: null,
      cancelled: true,
      count: 0,
      bytes: 0,
      message: "cancelled",
    });
    const view = createPromptLibraryApi(backend as never);

    await expect(view.exportPrompt("prompt-1")).resolves.toMatchObject({ cancelled: true });
  });
});
