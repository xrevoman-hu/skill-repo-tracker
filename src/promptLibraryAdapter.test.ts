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
    listPromptTags: vi.fn().mockResolvedValue([]),
    createPromptTag: vi.fn().mockResolvedValue({ id: "tag-1" }),
    renamePromptTag: vi.fn().mockResolvedValue({ id: "tag-1" }),
    mergePromptTags: vi.fn().mockResolvedValue({ id: "tag-2" }),
    deletePromptTag: vi.fn().mockResolvedValue(undefined),
    exportPromptMarkdown: vi.fn().mockResolvedValue({ path: "/tmp/prompt.md", cancelled: false, count: 1, bytes: 10, message: "done" }),
    exportPromptsZip: vi.fn().mockResolvedValue({ path: "/tmp/prompts.zip", cancelled: false, count: 2, bytes: 20, message: "done" }),
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
