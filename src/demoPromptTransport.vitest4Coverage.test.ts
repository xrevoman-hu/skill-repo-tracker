import { describe, expect, it } from "vitest";
import type { PromptListRequest, PromptZipImportPreview, PromptZipImportRequest } from "./api";
import { DemoPromptTransport } from "./demoPromptTransport";

const fixedNow = () => new Date("2026-09-05T12:00:00.000Z");

function listRequest(overrides: Partial<PromptListRequest> = {}): PromptListRequest {
  return {
    query: "",
    tagIds: [],
    tagMode: "any",
    sort: "manual",
    page: 1,
    pageSize: 30,
    ...overrides,
  };
}

function importRequest(
  preview: PromptZipImportPreview,
  conflictStrategy: "keep-local" | "overwrite" | "duplicate",
): PromptZipImportRequest {
  if (!preview.path || !preview.sha256) throw new Error("Demo preview must identify its archive.");
  return {
    path: preview.path,
    sha256: preview.sha256,
    sizeBytes: preview.sizeBytes,
    expectedLibraryRevision: preview.expectedLibraryRevision,
    conflictStrategy,
  };
}

describe("DemoPromptTransport observable state machine", () => {
  it("isolates detail and page tag objects from the stored prompt", async () => {
    const transport = new DemoPromptTransport(fixedNow);
    const detail = await transport.getPromptDetail("demo-prompt-1");
    const originalTagName = detail.tags[0].name;
    detail.tags[0].name = "mutated";
    detail.content = "mutated";
    const page = await transport.listPrompts(listRequest());
    expect(page.items[0].tags[0].name).toBe(originalTagName);
    page.items[0].tags.splice(0);
    const stored = await transport.getPromptDetail(detail.id);
    expect(stored.tags[0].name).toBe(originalTagName);
    expect(stored.content).not.toBe("mutated");
  });

  it("filters by normalized text and any/all tags, sorts updates, and clamps pages", async () => {
    let tick = 0;
    const transport = new DemoPromptTransport(() => new Date(2_000_000_000_000 + tick++ * 1_000));
    const quality = await transport.createPromptTag(" 质量 ");
    const duplicate = await transport.createPromptTag("质量".normalize("NFD"));
    expect(duplicate.id).toBe(quality.id);

    const created = await transport.createPrompt({
      title: "Unicode 发布",
      content: "包含 UNIQUE needle",
      tagIds: [quality.id, "release"],
      pinned: false,
    });
    const byText = await transport.listPrompts(listRequest({ query: "  unique NEEDLE  " }));
    expect(byText.items.map((item) => item.id)).toEqual([created.id]);
    await expect(transport.listPrompts(listRequest({ query: "missing" }))).resolves.toMatchObject({ total: 0, totalPages: 1, page: 1 });
    await expect(transport.listPrompts(listRequest({ tagIds: [quality.id, "release"], tagMode: "all" }))).resolves.toMatchObject({ total: 1 });
    await expect(transport.listPrompts(listRequest({ tagIds: [quality.id, "missing"], tagMode: "all" }))).resolves.toMatchObject({ total: 0 });
    await expect(transport.listPrompts(listRequest({ tagIds: ["missing", "release"], tagMode: "any" }))).resolves.toMatchObject({ total: 2 });

    const updated = await transport.updatePrompt({
      id: created.id,
      title: "Newest",
      content: "# Heading\n\nnew body",
      tagIds: [quality.id],
      pinned: true,
      expectedRevision: created.revision,
    });
    const sorted = await transport.listPrompts(listRequest({ sort: "updatedDesc", page: -10 }));
    expect(sorted.page).toBe(1);
    expect(sorted.items[0]).toMatchObject({ id: updated.id, excerpt: "Heading new body", pinned: true });
    const clamped = await transport.listPrompts(listRequest({ page: 99, pageSize: 30 }));
    expect(clamped.page).toBe(clamped.totalPages);
  });

  it("enforces prompt revisions and propagates tag rename, merge, and delete", async () => {
    const transport = new DemoPromptTransport(fixedNow);
    await expect(transport.getPromptDetail("missing")).rejects.toThrow("Prompt not found");
    await expect(transport.updatePrompt({
      id: "demo-prompt-1",
      title: "stale",
      content: "stale",
      tagIds: [],
      expectedRevision: 99,
    })).rejects.toThrow("Prompt revision changed");

    const createdTag = await transport.createPromptTag("created");
    const created = await transport.createPrompt({ title: "merge me", content: "body", tagIds: [createdTag.id] });
    const renamed = await transport.renamePromptTag(createdTag.id, " renamed ");
    expect(renamed.name).toBe("renamed");
    expect((await transport.getPromptDetail(created.id)).tags[0].name).toBe("renamed");
    await expect(transport.renamePromptTag("missing", "x")).rejects.toThrow("Prompt tag not found");

    const merged = await transport.mergePromptTags(createdTag.id, "research");
    expect(merged.id).toBe("research");
    expect((await transport.getPromptDetail(created.id)).tags.map((tag) => tag.id)).toEqual(["research"]);
    const unused = await transport.createPromptTag("unused");
    await transport.mergePromptTags(unused.id, "release");
    await expect(transport.mergePromptTags("missing", "release")).rejects.toThrow("Prompt tag not found");

    const pinned = await transport.setPromptPinned(created.id, true, created.revision);
    expect(pinned).toMatchObject({ pinned: true, revision: 2 });
    await expect(transport.setPromptPinned(created.id, false, created.revision)).rejects.toThrow("Prompt revision changed");
    await transport.deletePromptTag("research");
    expect((await transport.getPromptDetail(created.id)).tags).toEqual([]);
    await expect(transport.deletePromptTag("missing")).rejects.toThrow("Prompt tag not found");
    await transport.deletePrompt(created.id, pinned.revision);
    await expect(transport.deletePrompt(created.id, pinned.revision)).rejects.toThrow("Prompt not found");
  });

  it("validates reorder generations, boundaries, anchors, groups, and no-op moves", async () => {
    const transport = new DemoPromptTransport(fixedNow);
    const first = await transport.createPrompt({ title: "first", content: "1", tagIds: [], pinned: false });
    const second = await transport.createPrompt({ title: "second", content: "2", tagIds: [], pinned: false });
    const third = await transport.createPrompt({ title: "third", content: "3", tagIds: [], pinned: false });
    const state = await transport.listPrompts(listRequest());

    await expect(transport.reorderPrompt({
      id: first.id, previousId: null, nextId: null, boundary: "first",
      expectedRevision: first.revision, expectedLibraryRevision: 0,
    })).rejects.toThrow("Prompt library changed");
    await expect(transport.reorderPrompt({
      id: first.id, previousId: second.id, nextId: null, boundary: "last",
      expectedRevision: first.revision, expectedLibraryRevision: state.libraryRevision,
    })).rejects.toThrow("boundary cannot have neighbors");
    await expect(transport.reorderPrompt({
      id: first.id, previousId: null, nextId: null,
      expectedRevision: first.revision, expectedLibraryRevision: state.libraryRevision,
    })).rejects.toThrow("needs a target gap");
    await expect(transport.reorderPrompt({
      id: first.id, previousId: first.id, nextId: null,
      expectedRevision: first.revision, expectedLibraryRevision: state.libraryRevision,
    })).rejects.toThrow("cannot anchor itself");
    await expect(transport.reorderPrompt({
      id: first.id, previousId: "demo-prompt-1", nextId: null,
      expectedRevision: first.revision, expectedLibraryRevision: state.libraryRevision,
    })).rejects.toThrow("cannot cross pinned groups");
    await expect(transport.reorderPrompt({
      id: first.id, previousId: third.id, nextId: "demo-prompt-2",
      expectedRevision: first.revision, expectedLibraryRevision: state.libraryRevision,
    })).rejects.toThrow("neighbors changed");

    const moved = await transport.reorderPrompt({
      id: first.id, previousId: third.id, nextId: null,
      expectedRevision: first.revision, expectedLibraryRevision: state.libraryRevision,
    });
    expect(moved.libraryRevision).toBe(state.libraryRevision + 1);
    const afterMove = await transport.listPrompts(listRequest());
    const toLast = await transport.reorderPrompt({
      id: first.id, previousId: null, nextId: null, boundary: "last",
      expectedRevision: first.revision, expectedLibraryRevision: afterMove.libraryRevision,
    });
    expect(toLast.libraryRevision).toBeGreaterThanOrEqual(afterMove.libraryRevision);
    const noOpState = await transport.listPrompts(listRequest());
    const noOp = await transport.reorderPrompt({
      id: first.id, previousId: null, nextId: null, boundary: "last",
      expectedRevision: first.revision, expectedLibraryRevision: noOpState.libraryRevision,
    });
    expect(noOp.libraryRevision).toBe(noOpState.libraryRevision);
  });

  it("exports explicit and filtered selections and rejects stale filtered snapshots", async () => {
    const transport = new DemoPromptTransport(fixedNow);
    const initial = await transport.listPrompts(listRequest());
    await expect(transport.exportPromptsZip({
      mode: "filter",
      filter: listRequest(),
      excludedIds: [],
      expectedLibraryRevision: initial.libraryRevision + 1,
    })).rejects.toThrow("Prompt library changed");

    await expect(transport.exportPromptsZip({ mode: "explicit", ids: ["demo-prompt-1"] })).resolves.toMatchObject({ count: 1 });
    await expect(transport.exportPromptMarkdown("demo-prompt-1")).resolves.toMatchObject({ path: "/tmp/demo-prompt-1.md", count: 1 });
    await expect(transport.exportPromptsZip({
      mode: "filter",
      filter: listRequest({ query: "发布" }),
      excludedIds: ["demo-prompt-1"],
      expectedLibraryRevision: initial.libraryRevision,
    })).resolves.toMatchObject({ count: 1 });
  });

  it("imports new, identical, and conflicting archives under every explicit strategy", async () => {
    const defaultTransport = new DemoPromptTransport(fixedNow);
    const defaultPreview = await defaultTransport.previewPromptsZipImport();
    expect(defaultPreview).toMatchObject({ newPrompts: 1, conflictingPrompts: 0, tagsToReuse: 1 });
    await expect(defaultTransport.importPromptsZip({
      ...importRequest(defaultPreview, "duplicate"),
      expectedLibraryRevision: defaultPreview.expectedLibraryRevision + 1,
    })).rejects.toThrow("Prompt library changed");
    await expect(defaultTransport.importPromptsZip({
      ...importRequest(defaultPreview, "duplicate"),
      sha256: "wrong",
    })).rejects.toThrow("archive identity changed");
    await expect(defaultTransport.importPromptsZip(importRequest(defaultPreview, "duplicate"))).resolves.toMatchObject({ inserted: 1, reusedTags: 1 });

    const identical = new DemoPromptTransport(fixedNow);
    await identical.exportPromptsZip({ mode: "explicit", ids: ["demo-prompt-1"] });
    const identicalPreview = await identical.previewPromptsZipImport();
    expect(identicalPreview.identicalPrompts).toBe(1);
    await expect(identical.importPromptsZip(importRequest(identicalPreview, "duplicate"))).resolves.toMatchObject({ skippedSame: 1 });

    for (const strategy of ["keep-local", "overwrite", "duplicate"] as const) {
      const transport = new DemoPromptTransport(fixedNow);
      await transport.exportPromptsZip({ mode: "explicit", ids: ["demo-prompt-2"] });
      const local = await transport.getPromptDetail("demo-prompt-2");
      await transport.updatePrompt({
        id: local.id,
        title: `local-${strategy}`,
        content: local.content,
        tagIds: local.tags.map((tag) => tag.id),
        pinned: local.pinned,
        expectedRevision: local.revision,
      });
      const preview = await transport.previewPromptsZipImport();
      expect(preview.conflictingPrompts).toBe(1);
      const result = await transport.importPromptsZip(importRequest(preview, strategy));
      expect(result[strategy === "keep-local" ? "keptLocal" : strategy === "overwrite" ? "overwritten" : "duplicated"]).toBe(1);
    }

    const recreateTag = new DemoPromptTransport(fixedNow);
    await recreateTag.exportPromptsZip({ mode: "explicit", ids: ["demo-prompt-1"] });
    await recreateTag.deletePromptTag("research");
    const recreatePreview = await recreateTag.previewPromptsZipImport();
    expect(recreatePreview.tagsToCreate).toBe(1);
    await expect(recreateTag.importPromptsZip(importRequest(recreatePreview, "overwrite"))).resolves.toMatchObject({ createdTags: 1 });
  });
});
