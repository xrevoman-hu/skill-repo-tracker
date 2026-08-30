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
    listTags: vi.fn().mockResolvedValue(tags),
    createTag: vi.fn(async (name) => ({ id: name, name, promptCount: 0, createdAt: "2026-08-20", updatedAt: "2026-08-20" })),
    renameTag: vi.fn(async (id, name) => ({ id, name, promptCount: 0, createdAt: "2026-08-20", updatedAt: "2026-08-20" })),
    mergeTags: vi.fn().mockResolvedValue(undefined),
    deleteTag: vi.fn().mockResolvedValue(undefined),
    exportPrompt: vi.fn().mockResolvedValue(exported("/tmp/prompt.md", 1)),
    exportPrompts: vi.fn().mockResolvedValue(exported("/tmp/prompts.zip", 2)),
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
      filter: expect.objectContaining({ query: "研究", sort: "updatedDesc" }),
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
