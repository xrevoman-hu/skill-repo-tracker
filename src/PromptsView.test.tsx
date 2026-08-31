import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PromptsView,
  type PromptDetail,
  type PromptLibraryApi,
  type PromptPage,
  type PromptSelection,
  type PromptSummary,
  type PromptTag,
} from "./PromptsView";
import type { PromptExportSummary } from "./api";

const tags: PromptTag[] = [
  { id: "research", name: "研究", promptCount: 1, createdAt: "2026-08-20", updatedAt: "2026-08-20" },
  { id: "writing", name: "写作", promptCount: 1, createdAt: "2026-08-20", updatedAt: "2026-08-20" },
];

const summaries: PromptSummary[] = [
  {
    id: "prompt-one",
    title: "深度研究问题拆解",
    excerpt: "把复杂研究问题拆解为可执行的子问题。",
    tags: [tags[0]],
    pinned: true,
    contentBytes: 44,
    createdAt: "2026-08-20T09:00:00+08:00",
    updatedAt: "2026-08-30T14:20:00+08:00",
    revision: 3,
  },
  {
    id: "prompt-two",
    title: "论文写作大纲",
    excerpt: "生成论文大纲。",
    tags: [tags[1]],
    pinned: false,
    contentBytes: 24,
    createdAt: "2026-08-21T09:00:00+08:00",
    updatedAt: "2026-08-29T14:20:00+08:00",
    revision: 1,
  },
];

const details: Record<string, PromptDetail> = {
  "prompt-one": {
    ...summaries[0],
    content: "# 工作步骤\n\n1. 明确研究范围。\n2. 拆解核心问题。",
  },
  "prompt-two": {
    ...summaries[1],
    content: "# 论文大纲\n\n- 引言\n- 正文",
  },
};

function page(items = summaries): PromptPage {
  return {
    items,
    page: 1,
    pageSize: 30,
    total: items.length,
    totalPages: 1,
    libraryRevision: 9,
  };
}

function api(overrides: Partial<PromptLibraryApi> = {}): PromptLibraryApi {
  const exported = (path: string, count: number): PromptExportSummary => ({
    path,
    cancelled: false,
    count,
    bytes: 128,
    message: "done",
  });
  return {
    listPrompts: vi.fn().mockResolvedValue(page()),
    getPrompt: vi.fn(async (id) => details[id]),
    createPrompt: vi.fn(async (input) => ({
      ...summaries[1],
      id: "created",
      title: input.title,
      content: input.content,
      tags: tags.filter((tag) => input.tagIds.includes(tag.id)),
      pinned: input.pinned,
    })),
    updatePrompt: vi.fn(async (id, revision, input) => ({
      ...details[id],
      ...input,
      revision: revision + 1,
      tags: tags.filter((tag) => input.tagIds.includes(tag.id)),
    })),
    deletePrompt: vi.fn().mockResolvedValue(undefined),
    setPromptPinned: vi.fn(async (id, revision, pinned) => ({
      ...summaries.find((prompt) => prompt.id === id)!,
      revision: revision + 1,
      pinned,
    })),
    reorderPrompt: vi.fn().mockResolvedValue({ libraryRevision: 10 }),
    listTags: vi.fn().mockResolvedValue(tags),
    createTag: vi.fn(async (name) => ({ id: name, name, promptCount: 0, createdAt: "2026-08-20", updatedAt: "2026-08-20" })),
    renameTag: vi.fn(async (id, name) => ({ id, name, promptCount: 0, createdAt: "2026-08-20", updatedAt: "2026-08-20" })),
    mergeTags: vi.fn(async (_sourceId, targetId) => tags.find((tag) => tag.id === targetId)!),
    deleteTag: vi.fn().mockResolvedValue(undefined),
    exportPrompt: vi.fn().mockResolvedValue(exported("/tmp/prompt.md", 1)),
    exportPrompts: vi.fn().mockResolvedValue(exported("/tmp/prompts.zip", 2)),
    previewPromptsZipImport: vi.fn().mockResolvedValue(null),
    importPromptsZip: vi.fn().mockResolvedValue({
      inserted: 0,
      skipped: 0,
      duplicated: 0,
      overwritten: 0,
      tagsCreated: 0,
      tagsReused: 0,
      libraryRevision: 10,
      message: "done",
    }),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe("PromptsView", () => {
  it("shows zero, one, or up to five card tags and always preserves the +N badge", async () => {
    const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        if (!this.classList?.contains("prompt-card-tags")) return 0;
        return this.closest("article")?.getAttribute("aria-label") === "标签数量 20" ? 120 : 320;
      },
    });
    const makeTags = (count: number, long = false): PromptTag[] => Array.from({ length: count }, (_, index) => ({
      id: `tag-${count}-${index}`,
      name: long ? `非常非常长的标签名称-${index}` : `标签${index + 1}`,
      promptCount: 1,
      createdAt: "2026-08-20",
      updatedAt: "2026-08-20",
    }));
    const counts = [0, 1, 5, 6, 20];
    const items = counts.map((count, index): PromptSummary => ({
      ...summaries[1],
      id: `tags-${count}`,
      title: `标签数量 ${count}`,
      tags: makeTags(count, count === 20),
      revision: index + 1,
    }));

    try {
      render(<PromptsView api={api({ listPrompts: vi.fn().mockResolvedValue(page(items)) })} language="zh" />);
      await screen.findByText("找到 5 个提示词");

      const visibleItems = (count: number) => screen
        .getByRole("article", { name: `标签数量 ${count}` })
        .querySelector<HTMLElement>(".prompt-card-tag-items")!;
      expect(visibleItems(0).children).toHaveLength(0);
      expect(visibleItems(1).children).toHaveLength(1);
      expect(visibleItems(5).querySelector(".prompt-tag-more")).not.toBeInTheDocument();
      expect(visibleItems(5).children).toHaveLength(5);
      expect(visibleItems(6).querySelector(".prompt-tag-more")).toHaveTextContent("+1");
      expect(visibleItems(6).querySelectorAll(".prompt-tag:not(.prompt-tag-more)").length).toBeLessThanOrEqual(5);
      expect(visibleItems(20).querySelector(".prompt-tag-more")).toHaveTextContent(/^\+\d+$/);
      expect(visibleItems(20).querySelector(".prompt-tag-more")).toBeVisible();
      expect(visibleItems(20).querySelectorAll(".prompt-tag:not(.prompt-tag-more)").length).toBeLessThan(5);
    } finally {
      if (clientWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
      }
    }
  });

  it("marks an overflowing six-line summary so the UI can render a stable ellipsis", async () => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() { return this.classList?.contains("prompt-card-summary") ? 120 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return this.classList?.contains("prompt-card-summary") ? 60 : 0; },
    });

    try {
      render(<PromptsView api={api()} language="zh" />);
      const card = await screen.findByRole("article", { name: "深度研究问题拆解" });
      const summary = card.querySelector(".prompt-card-summary");
      await waitFor(() => expect(summary).toHaveAttribute("data-truncated", "true"));
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
      }
    }
  });

  it("keeps card actions isolated and opens details read-only before editing", async () => {
    const user = userEvent.setup();
    const client = api();
    const copyText = vi.fn().mockResolvedValue(undefined);
    render(<PromptsView api={client} copyText={copyText} language="zh" />);

    const card = await screen.findByRole("article", { name: "深度研究问题拆解" });
    await user.click(within(card).getByRole("button", { name: "复制：深度研究问题拆解" }));

    expect(client.getPrompt).toHaveBeenCalledWith("prompt-one");
    expect(copyText).toHaveBeenCalledWith(details["prompt-one"].content);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "取消置顶：深度研究问题拆解" }));
    expect(client.setPromptPinned).toHaveBeenCalledWith("prompt-one", 3, false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(card);
    const drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    expect(within(drawer).queryByRole("textbox", { name: "正文" })).not.toBeInTheDocument();
    expect(within(drawer).getByText("工作步骤")).toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "编辑" }));
    expect(within(drawer).getByRole("textbox", { name: "正文" })).toHaveValue(details["prompt-one"].content);
  });

  it("opens a card with Enter or Space but ignores keyboard events from nested controls", async () => {
    const client = api();
    render(<PromptsView api={client} language="en" />);

    const firstCard = await screen.findByRole("article", { name: "深度研究问题拆解" });
    const checkbox = within(firstCard).getByRole("checkbox", { name: "Select: 深度研究问题拆解" });
    const pinButton = within(firstCard).getByRole("button", { name: "Unpin: 深度研究问题拆解" });
    const copyButton = within(firstCard).getByRole("button", { name: "Copy: 深度研究问题拆解" });

    fireEvent.keyDown(checkbox, { key: " " });
    fireEvent.keyDown(pinButton, { key: "Enter" });
    fireEvent.keyDown(copyButton, { key: " " });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.getPrompt).not.toHaveBeenCalled();

    fireEvent.keyDown(firstCard, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "深度研究问题拆解" })).toBeInTheDocument();
  });

  it("keeps the open drawer revision current after changing its pinned state", async () => {
    const user = userEvent.setup();
    const client = api();
    render(<PromptsView api={client} confirmExport={vi.fn().mockResolvedValue(true)} language="zh" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    await user.click(within(drawer).getByRole("button", { name: "取消置顶：深度研究问题拆解" }));
    await user.click(within(drawer).getByRole("button", { name: "编辑" }));
    await user.type(within(drawer).getByRole("textbox", { name: "标题" }), "（新）");
    await user.click(within(drawer).getByRole("button", { name: "保存" }));

    expect(client.updatePrompt).toHaveBeenCalledWith(
      "prompt-one",
      4,
      expect.objectContaining({ pinned: false }),
    );
  });

  it("ignores stale detail responses when cards are opened in quick succession", async () => {
    const first = deferred<PromptDetail>();
    const second = deferred<PromptDetail>();
    const getPrompt = vi.fn((id: string) => id === "prompt-one" ? first.promise : second.promise);
    render(<PromptsView api={api({ getPrompt })} language="zh" />);

    fireEvent.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    await waitFor(() => expect(getPrompt).toHaveBeenCalledWith("prompt-one"));
    fireEvent.click(screen.getByRole("article", { name: "论文写作大纲" }));
    await waitFor(() => expect(getPrompt).toHaveBeenCalledWith("prompt-two"));

    second.resolve(details["prompt-two"]);
    expect(await screen.findByRole("dialog", { name: "论文写作大纲" })).toBeInTheDocument();
    first.resolve(details["prompt-one"]);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "论文写作大纲" })).toBeInTheDocument();
      expect(screen.getByText("论文大纲")).toBeInTheDocument();
      expect(screen.queryByText("工作步骤")).not.toBeInTheDocument();
    });
  });

  it("does not let a delayed pin response for A mutate the drawer later opened for B", async () => {
    const pin = deferred<PromptSummary>();
    const client = api({ setPromptPinned: vi.fn(() => pin.promise) });
    const user = userEvent.setup();
    render(<PromptsView api={client} confirmExport={vi.fn().mockResolvedValue(true)} language="en" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const firstDrawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    await user.click(within(firstDrawer).getByRole("button", { name: "Unpin: 深度研究问题拆解" }));
    await user.click(screen.getByRole("article", { name: "论文写作大纲" }));
    const secondDrawer = await screen.findByRole("dialog", { name: "论文写作大纲" });

    pin.resolve({ ...summaries[0], pinned: false, revision: 4 });
    await waitFor(() => expect(client.setPromptPinned).toHaveBeenCalledTimes(1));
    expect(within(secondDrawer).getByRole("heading", { name: "论文写作大纲" })).toBeInTheDocument();
    expect(within(secondDrawer).queryByText("Pinned")).not.toBeInTheDocument();

    await user.click(within(secondDrawer).getByRole("button", { name: "Edit" }));
    expect(within(secondDrawer).getByRole("textbox", { name: "Title" })).toHaveValue("论文写作大纲");
  });

  it("does not let a delayed delete for A close or contaminate the drawer later opened for B", async () => {
    const deletion = deferred<void>();
    const client = api({ deletePrompt: vi.fn(() => deletion.promise) });
    const user = userEvent.setup();
    render(
      <PromptsView
        api={client}
        confirmAction={vi.fn().mockResolvedValue(true)}
        language="en"
      />,
    );

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete prompt" }));
    await waitFor(() => expect(client.deletePrompt).toHaveBeenCalledWith("prompt-one", 3));
    await user.click(screen.getByRole("article", { name: "论文写作大纲" }));
    expect(await screen.findByRole("dialog", { name: "论文写作大纲" })).toBeInTheDocument();

    deletion.resolve();
    await waitFor(() => expect(client.deletePrompt).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "论文写作大纲" })).toBeInTheDocument();
  });

  it("surfaces delete conflicts in the read-only drawer", async () => {
    const conflict = Object.assign(new Error("提示词已被其他操作修改。"), {
      code: "prompt_revision_conflict",
      details: "expected=3, actual=4",
    });
    const client = api({ deletePrompt: vi.fn().mockRejectedValue(conflict) });
    const user = userEvent.setup();
    render(
      <PromptsView
        api={client}
        confirmAction={vi.fn().mockResolvedValue(true)}
        language="en"
      />,
    );

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    await user.click(within(drawer).getByRole("button", { name: "Delete prompt" }));

    const alert = await within(drawer).findByRole("alert");
    expect(alert).toHaveTextContent("This prompt changed in another operation");
    expect(alert).toHaveTextContent("expected=3, actual=4");
    expect(within(drawer).queryByRole("textbox", { name: "Content" })).not.toBeInTheDocument();
  });

  it("keeps all detail tags in a wrapping drawer container", async () => {
    const manyTags: PromptTag[] = Array.from({ length: 20 }, (_, index) => ({
      id: `tag-${index + 1}`,
      name: `Tag ${index + 1}`,
      promptCount: 1,
      createdAt: "2026-08-20",
      updatedAt: "2026-08-20",
    }));
    const summary = { ...summaries[0], tags: manyTags };
    const detail = { ...details["prompt-one"], tags: manyTags };
    const client = api({
      listPrompts: vi.fn().mockResolvedValue(page([summary])),
      getPrompt: vi.fn().mockResolvedValue(detail),
      listTags: vi.fn().mockResolvedValue(manyTags),
    });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    const tagContainer = drawer.querySelector(".prompt-drawer-tags");
    expect(tagContainer).toHaveClass("prompt-drawer-tags");
    expect(tagContainer?.querySelectorAll(".prompt-tag")).toHaveLength(20);
  });

  it("does not start deleting A when its asynchronous confirmation resolves after switching to B", async () => {
    const confirmation = deferred<boolean>();
    const client = api();
    const user = userEvent.setup();
    render(
      <PromptsView
        api={client}
        confirmAction={vi.fn(() => confirmation.promise)}
        language="en"
      />,
    );

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete prompt" }));
    await user.click(screen.getByRole("article", { name: "论文写作大纲" }));
    expect(await screen.findByRole("dialog", { name: "论文写作大纲" })).toBeInTheDocument();

    await act(async () => {
      confirmation.resolve(true);
      await confirmation.promise;
    });
    expect(client.deletePrompt).not.toHaveBeenCalled();
  });

  it("blocks drawer switching while a save is in flight and applies the response only to its target", async () => {
    const save = deferred<PromptDetail>();
    const confirmDiscard = vi.fn().mockResolvedValue(true);
    const client = api({ updatePrompt: vi.fn(() => save.promise) });
    const user = userEvent.setup();
    render(<PromptsView api={client} confirmDiscard={confirmDiscard} language="en" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    await user.click(within(drawer).getByRole("button", { name: "Edit" }));
    await user.type(within(drawer).getByRole("textbox", { name: "Title" }), " updated");
    await user.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.updatePrompt).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("article", { name: "论文写作大纲" }));
    expect(screen.getByRole("dialog", { name: "深度研究问题拆解" })).toBeInTheDocument();
    expect(confirmDiscard).not.toHaveBeenCalled();

    save.resolve({
      ...details["prompt-one"],
      title: "深度研究问题拆解 updated",
      revision: 4,
    });
    expect(await screen.findByRole("dialog", { name: "深度研究问题拆解 updated" })).toBeInTheDocument();
  });

  it("guards dirty edits when closing and restores focus after confirmation", async () => {
    const user = userEvent.setup();
    const confirmDiscard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<PromptsView api={api()} confirmDiscard={confirmDiscard} language="zh" />);

    const card = await screen.findByRole("article", { name: "深度研究问题拆解" });
    await user.click(card);
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "编辑" }));
    await user.type(within(drawer).getByRole("textbox", { name: "标题" }), "（修改）");

    await user.click(within(drawer).getByRole("button", { name: "关闭" }));
    expect(confirmDiscard).toHaveBeenCalledWith("close");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(card).toHaveFocus();
  });

  it("dismisses a clean drawer from outside without stealing focus from the clicked control", async () => {
    const user = userEvent.setup();
    render(<PromptsView api={api()} language="en" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    expect(await screen.findByRole("dialog", { name: "深度研究问题拆解" })).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search prompts" });
    await user.click(search);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "深度研究问题拆解" })).not.toBeInTheDocument());
    expect(search).toHaveFocus();
  });

  it("guards dirty outside dismissal and blocks outside actions while saving", async () => {
    const save = deferred<PromptDetail>();
    const confirmDiscard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const client = api({ updatePrompt: vi.fn(() => save.promise) });
    const user = userEvent.setup();
    render(<PromptsView api={client} confirmDiscard={confirmDiscard} language="en" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    let drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    await user.click(within(drawer).getByRole("button", { name: "Edit" }));
    await user.type(within(drawer).getByRole("textbox", { name: "Title" }), " changed");

    const search = screen.getByRole("searchbox", { name: "Search prompts" });
    await user.click(search);
    expect(confirmDiscard).toHaveBeenLastCalledWith("outside");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(search);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("article", { name: "深度研究问题拆解" }));
    drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    await user.click(within(drawer).getByRole("button", { name: "Edit" }));
    await user.type(within(drawer).getByRole("textbox", { name: "Title" }), " pending");
    await user.click(within(drawer).getByRole("button", { name: "Save" }));
    await user.click(search);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("This prompt is being saved. Wait for it to finish before switching.")).toBeInTheDocument();

    save.resolve({ ...details["prompt-one"], title: "深度研究问题拆解 pending", revision: 4 });
  });

  it("keeps the editor open and surfaces an optimistic revision conflict", async () => {
    const user = userEvent.setup();
    const client = api({
      updatePrompt: vi.fn().mockRejectedValue(new Error("提示词已在其他窗口修改，请重新加载后再保存。")),
    });
    render(<PromptsView api={client} language="zh" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    await user.click(within(drawer).getByRole("button", { name: "编辑" }));
    await user.type(within(drawer).getByRole("textbox", { name: "标题" }), "（冲突）");
    await user.click(within(drawer).getByRole("button", { name: "保存" }));

    expect(await within(drawer).findByRole("alert")).toHaveTextContent("已在其他窗口修改");
    expect(within(drawer).getByRole("textbox", { name: "正文" })).toBeInTheDocument();
  });

  it("localizes coded prompt errors in English and preserves backend details", async () => {
    const user = userEvent.setup();
    const conflict = Object.assign(new Error("提示词已被其他操作修改。"), {
      code: "prompt_revision_conflict",
      details: "expected=3, actual=4",
    });
    const client = api({ updatePrompt: vi.fn().mockRejectedValue(conflict) });
    render(<PromptsView api={client} language="en" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Edit" }));
    await user.type(within(drawer).getByRole("textbox", { name: "Title" }), " changed");
    await user.click(within(drawer).getByRole("button", { name: "Save" }));

    const alert = await within(drawer).findByRole("alert");
    expect(alert).toHaveTextContent("This prompt changed in another operation");
    expect(alert).toHaveTextContent("expected=3, actual=4");
    expect(alert).not.toHaveTextContent("提示词已被其他操作修改");
  });

  it("debounces search, resets selection on filters, and supports filtered-result export", async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = api();
    render(<PromptsView api={client} confirmExport={vi.fn().mockResolvedValue(true)} language="zh" />);

    await screen.findByText("找到 2 个提示词");
    await user.click(screen.getByRole("checkbox", { name: "选择：深度研究问题拆解" }));
    expect(screen.getByText("已选择 1 项")).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "搜索提示词" });
    await user.type(search, "研究");
    await vi.advanceTimersByTimeAsync(260);
    await waitFor(() => {
      expect(client.listPrompts).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, pageSize: 30, query: "研究" }),
        expect.any(AbortSignal),
      );
    });
    expect(screen.queryByText("已选择 1 项")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "全选当前筛选结果" }));
    await user.click(screen.getByRole("button", { name: "批量导出" }));
    expect(client.exportPrompts).toHaveBeenCalledWith({
      mode: "filter",
      filter: expect.objectContaining({ query: "研究", sort: "manual" }),
      excludedIds: [],
      expectedLibraryRevision: 9,
    } satisfies PromptSelection);
    vi.useRealTimers();
  });

  it("switches tag match mode and offers only 30, 50, and 100 page sizes", async () => {
    const user = userEvent.setup();
    const client = api();
    render(<PromptsView api={client} language="en" />);
    await screen.findByText("2 prompts found");

    const pageSize = screen.getByRole("combobox", { name: "Items per page" });
    expect(Array.from(pageSize.querySelectorAll("option"), (option) => option.value)).toEqual(["30", "50", "100"]);
    await user.selectOptions(pageSize, "50");
    expect(client.listPrompts).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 50 }),
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole("button", { name: "Any selected tag" }));
    expect(client.listPrompts).toHaveBeenLastCalledWith(
      expect.objectContaining({ tagMode: "any" }),
      expect.any(AbortSignal),
    );
  });

  it("keeps explicit selections across pages and exports their stable IDs", async () => {
    const third: PromptSummary = {
      ...summaries[1],
      id: "prompt-three",
      title: "访谈提纲",
      excerpt: "生成半结构化访谈提纲。",
    };
    const listPrompts = vi.fn(async (request) => ({
      ...page(request.page === 1 ? [summaries[0]] : [third]),
      page: request.page,
      total: 31,
      totalPages: 2,
      libraryRevision: 12,
    }));
    const client = api({ listPrompts });
    const user = userEvent.setup();
    render(<PromptsView api={client} confirmExport={vi.fn().mockResolvedValue(true)} language="en" />);

    await user.click(await screen.findByRole("checkbox", { name: "Select: 深度研究问题拆解" }));
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.click(await screen.findByRole("checkbox", { name: "Select: 访谈提纲" }));

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Batch export" }));
    expect(client.exportPrompts).toHaveBeenCalledWith({
      mode: "explicit",
      ids: ["prompt-one", "prompt-three"],
    });
  });

  it("creates through the same drawer and reports dirty state to the host", async () => {
    const user = userEvent.setup();
    const client = api();
    const onDirtyChange = vi.fn();
    render(<PromptsView api={client} language="en" onDirtyChange={onDirtyChange} />);

    await screen.findByRole("heading", { name: "Prompt Library" });
    await user.click(screen.getByRole("button", { name: "New prompt" }));
    const drawer = screen.getByRole("dialog", { name: "Create prompt" });
    await user.type(within(drawer).getByRole("textbox", { name: "Title" }), "New role prompt");
    await user.type(within(drawer).getByRole("textbox", { name: "Content" }), "You are a careful reviewer.");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await user.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(client.createPrompt).toHaveBeenCalledWith({
      title: "New role prompt",
      content: "You are a careful reviewer.",
      pinned: false,
      tagIds: [],
    });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("counts prompt-title limits by Unicode code points instead of UTF-16 units", async () => {
    const user = userEvent.setup();
    const client = api();
    render(<PromptsView api={client} language="en" />);

    await user.click(await screen.findByRole("button", { name: "New prompt" }));
    let drawer = screen.getByRole("dialog", { name: "Create prompt" });
    let title = within(drawer).getByRole("textbox", { name: "Title" });
    expect(title).not.toHaveAttribute("maxlength");
    await user.type(title, "😀".repeat(200));
    await user.type(within(drawer).getByRole("textbox", { name: "Content" }), "body");
    expect(title).toHaveValue("😀".repeat(200));
    await user.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(client.createPrompt).toHaveBeenCalledWith(expect.objectContaining({
      title: "😀".repeat(200),
    }));

    await user.click(screen.getByRole("button", { name: "New prompt" }));
    drawer = screen.getByRole("dialog", { name: "Create prompt" });
    title = within(drawer).getByRole("textbox", { name: "Title" });
    await user.type(title, "😀".repeat(201));
    await user.type(within(drawer).getByRole("textbox", { name: "Content" }), "body");
    await user.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("must not exceed 200 characters");
    expect(client.createPrompt).toHaveBeenCalledTimes(1);
  });

  it("counts new and renamed tag limits by Unicode code points", async () => {
    const user = userEvent.setup();
    const client = api();
    render(<PromptsView api={client} language="en" />);

    await user.click(await screen.findByRole("button", { name: "Manage tags" }));
    const newTag = screen.getByRole("textbox", { name: "Tag name" });
    expect(newTag).not.toHaveAttribute("maxlength");
    await user.type(newTag, "😀".repeat(50));
    expect(newTag).toHaveValue("😀".repeat(50));
    await user.click(screen.getByRole("button", { name: "New tag" }));
    expect(client.createTag).toHaveBeenCalledWith("😀".repeat(50));

    await user.type(newTag, "😀".repeat(51));
    await user.click(screen.getByRole("button", { name: "New tag" }));
    expect(client.createTag).toHaveBeenCalledTimes(1);

    await user.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    let rename = screen.getByRole("textbox", { name: "Rename: 研究" });
    expect(rename).not.toHaveAttribute("maxlength");
    await user.clear(rename);
    await user.type(rename, "🧪".repeat(50));
    expect(rename).toHaveValue("🧪".repeat(50));
    await user.click(screen.getByRole("button", { name: "Save tag" }));
    expect(client.renameTag).toHaveBeenCalledWith("research", "🧪".repeat(50));

    await user.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    rename = screen.getByRole("textbox", { name: "Rename: 研究" });
    await user.clear(rename);
    await user.type(rename, "🧪".repeat(51));
    await user.click(screen.getByRole("button", { name: "Save tag" }));
    expect(client.renameTag).toHaveBeenCalledTimes(1);
  });

  it("exposes an anchored searchable tag manager and prevents duplicate create submissions", async () => {
    const created = deferred<PromptTag>();
    const client = api({ createTag: vi.fn(() => created.promise) });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    const trigger = await screen.findByRole("button", { name: "Manage tags" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const manager = screen.getByRole("dialog", { name: "Manage tags" });
    await user.type(within(manager).getByRole("searchbox", { name: "Search managed tags" }), "写");
    expect(within(manager).getByText("写作")).toBeInTheDocument();
    expect(within(manager).queryByText("研究")).not.toBeInTheDocument();

    const name = within(manager).getByRole("textbox", { name: "Tag name" });
    await user.type(name, "角色");
    const create = within(manager).getByRole("button", { name: "New tag" });
    await user.click(create);
    expect(create).toBeDisabled();
    await user.click(create);
    expect(client.createTag).toHaveBeenCalledTimes(1);

    created.resolve({ id: "role", name: "角色", promptCount: 0, createdAt: "2026-08-31", updatedAt: "2026-08-31" });
    await waitFor(() => expect(create).not.toBeDisabled());
  });

  it("replaces a merged tag id atomically in filters, the open detail, and the editor baseline", async () => {
    const merged = { ...tags[1], promptCount: 2 };
    const client = api({
      mergeTags: vi.fn().mockResolvedValue(merged),
      listTags: vi.fn().mockResolvedValueOnce(tags).mockResolvedValue([merged]),
    });
    const confirmAction = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<PromptsView api={client} confirmAction={confirmAction} language="en" />);

    await screen.findByText("2 prompts found");
    const tagFilter = screen.getByText("All tags").closest("details")!;
    await user.click(within(tagFilter).getByText("All tags"));
    await user.click(within(tagFilter).getByText("研究"));

    await user.click(screen.getByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog", { name: "深度研究问题拆解" });
    await user.click(within(drawer).getByRole("button", { name: "Edit" }));

    await user.click(screen.getByRole("button", { name: "Manage tags" }));
    const manager = screen.getByRole("dialog", { name: "Manage tags" });
    const researchRow = within(manager).getByText("研究").closest<HTMLElement>(".prompt-tag-manager-row")!;
    await user.click(within(researchRow).getByRole("button", { name: "Rename" }));
    const rename = within(manager).getByRole("textbox", { name: "Rename: 研究" });
    await user.clear(rename);
    await user.type(rename, "写作");
    await user.click(within(manager).getByRole("button", { name: "Save tag" }));

    expect(client.mergeTags).toHaveBeenCalledWith("research", "writing");
    await waitFor(() => expect(client.listPrompts).toHaveBeenLastCalledWith(
      expect.objectContaining({ tagIds: ["writing"] }),
      expect.any(AbortSignal),
    ));
    expect(within(drawer).getByRole("checkbox", { name: "写作" })).toBeChecked();
    expect(within(drawer).queryByRole("checkbox", { name: "研究" })).not.toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "Cancel" }));
    expect(within(drawer).getByText("写作")).toBeInTheDocument();
  });

  it("clears a deleted tag from filters and an open prompt draft", async () => {
    const client = api({ listTags: vi.fn().mockResolvedValueOnce(tags).mockResolvedValue([]) });
    const user = userEvent.setup();
    render(<PromptsView api={client} confirmAction={vi.fn().mockResolvedValue(true)} language="en" />);

    await screen.findByText("2 prompts found");
    const tagFilter = screen.getByText("All tags").closest("details")!;
    await user.click(within(tagFilter).getByText("All tags"));
    await user.click(within(tagFilter).getByText("研究"));
    await user.click(screen.getByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Edit" }));

    await user.click(screen.getByRole("button", { name: "Manage tags" }));
    const manager = screen.getByRole("dialog", { name: "Manage tags" });
    await user.click(within(manager).getByRole("button", { name: "Delete tag: 研究" }));

    expect(client.deleteTag).toHaveBeenCalledWith("research");
    await waitFor(() => expect(client.listPrompts).toHaveBeenLastCalledWith(
      expect.objectContaining({ tagIds: [] }),
      expect.any(AbortSignal),
    ));
    expect(within(drawer).queryByRole("checkbox", { name: "研究" })).not.toBeInTheDocument();
  });

  it("clears host dirty state when the prompt view unmounts after a confirmed leave", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const view = render(<PromptsView api={api()} language="en" onDirtyChange={onDirtyChange} />);

    await user.click(await screen.findByRole("button", { name: "New prompt" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Unsaved");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    view.unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("does not announce success when single or batch save dialogs are cancelled", async () => {
    const user = userEvent.setup();
    const cancelled: PromptExportSummary = {
      path: null,
      cancelled: true,
      count: 0,
      bytes: 0,
      message: "cancelled",
    };
    const client = api({
      exportPrompt: vi.fn().mockResolvedValue(cancelled),
      exportPrompts: vi.fn().mockResolvedValue(cancelled),
    });
    render(<PromptsView api={client} confirmExport={vi.fn().mockResolvedValue(true)} language="en" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Export MD" }));
    expect(screen.queryByText("Export completed")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select: 深度研究问题拆解" }));
    await user.click(screen.getByRole("button", { name: "Batch export" }));
    expect(screen.queryByText("Export completed")).not.toBeInTheDocument();
  });

  it("requires explicit plaintext-secret confirmation before single or batch export", async () => {
    const user = userEvent.setup();
    const confirmExport = vi.fn().mockResolvedValue(false);
    const client = api();
    render(<PromptsView api={client} confirmExport={confirmExport} language="en" />);

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Export MD" }));
    expect(confirmExport).toHaveBeenNthCalledWith(1, "single", {
      count: 1,
      title: "深度研究问题拆解",
    });
    expect(client.exportPrompt).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: "Select: 深度研究问题拆解" }));
    await user.click(screen.getByRole("button", { name: "Batch export" }));
    expect(confirmExport).toHaveBeenNthCalledWith(2, "batch", { count: 1 });
    expect(client.exportPrompts).not.toHaveBeenCalled();
    expect(screen.queryByText("Export completed")).not.toBeInTheDocument();
  });

  it("keeps batch import available in the toolbar and the empty state", async () => {
    const client = api({
      listPrompts: vi.fn().mockResolvedValue(page([])),
      previewPromptsZipImport: vi.fn().mockResolvedValue(null),
    });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    await screen.findByText("No prompts yet");
    const importButtons = screen.getAllByRole("button", { name: "Batch import" });
    expect(importButtons).toHaveLength(2);
    expect(importButtons.every((button) => !button.hasAttribute("disabled"))).toBe(true);
    await user.click(importButtons[0]);
    expect(client.previewPromptsZipImport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Import prompt ZIP" })).not.toBeInTheDocument();
  });

  it("previews prompt ZIP conflicts with duplicate as the safe default", async () => {
    const preview = {
      path: "/tmp/shared.zip",
      fileName: "shared.zip",
      sha256: "abc123",
      sizeBytes: 4096,
      libraryRevision: 9,
      promptCount: 3,
      newCount: 1,
      identicalCount: 1,
      conflictCount: 1,
      tagsToCreate: 2,
      tagsToReuse: 4,
      totalContentBytes: 2048,
      conflicts: [{ id: "prompt-one", importedTitle: "导入标题", localTitle: "本机标题" }],
    };
    const client = api({ previewPromptsZipImport: vi.fn().mockResolvedValue(preview) });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    await user.click(await screen.findByRole("button", { name: "Batch import" }));
    const dialog = await screen.findByRole("dialog", { name: "Import prompt ZIP" });
    expect(within(dialog).getByText("shared.zip")).toBeInTheDocument();
    expect(within(dialog).getByText("3 prompts")).toBeInTheDocument();
    expect(within(dialog).getByText("Imported: 导入标题")).toBeInTheDocument();
    expect(within(dialog).getByText("Local: 本机标题")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Conflict strategy" })).toHaveValue("duplicate");
    expect(within(dialog).getByText(/plaintext/i)).toBeInTheDocument();
  });

  it("marks tag-manager and import-dialog motion from the pointer or keyboard source", async () => {
    const preview = {
      path: "/tmp/shared.zip",
      fileName: "shared.zip",
      sha256: "abc123",
      sizeBytes: 4096,
      libraryRevision: 9,
      promptCount: 1,
      newCount: 1,
      identicalCount: 0,
      conflictCount: 0,
      tagsToCreate: 0,
      tagsToReuse: 0,
      totalContentBytes: 128,
      conflicts: [],
    };
    const client = api({ previewPromptsZipImport: vi.fn().mockResolvedValue(preview) });
    render(<PromptsView api={client} language="en" />);

    const tagsButton = await screen.findByRole("button", { name: "Manage tags" });
    fireEvent.click(tagsButton, { detail: 0 });
    expect(screen.getByRole("dialog", { name: "Manage tags" })).toHaveAttribute("data-motion", "instant");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Manage tags" })).getByRole("button", { name: "Close" }));
    fireEvent.click(tagsButton, { detail: 1 });
    expect(screen.getByRole("dialog", { name: "Manage tags" })).toHaveAttribute("data-motion", "pointer");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Manage tags" })).getByRole("button", { name: "Close" }));

    const importButton = screen.getByRole("button", { name: "Batch import" });
    fireEvent.click(importButton, { detail: 0 });
    let dialog = await screen.findByRole("dialog", { name: "Import prompt ZIP" });
    expect(dialog).toHaveAttribute("data-motion", "instant");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(importButton, { detail: 1 });
    dialog = await screen.findByRole("dialog", { name: "Import prompt ZIP" });
    expect(dialog).toHaveAttribute("data-motion", "pointer");
  });

  it("confirms overwrite, imports the preview fingerprint, and refreshes the library", async () => {
    const preview = {
      path: "/tmp/shared.zip",
      fileName: "shared.zip",
      sha256: "abc123",
      sizeBytes: 4096,
      libraryRevision: 9,
      promptCount: 2,
      newCount: 1,
      identicalCount: 0,
      conflictCount: 1,
      tagsToCreate: 1,
      tagsToReuse: 1,
      totalContentBytes: 1024,
      conflicts: [{ id: "prompt-one", importedTitle: "Incoming", localTitle: "Local" }],
    };
    const result = {
      inserted: 1,
      skipped: 0,
      duplicated: 0,
      overwritten: 1,
      tagsCreated: 1,
      tagsReused: 1,
      libraryRevision: 10,
      message: "done",
    };
    const confirmAction = vi.fn().mockResolvedValue(true);
    const client = api({
      previewPromptsZipImport: vi.fn().mockResolvedValue(preview),
      importPromptsZip: vi.fn().mockResolvedValue(result),
    });
    const user = userEvent.setup();
    render(<PromptsView api={client} confirmAction={confirmAction} language="en" />);

    await user.click(await screen.findByRole("checkbox", { name: "Select: 深度研究问题拆解" }));
    await user.click(screen.getByRole("button", { name: "Batch import" }));
    const dialog = await screen.findByRole("dialog", { name: "Import prompt ZIP" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Conflict strategy" }), "overwrite");
    await user.click(within(dialog).getByRole("button", { name: "Import prompts" }));

    expect(confirmAction).toHaveBeenCalledWith("overwrite-import", { title: "shared.zip", target: "1" });
    expect(client.importPromptsZip).toHaveBeenCalledWith({
      path: "/tmp/shared.zip",
      sha256: "abc123",
      sizeBytes: 4096,
      expectedLibraryRevision: 9,
      conflictStrategy: "overwrite",
    });
    expect(await within(dialog).findByText("Import complete")).toBeInTheDocument();
    expect(within(dialog).getByText("1 inserted · 1 overwritten")).toBeInTheDocument();
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    expect(client.listTags).toHaveBeenCalledTimes(2);
  });

  it("switches between recently updated and manual order and gates drag handles while filtered", async () => {
    const manualItems: PromptSummary[] = [
      { ...summaries[0], pinned: false },
      summaries[1],
      { ...summaries[1], id: "prompt-three", title: "第三篇", revision: 2 },
    ];
    const client = api({ listPrompts: vi.fn().mockResolvedValue(page(manualItems)) });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    await screen.findByText("3 prompts found");
    expect(screen.getByRole("button", { name: "Move: 深度研究问题拆解" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Recently updated" }));
    await waitFor(() => expect(client.listPrompts).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "updatedDesc" }),
      expect.any(AbortSignal),
    ));
    expect(screen.getByRole("button", { name: "Move: 深度研究问题拆解" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Manual order" }));
    expect(screen.getByRole("button", { name: "Move: 深度研究问题拆解" })).toBeEnabled();

    await user.type(screen.getByRole("searchbox", { name: "Search prompts" }), "research");
    await waitFor(() => expect(screen.getByRole("button", { name: "Move: 深度研究问题拆解" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Move: 深度研究问题拆解" })).toHaveAttribute(
      "title",
      "Clear search and tag filters to reorder manually",
    );
  });

  it("disables manual reordering for drawers, batch selection, and import work", async () => {
    const preview = deferred<null>();
    const client = api({ previewPromptsZipImport: vi.fn(() => preview.promise) });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    const handle = await screen.findByRole("button", { name: "Move: 深度研究问题拆解" });
    expect(handle).toBeEnabled();

    const selection = screen.getByRole("checkbox", { name: "Select: 深度研究问题拆解" });
    await user.click(selection);
    expect(handle).toBeDisabled();
    await user.click(selection);
    expect(handle).toBeEnabled();

    await user.click(screen.getByRole("article", { name: "深度研究问题拆解" }));
    expect(handle).toBeDisabled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(handle).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Batch import" }));
    expect(handle).toBeDisabled();
    preview.resolve(null);
    await waitFor(() => expect(handle).toBeEnabled());
  });

  it("supports Space and arrow-key reordering with exact same-group anchors and live position", async () => {
    const manualItems: PromptSummary[] = [
      { ...summaries[0], pinned: false },
      summaries[1],
      { ...summaries[1], id: "prompt-three", title: "第三篇", revision: 2 },
    ];
    const client = api({ listPrompts: vi.fn().mockResolvedValue(page(manualItems)) });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    await screen.findByText("3 prompts found");
    await user.click(screen.getByRole("button", { name: "Manual order" }));
    const handle = screen.getByRole("button", { name: "Move: 深度研究问题拆解" });
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(screen.getByText("Moved 深度研究问题拆解 to position 2")).toBeInTheDocument();
    fireEvent.keyDown(handle, { key: " " });

    await waitFor(() => expect(client.reorderPrompt).toHaveBeenCalledWith({
      id: "prompt-one",
      previousId: "prompt-two",
      nextId: "prompt-three",
      expectedRevision: 3,
      expectedLibraryRevision: 9,
    }));
  });

  it("uses a six-pixel pointer threshold and offers group-boundary move commands", async () => {
    const manualItems: PromptSummary[] = [
      { ...summaries[0], pinned: false },
      summaries[1],
      { ...summaries[1], id: "prompt-three", title: "第三篇", revision: 2 },
    ];
    const client = api({ listPrompts: vi.fn().mockResolvedValue(page(manualItems)) });
    const user = userEvent.setup();
    const originalElementFromPoint = document.elementFromPoint;
    const originalPointerEvent = window.PointerEvent;
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    render(<PromptsView api={client} language="en" />);

    await screen.findByText("3 prompts found");
    await user.click(screen.getByRole("button", { name: "Manual order" }));
    const source = screen.getByRole("button", { name: "Move: 深度研究问题拆解" });
    const target = screen.getByRole("article", { name: "论文写作大纲" });
    Object.defineProperty(target, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 100, height: 100, left: 0, right: 100, top: 0, width: 100, x: 0, y: 0, toJSON: () => ({}) }),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });

    fireEvent.pointerDown(source, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(source, { clientX: 4, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(source, { clientX: 4, clientY: 0, pointerId: 1 });
    expect(client.reorderPrompt).not.toHaveBeenCalled();

    fireEvent.pointerDown(source, { clientX: 0, clientY: 0, pointerId: 2 });
    fireEvent.pointerMove(source, { clientX: 80, clientY: 50, pointerId: 2 });
    fireEvent.pointerUp(source, { clientX: 80, clientY: 50, pointerId: 2 });
    await waitFor(() => expect(client.reorderPrompt).toHaveBeenCalledTimes(1));

    vi.mocked(client.reorderPrompt).mockClear();
    await user.click(screen.getByRole("button", { name: "Move options: 第三篇" }));
    await user.click(screen.getByRole("button", { name: "Move to start of group" }));
    await waitFor(() => expect(client.reorderPrompt).toHaveBeenCalledWith(expect.objectContaining({
      id: "prompt-three",
      boundary: "first",
      previousId: null,
      nextId: null,
    })));

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalElementFromPoint,
    });
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
  });

  it("previews affected siblings with interruptible pointer transforms but keeps keyboard movement instant", async () => {
    const manualItems: PromptSummary[] = [
      { ...summaries[0], pinned: false },
      summaries[1],
      { ...summaries[1], id: "prompt-three", title: "第三篇", revision: 2 },
    ];
    const client = api({ listPrompts: vi.fn().mockResolvedValue(page(manualItems)) });
    const originalElementFromPoint = document.elementFromPoint;
    const originalPointerEvent = window.PointerEvent;
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    render(<PromptsView api={client} language="en" />);

    await screen.findByText("3 prompts found");
    const cards = manualItems.map((prompt, index) => {
      const card = screen.getByRole("article", { name: prompt.title });
      Object.defineProperty(card, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ bottom: 100, height: 100, left: index * 110, right: index * 110 + 100, top: 0, width: 100, x: index * 110, y: 0, toJSON: () => ({}) }),
      });
      return card;
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => cards[1] });

    const handle = screen.getByRole("button", { name: "Move: 深度研究问题拆解" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { clientX: 180, clientY: 50 });
    expect(cards[1]).toHaveAttribute("data-drag-shift", "true");
    expect(cards[1].style.getPropertyValue("--prompt-drag-x")).toBe("-110px");
    fireEvent.pointerCancel(handle, { clientX: 180, clientY: 50 });

    fireEvent.keyDown(handle, { key: " " });
    expect(cards[0]).toHaveAttribute("data-drag-input", "keyboard");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(cards.every((card) => !card.hasAttribute("data-drag-shift"))).toBe(true);
    fireEvent.keyDown(handle, { key: "Escape" });

    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalElementFromPoint });
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
  });

  it("excludes the pointer drag source from the successful-drop FLIP", async () => {
    const manualItems: PromptSummary[] = [
      { ...summaries[0], pinned: false },
      summaries[1],
      { ...summaries[1], id: "prompt-three", title: "第三篇", revision: 2 },
    ];
    const client = api({ listPrompts: vi.fn().mockResolvedValue(page(manualItems)) });
    const originalElementFromPoint = document.elementFromPoint;
    const originalPointerEvent = window.PointerEvent;
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    render(<PromptsView api={client} language="en" />);

    await screen.findByText("3 prompts found");
    const cards = manualItems.map((prompt) => {
      const card = screen.getByRole("article", { name: prompt.title });
      Object.defineProperty(card, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          const index = Array.from(card.parentElement?.querySelectorAll(".prompt-card") ?? []).indexOf(card);
          return { bottom: 100, height: 100, left: index * 110, right: index * 110 + 100, top: 0, width: 100, x: index * 110, y: 0, toJSON: () => ({}) };
        },
      });
      return card;
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => cards[1] });

    const handle = within(cards[0]).getByRole("button", { name: "Move: 深度研究问题拆解" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { clientX: 180, clientY: 50 });
    fireEvent.pointerUp(handle, { clientX: 180, clientY: 50 });

    expect(cards[0]).not.toHaveAttribute("data-drop-flip");
    expect(cards[1]).toHaveAttribute("data-drop-flip", "true");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalElementFromPoint });
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
  });

  it("does not rewrite sibling preview transforms while the pointer stays on the same target", async () => {
    const manualItems: PromptSummary[] = [
      { ...summaries[0], pinned: false },
      summaries[1],
      { ...summaries[1], id: "prompt-three", title: "第三篇", revision: 2 },
    ];
    const originalElementFromPoint = document.elementFromPoint;
    const originalPointerEvent = window.PointerEvent;
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    render(<PromptsView api={api({ listPrompts: vi.fn().mockResolvedValue(page(manualItems)) })} language="en" />);

    await screen.findByText("3 prompts found");
    const cards = manualItems.map((prompt, index) => {
      const card = screen.getByRole("article", { name: prompt.title });
      Object.defineProperty(card, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ bottom: 100, height: 100, left: index * 110, right: index * 110 + 100, top: 0, width: 100, x: index * 110, y: 0, toJSON: () => ({}) }),
      });
      return card;
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => cards[1] });
    const handle = within(cards[0]).getByRole("button", { name: "Move: 深度研究问题拆解" });

    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { clientX: 180, clientY: 50 });
    const previewWriteCount = setProperty.mock.calls.filter(([name]) => name === "--prompt-drag-x" || name === "--prompt-drag-y").length;
    expect(previewWriteCount).toBeGreaterThan(0);
    fireEvent.pointerMove(handle, { clientX: 190, clientY: 50 });

    expect(setProperty.mock.calls.filter(([name]) => name === "--prompt-drag-x" || name === "--prompt-drag-y")).toHaveLength(previewWriteCount);
    expect(document.querySelector<HTMLElement>(".prompt-drag-ghost")?.style.transform).toBe("translate3d(190px, 50px, 0)");
    setProperty.mockRestore();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalElementFromPoint });
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
  });

  it("exposes reduced-motion state and skips pointer sibling transforms", async () => {
    const originalMatchMedia = window.matchMedia;
    const originalElementFromPoint = document.elementFromPoint;
    const originalPointerEvent = window.PointerEvent;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    const manualItems: PromptSummary[] = [
      { ...summaries[0], pinned: false },
      summaries[1],
    ];
    render(<PromptsView api={api({ listPrompts: vi.fn().mockResolvedValue(page(manualItems)) })} language="en" />);

    await screen.findByText("2 prompts found");
    expect(document.querySelector(".prompts-view")).toHaveAttribute("data-reduced-motion", "true");
    const source = screen.getByRole("article", { name: "深度研究问题拆解" });
    const target = screen.getByRole("article", { name: "论文写作大纲" });
    [source, target].forEach((card, index) => Object.defineProperty(card, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 100, height: 100, left: index * 110, right: index * 110 + 100, top: 0, width: 100, x: index * 110, y: 0, toJSON: () => ({}) }),
    }));
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    const handle = within(source).getByRole("button", { name: "Move: 深度研究问题拆解" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { clientX: 180, clientY: 50 });
    expect(target).not.toHaveAttribute("data-drag-shift");

    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalElementFromPoint });
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
  });

  it("uses a one-sided neighbor when moving to the start of a later page", async () => {
    const manualItems: PromptSummary[] = [
      { ...summaries[0], id: "page-two-a", title: "第二页甲", pinned: false },
      { ...summaries[1], id: "page-two-b", title: "第二页乙", pinned: false },
    ];
    const pageTwo = { ...page(manualItems), page: 2, pageSize: 30, total: 32, totalPages: 2 };
    const client = api({ listPrompts: vi.fn().mockResolvedValue(pageTwo) });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    await screen.findByText("32 prompts found");
    await user.click(screen.getByRole("button", { name: "Manual order" }));
    const handle = screen.getByRole("button", { name: "Move: 第二页乙" });
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: " " });

    await waitFor(() => expect(client.reorderPrompt).toHaveBeenCalledWith({
      id: "page-two-b",
      previousId: null,
      nextId: "page-two-a",
      expectedRevision: summaries[1].revision,
      expectedLibraryRevision: 9,
    }));
  });

  it("still requests the global group start for the first card on a later page", async () => {
    const manualItems: PromptSummary[] = [
      { ...summaries[0], id: "page-two-a", title: "第二页甲", pinned: false },
      { ...summaries[1], id: "page-two-b", title: "第二页乙", pinned: false },
    ];
    const pageTwo = { ...page(manualItems), page: 2, pageSize: 30, total: 32, totalPages: 2 };
    const client = api({ listPrompts: vi.fn().mockResolvedValue(pageTwo) });
    const user = userEvent.setup();
    render(<PromptsView api={client} language="en" />);

    await screen.findByText("32 prompts found");
    await user.click(screen.getByRole("button", { name: "Manual order" }));
    await user.click(screen.getByRole("button", { name: "Move options: 第二页甲" }));
    await user.click(screen.getByRole("button", { name: "Move to start of group" }));

    await waitFor(() => expect(client.reorderPrompt).toHaveBeenCalledWith({
      id: "page-two-a",
      previousId: null,
      nextId: null,
      boundary: "first",
      expectedRevision: summaries[0].revision,
      expectedLibraryRevision: 9,
    }));
  });

  it("registers a current leave guard for tab and window-close interception", async () => {
    const user = userEvent.setup();
    const confirmDiscard = vi.fn().mockResolvedValue(false);
    let guard: ((context?: "switch") => Promise<boolean>) | undefined;
    const registerLeaveGuard = vi.fn((nextGuard) => {
      guard = nextGuard;
    });
    render(
      <PromptsView
        api={api()}
        confirmDiscard={confirmDiscard}
        language="en"
        registerLeaveGuard={registerLeaveGuard}
      />,
    );

    await user.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Edit" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox", { name: "Title" }), " changed");

    expect(guard).toBeTypeOf("function");
    await expect(guard?.("switch")).resolves.toBe(false);
    expect(confirmDiscard).toHaveBeenCalledWith("switch");
  });

  it("supports empty, loading, and retryable error states", async () => {
    let reject = true;
    const listPrompts = vi.fn(async () => {
      if (reject) throw new Error("database unavailable");
      return page([]);
    });
    const client = api({ listPrompts });
    render(<PromptsView api={client} language="en" />);

    expect(screen.getByText("Loading prompt library…")).toBeInTheDocument();
    expect(await screen.findByText("Couldn’t load prompts")).toBeInTheDocument();
    reject = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No prompts yet")).toBeInTheDocument();
  });

  it("never turns raw HTML, dangerous links, or remote images into active content", async () => {
    const unsafe = {
      ...details["prompt-one"],
      content: '<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![tracking](https://example.com/pixel.png)',
    };
    const client = api({ getPrompt: vi.fn().mockResolvedValue(unsafe) });
    render(<PromptsView api={client} language="en" />);

    fireEvent.click(await screen.findByRole("article", { name: "深度研究问题拆解" }));
    const drawer = await screen.findByRole("dialog");
    expect(drawer.querySelector("script")).not.toBeInTheDocument();
    expect(drawer.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument();
    expect(drawer.querySelector("img")).not.toBeInTheDocument();
    expect(within(drawer).getByText(/Remote image blocked/)).toBeInTheDocument();
  });
});
