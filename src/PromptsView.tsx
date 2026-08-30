import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Pencil,
  Pin,
  Plus,
  Search,
  Tag,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { localizedApiErrorMessage } from "./api";

import type {
  PromptDetail,
  PromptExportSummary,
  PromptListFilter,
  PromptListRequest,
  PromptPage,
  PromptPageSize,
  PromptSelection,
  PromptSummary,
  PromptTag,
  PromptTagMode,
} from "./api";

export type {
  PromptDetail,
  PromptListFilter,
  PromptListRequest,
  PromptPage,
  PromptPageSize,
  PromptSelection,
  PromptSummary,
  PromptTag,
  PromptTagMode,
} from "./api";

import "./prompts.css";

export type PromptInput = {
  title: string;
  content: string;
  tagIds: string[];
  pinned: boolean;
};

export type PromptLibraryApi = {
  listPrompts: (request: PromptListRequest, signal?: AbortSignal) => Promise<PromptPage>;
  getPrompt: (id: string) => Promise<PromptDetail>;
  createPrompt: (input: PromptInput) => Promise<PromptDetail>;
  updatePrompt: (id: string, revision: number, input: PromptInput) => Promise<PromptDetail>;
  deletePrompt: (id: string, revision: number) => Promise<void>;
  setPromptPinned: (id: string, revision: number, pinned: boolean) => Promise<PromptSummary>;
  listTags: () => Promise<PromptTag[]>;
  createTag: (name: string) => Promise<PromptTag>;
  renameTag: (id: string, name: string) => Promise<PromptTag>;
  mergeTags: (sourceId: string, targetId: string) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
  exportPrompt: (id: string) => Promise<PromptExportSummary>;
  exportPrompts: (selection: PromptSelection) => Promise<PromptExportSummary>;
};

export type PromptLeaveContext = "cancel" | "close" | "escape" | "switch" | "new";
export type PromptExportKind = "single" | "batch";

type PromptAction = "delete-prompt" | "delete-tag" | "merge-tag";

export type PromptsViewProps = {
  api: PromptLibraryApi;
  language?: "zh" | "en";
  theme?: "light" | "dark" | "system";
  compact?: boolean;
  t?: (key: string, variables?: Record<string, string | number>) => string;
  copyText?: (content: string) => Promise<void> | void;
  openExternal?: (url: string) => Promise<void> | void;
  confirmDiscard?: (context: PromptLeaveContext) => Promise<boolean> | boolean;
  confirmExport?: (
    kind: PromptExportKind,
    details: { count: number; title?: string },
  ) => Promise<boolean> | boolean;
  confirmAction?: (
    action: PromptAction,
    details: { title: string; target?: string },
  ) => Promise<boolean> | boolean;
  onDirtyChange?: (dirty: boolean) => void;
  registerLeaveGuard?: (guard: (context?: PromptLeaveContext) => Promise<boolean>) => void | (() => void);
  onCountsChange?: (counts: { prompts: number; tags: number; filtered: number }) => void;
};

type MessageMap = Record<string, string>;

const copy: Record<"zh" | "en", MessageMap> = {
  zh: {
    add: "新建提示词",
    allTags: "全部标签",
    anyTags: "包含任一",
    allSelectedTags: "包含全部",
    batchExport: "批量导出",
    body: "正文",
    cancel: "取消",
    clearSelection: "清空选择",
    close: "关闭",
    copied: "已复制正文",
    copy: "复制",
    copyPrompt: "复制：{title}",
    create: "创建提示词",
    delete: "删除",
    deletePrompt: "删除提示词",
    edit: "编辑",
    emptyBody: "创建第一篇提示词，把常用角色、研究方法和创作模板集中管理。",
    emptyFilteredBody: "尝试清除搜索词或标签筛选。",
    emptyFilteredTitle: "没有匹配的提示词",
    emptyTitle: "还没有提示词",
    errorBody: "{message}",
    errorTitle: "提示词加载失败",
    exportMd: "导出 MD",
    filteredSelected: "已选择当前筛选结果中的 {count} 项",
    found: "找到 {count} 个提示词",
    itemsPerPage: "每页数量",
    loading: "正在加载提示词库…",
    loadingDetail: "正在加载详情…",
    manageTags: "标签管理",
    markdownHint: "支持 Markdown；正文最多 5 MiB",
    nextPage: "下一页",
    noTags: "暂无标签",
    page: "第 {page} / {pages} 页",
    pin: "置顶：{title}",
    pinned: "已置顶",
    previousPage: "上一页",
    remoteImageBlocked: "远程图片已阻止：{alt}",
    retry: "重试",
    save: "保存",
    saving: "正在保存…",
    saveInProgress: "正在保存当前提示词，请稍候再切换。",
    search: "搜索提示词",
    searchPlaceholder: "搜索标题、正文或标签…",
    select: "选择：{title}",
    selectFiltered: "全选当前筛选结果",
    selectPage: "选择本页",
    selected: "已选择 {count} 项",
    tagName: "标签名称",
    tagSearch: "搜索标签",
    title: "标题",
    titlePlaceholder: "给提示词一个清晰的标题",
    unpin: "取消置顶：{title}",
    updated: "更新于 {date}",
    validationBody: "正文不能为空，且 UTF-8 大小不能超过 5 MiB。",
    validationTags: "每篇最多选择 20 个标签。",
    validationTitle: "标题不能为空，且不能超过 200 个字符。",
    viewFailed: "详情加载失败",
    bytes: "{count} 字节",
    tagCreate: "新增标签",
    tagRename: "重命名",
    tagDelete: "删除标签：{name}",
    tagSave: "保存标签",
    selectionStale: "提示词库已变化，已清除全选筛选结果。",
    operationFailed: "操作失败：{message}",
    promptDeleted: "提示词已删除",
    promptSaved: "提示词已保存",
    exported: "导出任务已完成",
    exportPlaintextConfirmSingle: "提示词正文将逐字、明文导出为 MD；正文中由你粘贴的密码或凭证也会随之导出。请先确认这篇提示词不含不应分享的秘密。继续吗？",
    exportPlaintextConfirmBatch: "所选提示词正文将逐字、明文导出到 ZIP；正文中由你粘贴的密码或凭证也会随之导出。请先确认这些提示词不含不应分享的秘密。继续吗？",
    blockedLink: "已阻止不安全链接",
  },
  en: {
    add: "New prompt",
    allTags: "All tags",
    anyTags: "Any selected tag",
    allSelectedTags: "All selected tags",
    batchExport: "Batch export",
    body: "Content",
    cancel: "Cancel",
    clearSelection: "Clear selection",
    close: "Close",
    copied: "Prompt content copied",
    copy: "Copy",
    copyPrompt: "Copy: {title}",
    create: "Create prompt",
    delete: "Delete",
    deletePrompt: "Delete prompt",
    edit: "Edit",
    emptyBody: "Create your first prompt to keep roles, research methods, and creative templates together.",
    emptyFilteredBody: "Try clearing the search query or tag filters.",
    emptyFilteredTitle: "No matching prompts",
    emptyTitle: "No prompts yet",
    errorBody: "{message}",
    errorTitle: "Couldn’t load prompts",
    exportMd: "Export MD",
    filteredSelected: "{count} matching prompts selected",
    found: "{count} prompts found",
    itemsPerPage: "Items per page",
    loading: "Loading prompt library…",
    loadingDetail: "Loading prompt details…",
    manageTags: "Manage tags",
    markdownHint: "Markdown supported; content is limited to 5 MiB",
    nextPage: "Next page",
    noTags: "No tags yet",
    page: "Page {page} / {pages}",
    pin: "Pin: {title}",
    pinned: "Pinned",
    previousPage: "Previous page",
    remoteImageBlocked: "Remote image blocked: {alt}",
    retry: "Try again",
    save: "Save",
    saving: "Saving…",
    saveInProgress: "This prompt is being saved. Wait for it to finish before switching.",
    search: "Search prompts",
    searchPlaceholder: "Search titles, content, or tags…",
    select: "Select: {title}",
    selectFiltered: "Select all filtered results",
    selectPage: "Select this page",
    selected: "{count} selected",
    tagName: "Tag name",
    tagSearch: "Search tags",
    title: "Title",
    titlePlaceholder: "Give this prompt a clear title",
    unpin: "Unpin: {title}",
    updated: "Updated {date}",
    validationBody: "Content is required and must not exceed 5 MiB in UTF-8.",
    validationTags: "A prompt can have at most 20 tags.",
    validationTitle: "Title is required and must not exceed 200 characters.",
    viewFailed: "Couldn’t load prompt details",
    bytes: "{count} bytes",
    tagCreate: "New tag",
    tagRename: "Rename",
    tagDelete: "Delete tag: {name}",
    tagSave: "Save tag",
    selectionStale: "The library changed, so the filtered selection was cleared.",
    operationFailed: "Operation failed: {message}",
    promptDeleted: "Prompt deleted",
    promptSaved: "Prompt saved",
    exported: "Export completed",
    exportPlaintextConfirmSingle: "The prompt body will be exported to MD verbatim and in plaintext, including any passwords or credentials you pasted into it. Confirm it contains no secrets that should not be shared. Continue?",
    exportPlaintextConfirmBatch: "The selected prompt bodies will be exported to ZIP verbatim and in plaintext, including any passwords or credentials you pasted into them. Confirm they contain no secrets that should not be shared. Continue?",
    blockedLink: "Unsafe link blocked",
  },
};

const EMPTY_PAGE: PromptPage = {
  items: [],
  page: 1,
  pageSize: 30 as PromptPageSize,
  total: 0,
  totalPages: 1,
  libraryRevision: 0,
};

const EMPTY_DRAFT: PromptInput = {
  title: "",
  content: "",
  tagIds: [],
  pinned: false,
};

const MAX_CONTENT_BYTES = 5_242_880;

const iconComponents = {
  search: Search,
  pin: Pin,
  copy: Copy,
  close: X,
  edit: Pencil,
  download: Download,
  tag: Tag,
  plus: Plus,
  previous: ChevronLeft,
  next: ChevronRight,
};

function Icon({ name }: { name: keyof typeof iconComponents }) {
  const Component = iconComponents[name];
  return <Component aria-hidden="true" className="prompt-icon" size={16} strokeWidth={1.8} />;
}

function PromptExcerpt({ excerpt }: { excerpt: string }) {
  const paragraphRef = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const paragraph = paragraphRef.current;
    if (!paragraph) return undefined;

    const measure = () => {
      setTruncated(paragraph.scrollHeight > paragraph.clientHeight + 1);
    };
    measure();

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(paragraph);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [excerpt]);

  return (
    <p
      className="prompt-card-summary"
      data-truncated={truncated ? "true" : "false"}
      ref={paragraphRef}
    >
      {excerpt}
    </p>
  );
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function formatDate(value: string, language: "zh" | "en") {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const parts = new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatDateTime(value: string, language: "zh" | "en") {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const parts = new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function normalizeTagName(value: string) {
  return value.trim().normalize("NFC").toLocaleLowerCase();
}

function safeExternalUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

function SafeMarkdown({
  content,
  language,
  openExternal,
}: {
  content: string;
  language: "zh" | "en";
  openExternal?: (url: string) => Promise<void> | void;
}) {
  return (
    <div className="prompt-markdown">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => safeExternalUrl(href || "") ? (
            <a href={href} onClick={(event) => { event.preventDefault(); void openExternal?.(href || ""); }} rel="noreferrer">{children}</a>
          ) : <span className="prompt-blocked-link" title={copy[language].blockedLink}>{children}</span>,
          img: ({ alt, src }) => <span className="prompt-remote-image">{copy[language].remoteImageBlocked.replace("{alt}", alt || src || "")}</span>,
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function PromptsView({
  api,
  language = "zh",
  theme = "system",
  compact = false,
  t: translate,
  copyText,
  openExternal,
  confirmDiscard,
  confirmExport,
  confirmAction,
  onDirtyChange,
  registerLeaveGuard,
  onCountsChange,
}: PromptsViewProps) {
  const tr = useCallback((key: string, variables: Record<string, string | number> = {}) => {
    const translated = translate?.(key, variables);
    let value = translated && translated !== key ? translated : copy[language][key] || key;
    Object.entries(variables).forEach(([name, replacement]) => {
      value = value.replaceAll(`{${name}}`, String(replacement));
    });
    return value;
  }, [language, translate]);

  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<PromptTagMode>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<30 | 50 | 100>(30);
  const [promptPage, setPromptPage] = useState<PromptPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [tags, setTags] = useState<PromptTag[]>([]);
  const [tagsError, setTagsError] = useState("");
  const [tagSearch, setTagSearch] = useState("");
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [renamingTagId, setRenamingTagId] = useState("");
  const [renamingTagName, setRenamingTagName] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [allFiltered, setAllFiltered] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(() => new Set());
  const [selectionRevision, setSelectionRevision] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [drawerMode, setDrawerMode] = useState<"view" | "edit" | "create">("view");
  const [draft, setDraft] = useState<PromptInput>(EMPTY_DRAFT);
  const [baseline, setBaseline] = useState<PromptInput>(EMPTY_DRAFT);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [copyingId, setCopyingId] = useState("");
  const [pinningIds, setPinningIds] = useState<Set<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const requestSequence = useRef(0);
  const detailRequestSequence = useRef(0);
  const drawerSession = useRef(0);
  const mutationSequence = useRef(0);
  const saveSequence = useRef(0);
  const deleteSequence = useRef(0);
  const pinSequences = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const selectedPromptIdRef = useRef("");
  const allPromptCount = useRef(0);
  const lastFocus = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerWasOpen = useRef(false);

  selectedPromptIdRef.current = selectedPromptId;

  const dirty = (drawerMode === "edit" || drawerMode === "create")
    && (
      draft.title !== baseline.title
      || draft.content !== baseline.content
      || draft.pinned !== baseline.pinned
      || draft.tagIds.length !== baseline.tagIds.length
      || draft.tagIds.some((id, index) => id !== baseline.tagIds[index])
    );
  const deferredContent = useDeferredValue(draft.content);
  const draftContentBytes = useMemo(
    () => new TextEncoder().encode(deferredContent).byteLength,
    [deferredContent],
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      detailRequestSequence.current += 1;
      saveSequence.current += 1;
      deleteSequence.current += 1;
      pinSequences.current.clear();
      savingRef.current = false;
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  useEffect(() => {
    if (!statusMessage) return undefined;
    const timer = window.setTimeout(() => setStatusMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  const canDiscardRef = useRef<(context: PromptLeaveContext) => Promise<boolean>>(async () => true);
  canDiscardRef.current = async (context) => {
    if (savingRef.current) {
      setStatusMessage(tr("saveInProgress"));
      return false;
    }
    if (!dirty) return true;
    if (confirmDiscard) return Boolean(await confirmDiscard(context));
    return window.confirm(language === "zh" ? "有未保存的修改，确定放弃吗？" : "Discard unsaved changes?");
  };

  useEffect(() => {
    if (!registerLeaveGuard) return undefined;
    const cleanup = registerLeaveGuard((context = "switch") => canDiscardRef.current(context));
    return typeof cleanup === "function" ? cleanup : undefined;
  }, [registerLeaveGuard]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setAllFiltered(false);
    setExcludedIds(new Set());
    setSelectionRevision(null);
  }, []);

  const tagKey = tagIds.join("|");
  useEffect(() => {
    setPage(1);
    clearSelection();
  }, [query, tagKey, tagMode, pageSize, clearSelection]);

  const request = useMemo<PromptListRequest>(() => ({
    page,
    pageSize,
    query,
    tagIds,
    tagMode,
    sort: "updatedDesc",
  }), [page, pageSize, query, tagIds, tagMode]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api.listPrompts(request, controller.signal)
      .then((response) => {
        if (sequence !== requestSequence.current) return;
        setPromptPage({ ...response, totalPages: Math.max(1, response.totalPages) });
        setPage(response.page || request.page);
        setLoading(false);
      })
      .catch((reason) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setError(localizedApiErrorMessage(reason, language, tr("errorTitle")));
        setLoading(false);
      });
    return () => controller.abort();
  }, [api, language, request, reloadToken, tr]);

  const loadTags = useCallback(async () => {
    try {
      setTagsError("");
      setTags(await api.listTags());
    } catch (reason) {
      setTagsError(localizedApiErrorMessage(reason, language, tr("operationFailed", { message: "" })).trim());
    }
  }, [api, language, tr]);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  useEffect(() => {
    if (!query && !tagIds.length) allPromptCount.current = promptPage.total;
    onCountsChange?.({
      prompts: !query && !tagIds.length ? promptPage.total : allPromptCount.current,
      tags: tags.length,
      filtered: promptPage.total,
    });
  }, [onCountsChange, promptPage.total, query, tagIds.length, tags.length]);

  useEffect(() => {
    if (allFiltered && selectionRevision !== null && promptPage.libraryRevision !== selectionRevision) {
      clearSelection();
      setStatusMessage(tr("selectionStale"));
    }
  }, [allFiltered, clearSelection, promptPage.libraryRevision, selectionRevision, tr]);

  useEffect(() => {
    const isOpen = Boolean(selectedPromptId) || drawerMode === "create";
    const justOpened = isOpen && !drawerWasOpen.current;
    drawerWasOpen.current = isOpen;
    if (!isOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void closeDrawer("escape");
    };
    window.addEventListener("keydown", onKeyDown);
    if (justOpened) window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => window.removeEventListener("keydown", onKeyDown);
    // closeDrawer intentionally reads the latest component state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPromptId, drawerMode]);

  const selectedCount = allFiltered
    ? Math.max(0, promptPage.total - excludedIds.size)
    : selectedIds.size;

  const isSelected = (id: string) => allFiltered ? !excludedIds.has(id) : selectedIds.has(id);
  const pageIsSelected = promptPage.items.length > 0 && promptPage.items.every((item) => isSelected(item.id));
  const pageIsMixed = !pageIsSelected && promptPage.items.some((item) => isSelected(item.id));

  async function canDiscard(context: PromptLeaveContext) {
    return canDiscardRef.current(context);
  }

  function restoreFocus() {
    const target = lastFocus.current;
    window.setTimeout(() => target?.focus(), 0);
  }

  function resetDrawer() {
    drawerSession.current += 1;
    detailRequestSequence.current += 1;
    selectedPromptIdRef.current = "";
    setSelectedPromptId("");
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
    setDrawerMode("view");
    setDraft(EMPTY_DRAFT);
    setBaseline(EMPTY_DRAFT);
    setSaveError("");
  }

  async function closeDrawer(context: PromptLeaveContext = "close") {
    if (!(await canDiscard(context))) return;
    resetDrawer();
    restoreFocus();
  }

  async function openPrompt(id: string, trigger?: HTMLElement) {
    if (id === selectedPromptId && drawerMode === "view" && detail) return;
    if (!(await canDiscard("switch"))) return;
    drawerSession.current += 1;
    const sequence = ++detailRequestSequence.current;
    if (trigger) lastFocus.current = trigger;
    selectedPromptIdRef.current = id;
    setSelectedPromptId(id);
    setDrawerMode("view");
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    setSaveError("");
    try {
      const response = await api.getPrompt(id);
      if (sequence !== detailRequestSequence.current) return;
      setDetail(response);
      const nextDraft = {
        title: response.title,
        content: response.content,
        tagIds: response.tags.map((tag) => tag.id),
        pinned: response.pinned,
      };
      setDraft(nextDraft);
      setBaseline(nextDraft);
    } catch (reason) {
      if (sequence !== detailRequestSequence.current) return;
      setDetailError(localizedApiErrorMessage(reason, language, tr("viewFailed")));
    } finally {
      if (sequence === detailRequestSequence.current) setDetailLoading(false);
    }
  }

  async function openCreate(trigger?: HTMLElement) {
    if (!(await canDiscard("new"))) return;
    drawerSession.current += 1;
    detailRequestSequence.current += 1;
    if (trigger) lastFocus.current = trigger;
    selectedPromptIdRef.current = "";
    setSelectedPromptId("");
    setDetail(null);
    setDetailError("");
    setDrawerMode("create");
    setDraft(EMPTY_DRAFT);
    setBaseline(EMPTY_DRAFT);
    setSaveError("");
  }

  function startEdit() {
    if (!detail) return;
    const nextDraft = {
      title: detail.title,
      content: detail.content,
      tagIds: detail.tags.map((tag) => tag.id),
      pinned: detail.pinned,
    };
    setDraft(nextDraft);
    setBaseline(nextDraft);
    setSaveError("");
    setDrawerMode("edit");
  }

  async function cancelEdit() {
    if (!(await canDiscard("cancel"))) return;
    if (drawerMode === "create") {
      resetDrawer();
      restoreFocus();
      return;
    }
    setDraft(baseline);
    setSaveError("");
    setDrawerMode("view");
  }

  async function savePrompt(event: FormEvent) {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title || codePointLength(title) > 200) {
      setSaveError(tr("validationTitle"));
      return;
    }
    const bytes = new TextEncoder().encode(draft.content).byteLength;
    if (!draft.content.trim() || bytes > MAX_CONTENT_BYTES) {
      setSaveError(tr("validationBody"));
      return;
    }
    if (draft.tagIds.length > 20) {
      setSaveError(tr("validationTags"));
      return;
    }
    const mode = drawerMode;
    const target = mode === "edit" ? detail : null;
    if (mode === "edit" && !target) return;
    const operation = ++mutationSequence.current;
    saveSequence.current = operation;
    const session = drawerSession.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const input = { ...draft, title };
      const response = mode === "create"
        ? await api.createPrompt(input)
        : await api.updatePrompt(target!.id, target!.revision, input);
      const stillCurrent = mounted.current
        && saveSequence.current === operation
        && drawerSession.current === session
        && (mode === "create" || selectedPromptIdRef.current === target!.id)
        && (mode === "create" || response.id === target!.id);
      if (!stillCurrent) {
        if (mounted.current) setReloadToken((value) => value + 1);
        return;
      }
      selectedPromptIdRef.current = response.id;
      setSelectedPromptId(response.id);
      setDetail(response);
      const nextDraft = {
        title: response.title,
        content: response.content,
        tagIds: response.tags.map((tag) => tag.id),
        pinned: response.pinned,
      };
      setDraft(nextDraft);
      setBaseline(nextDraft);
      setDrawerMode("view");
      setStatusMessage(tr("promptSaved"));
      setReloadToken((value) => value + 1);
    } catch (reason) {
      if (
        mounted.current
        && saveSequence.current === operation
        && drawerSession.current === session
      ) {
        setSaveError(localizedApiErrorMessage(reason, language, tr("operationFailed", { message: "" })).trim());
      }
    } finally {
      if (saveSequence.current === operation) {
        savingRef.current = false;
        if (mounted.current) setSaving(false);
      }
    }
  }

  async function runConfirmed(action: PromptAction, title: string, target?: string) {
    if (confirmAction) return Boolean(await confirmAction(action, { title, target }));
    return window.confirm(language === "zh" ? `确定要${action === "delete-prompt" ? "删除这个提示词" : "执行此操作"}吗？` : "Are you sure?");
  }

  async function confirmPlaintextExport(
    kind: PromptExportKind,
    details: { count: number; title?: string },
  ) {
    if (confirmExport) return Boolean(await confirmExport(kind, details));
    return window.confirm(tr(kind === "single"
      ? "exportPlaintextConfirmSingle"
      : "exportPlaintextConfirmBatch"));
  }

  async function deleteCurrentPrompt() {
    if (!detail) return;
    const target = detail;
    const session = drawerSession.current;
    if (!(await runConfirmed("delete-prompt", target.title))) return;
    if (
      !mounted.current
      || drawerSession.current !== session
      || selectedPromptIdRef.current !== target.id
    ) return;
    const operation = ++mutationSequence.current;
    deleteSequence.current = operation;
    try {
      await api.deletePrompt(target.id, target.revision);
      if (!mounted.current || deleteSequence.current !== operation) return;
      if (drawerSession.current === session && selectedPromptIdRef.current === target.id) {
        resetDrawer();
        restoreFocus();
      }
      setStatusMessage(tr("promptDeleted"));
      clearSelection();
      setReloadToken((value) => value + 1);
    } catch (reason) {
      if (
        mounted.current
        && deleteSequence.current === operation
        && drawerSession.current === session
        && selectedPromptIdRef.current === target.id
      ) {
        setSaveError(localizedApiErrorMessage(reason, language, tr("operationFailed", { message: "" })).trim());
      }
    }
  }

  async function togglePinned(prompt: PromptSummary) {
    const operation = ++mutationSequence.current;
    pinSequences.current.set(prompt.id, operation);
    setPinningIds((current) => new Set(current).add(prompt.id));
    try {
      const updated = await api.setPromptPinned(prompt.id, prompt.revision, !prompt.pinned);
      if (!mounted.current || pinSequences.current.get(prompt.id) !== operation) return;
      if (selectedPromptIdRef.current === updated.id) {
        setDetail((current) => current?.id === updated.id ? { ...current, ...updated } : current);
        setDraft((current) => ({ ...current, pinned: updated.pinned }));
        setBaseline((current) => ({ ...current, pinned: updated.pinned }));
      }
      setReloadToken((value) => value + 1);
    } catch (reason) {
      if (mounted.current && pinSequences.current.get(prompt.id) === operation) {
        setStatusMessage(tr("operationFailed", {
          message: localizedApiErrorMessage(reason, language, tr("operationFailed", { message: "" })).trim(),
        }));
      }
    } finally {
      if (pinSequences.current.get(prompt.id) === operation) {
        pinSequences.current.delete(prompt.id);
        if (mounted.current) {
          setPinningIds((current) => {
            const next = new Set(current);
            next.delete(prompt.id);
            return next;
          });
        }
      }
    }
  }

  async function copyPrompt(prompt: PromptSummary) {
    setCopyingId(prompt.id);
    try {
      const response = detail?.id === prompt.id ? detail : await api.getPrompt(prompt.id);
      if (copyText) await copyText(response.content);
      else await navigator.clipboard.writeText(response.content);
      setStatusMessage(tr("copied"));
    } catch (reason) {
      setStatusMessage(tr("operationFailed", { message: localizedApiErrorMessage(reason, language, tr("copy")) }));
    } finally {
      setCopyingId("");
    }
  }

  function toggleSelected(id: string) {
    if (allFiltered) {
      setExcludedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePageSelection() {
    if (allFiltered) {
      setExcludedIds((current) => {
        const next = new Set(current);
        promptPage.items.forEach((item) => pageIsSelected ? next.add(item.id) : next.delete(item.id));
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      promptPage.items.forEach((item) => pageIsSelected ? next.delete(item.id) : next.add(item.id));
      return next;
    });
  }

  function selectFilteredResults() {
    setAllFiltered(true);
    setSelectedIds(new Set());
    setExcludedIds(new Set());
    setSelectionRevision(promptPage.libraryRevision);
  }

  async function exportSelection() {
    if (!selectedCount) return;
    const count = selectedCount;
    const selection: PromptSelection = allFiltered
      ? {
          mode: "filter",
          filter: {
            query: request.query,
            tagIds: request.tagIds,
            tagMode: request.tagMode,
            sort: request.sort,
          },
          excludedIds: Array.from(excludedIds),
          expectedLibraryRevision: selectionRevision ?? promptPage.libraryRevision,
        }
      : { mode: "explicit", ids: Array.from(selectedIds) };
    if (!(await confirmPlaintextExport("batch", { count }))) return;
    setExporting(true);
    try {
      const summary = await api.exportPrompts(selection);
      if (!summary.cancelled) setStatusMessage(tr("exported"));
    } catch (reason) {
      setStatusMessage(tr("operationFailed", { message: localizedApiErrorMessage(reason, language, tr("batchExport")) }));
    } finally {
      setExporting(false);
    }
  }

  async function exportSinglePrompt(prompt: PromptDetail) {
    const session = drawerSession.current;
    if (!(await confirmPlaintextExport("single", { count: 1, title: prompt.title }))) return;
    if (
      !mounted.current
      || drawerSession.current !== session
      || selectedPromptIdRef.current !== prompt.id
    ) return;
    setExporting(true);
    try {
      const summary = await api.exportPrompt(prompt.id);
      if (!summary.cancelled && mounted.current) setStatusMessage(tr("exported"));
    } catch (reason) {
      if (mounted.current) {
        setStatusMessage(tr("operationFailed", {
          message: localizedApiErrorMessage(reason, language, tr("exportMd")),
        }));
      }
    } finally {
      if (mounted.current) setExporting(false);
    }
  }

  async function createTag(event: FormEvent) {
    event.preventDefault();
    const name = tagDraft.trim().normalize("NFC");
    if (!name || codePointLength(name) > 50) return;
    try {
      await api.createTag(name);
      setTagDraft("");
      await loadTags();
    } catch (reason) {
      setTagsError(localizedApiErrorMessage(reason, language, tr("tagCreate")));
    }
  }

  async function saveTagRename(tag: PromptTag) {
    const name = renamingTagName.trim().normalize("NFC");
    if (!name || codePointLength(name) > 50) return;
    const collision = tags.find((candidate) => candidate.id !== tag.id && normalizeTagName(candidate.name) === normalizeTagName(name));
    try {
      if (collision) {
        if (!(await runConfirmed("merge-tag", tag.name, collision.name))) return;
        await api.mergeTags(tag.id, collision.id);
      } else {
        await api.renameTag(tag.id, name);
      }
      setRenamingTagId("");
      await loadTags();
      setReloadToken((value) => value + 1);
    } catch (reason) {
      setTagsError(localizedApiErrorMessage(reason, language, tr("tagRename")));
    }
  }

  async function removeTag(tag: PromptTag) {
    if (!(await runConfirmed("delete-tag", tag.name))) return;
    try {
      await api.deleteTag(tag.id);
      setTagIds((current) => current.filter((id) => id !== tag.id));
      await loadTags();
      setReloadToken((value) => value + 1);
    } catch (reason) {
      setTagsError(localizedApiErrorMessage(reason, language, tr("delete")));
    }
  }

  const filteredTags = tags.filter((tag) => normalizeTagName(tag.name).includes(normalizeTagName(tagSearch)));
  const drawerOpen = Boolean(selectedPromptId) || drawerMode === "create";
  const drawerTitle = drawerMode === "create" ? tr("create") : detail?.title || tr("loadingDetail");

  function cardKeyDown(event: KeyboardEvent<HTMLElement>, prompt: PromptSummary) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void openPrompt(prompt.id, event.currentTarget);
  }

  function stop(event: MouseEvent) {
    event.stopPropagation();
  }

  return (
    <section
      className={`prompts-view${drawerOpen ? " has-drawer" : ""}`}
      data-density={compact ? "compact" : "comfortable"}
      data-theme={theme}
    >
      <h1 className="sr-only">{language === "zh" ? "提示词库" : "Prompt Library"}</h1>
      <div className="prompt-toolbar" role="toolbar">
        <button className="prompt-button" onClick={(event) => void openCreate(event.currentTarget)} type="button">
          <Icon name="plus" />{tr("add")}
        </button>
        <label className="prompt-search">
          <span className="sr-only">{tr("search")}</span>
          <Icon name="search" />
          <input
            aria-label={tr("search")}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder={tr("searchPlaceholder")}
            type="search"
            value={queryInput}
          />
        </label>
        <details className="prompt-tag-filter">
          <summary className="prompt-button"><Icon name="tag" />{tagIds.length ? `${tr("allTags")} · ${tagIds.length}` : tr("allTags")}</summary>
          <div className="prompt-popover">
            <label className="prompt-popover-search">
              <span className="sr-only">{tr("tagSearch")}</span>
              <input aria-label={tr("tagSearch")} onChange={(event) => setTagSearch(event.target.value)} placeholder={tr("tagSearch")} value={tagSearch} />
            </label>
            {filteredTags.length ? filteredTags.map((tag) => (
              <label className="prompt-check-row" key={tag.id}>
                <input
                  checked={tagIds.includes(tag.id)}
                  onChange={() => setTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])}
                  type="checkbox"
                />
                <span>{tag.name}</span><small>{tag.promptCount ?? ""}</small>
              </label>
            )) : <p className="prompt-muted">{tr("noTags")}</p>}
          </div>
        </details>
        <div className="prompt-segmented" aria-label={`${tr("allSelectedTags")} / ${tr("anyTags")}`}>
          <button aria-pressed={tagMode === "all"} onClick={() => setTagMode("all")} type="button">{tr("allSelectedTags")}</button>
          <button aria-pressed={tagMode === "any"} onClick={() => setTagMode("any")} type="button">{tr("anyTags")}</button>
        </div>
        <button className="prompt-button" onClick={() => setTagManagerOpen((value) => !value)} type="button"><Icon name="tag" />{tr("manageTags")}</button>
        <button className="prompt-button" disabled={!selectedCount || exporting} onClick={() => void exportSelection()} type="button"><Icon name="download" />{tr("batchExport")}</button>
      </div>

      {tagManagerOpen && (
        <section aria-label={tr("manageTags")} className="prompt-tag-manager">
          <form className="prompt-tag-create" onSubmit={createTag}>
            <label><span className="sr-only">{tr("tagName")}</span><input aria-label={tr("tagName")} onChange={(event) => setTagDraft(event.target.value)} placeholder={tr("tagName")} value={tagDraft} /></label>
            <button className="prompt-button prompt-button-primary" type="submit">{tr("tagCreate")}</button>
          </form>
          {tagsError && <p className="prompt-inline-error" role="alert">{tagsError}</p>}
          <div className="prompt-tag-manager-list">
            {tags.map((tag) => (
              <div className="prompt-tag-manager-row" key={tag.id}>
                {renamingTagId === tag.id ? (
                  <input
                    aria-label={`${tr("tagRename")}: ${tag.name}`}
                    autoFocus
                    onChange={(event) => setRenamingTagName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void saveTagRename(tag); if (event.key === "Escape") setRenamingTagId(""); }}
                    value={renamingTagName}
                  />
                ) : <span>{tag.name}<small>{tag.promptCount ?? 0}</small></span>}
                <div>
                  {renamingTagId === tag.id ? (
                    <button className="prompt-text-button" onClick={() => void saveTagRename(tag)} type="button">{tr("tagSave")}</button>
                  ) : (
                    <button className="prompt-text-button" onClick={() => { setRenamingTagId(tag.id); setRenamingTagName(tag.name); }} type="button">{tr("tagRename")}</button>
                  )}
                  <button aria-label={tr("tagDelete", { name: tag.name })} className="prompt-text-button prompt-danger-text" onClick={() => void removeTag(tag)} type="button">{tr("delete")}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="prompt-results-bar">
        <span>{tr("found", { count: promptPage.total })}</span>
        <div className="prompt-selection-actions">
          <label>
            <input
              aria-checked={pageIsMixed ? "mixed" : pageIsSelected}
              checked={pageIsSelected}
              onChange={togglePageSelection}
              ref={(element) => { if (element) element.indeterminate = pageIsMixed; }}
              type="checkbox"
            />
            {tr("selectPage")}
          </label>
          <button className="prompt-text-button" disabled={!promptPage.total || allFiltered} onClick={selectFilteredResults} type="button">{tr("selectFiltered")}</button>
          {selectedCount > 0 && <><strong>{allFiltered ? tr("filteredSelected", { count: selectedCount }) : tr("selected", { count: selectedCount })}</strong><button className="prompt-text-button" onClick={clearSelection} type="button">{tr("clearSelection")}</button></>}
        </div>
      </div>

      <div aria-atomic="true" aria-live="polite" className="prompt-status-live">{statusMessage}</div>

      <div className="prompt-content-region">
        {loading && <div className="prompt-state"><span className="prompt-spinner" /> <p>{tr("loading")}</p></div>}
        {!loading && error && (
          <div className="prompt-state prompt-state-error" role="alert">
            <h2>{tr("errorTitle")}</h2><p>{tr("errorBody", { message: error })}</p>
            <button className="prompt-button" onClick={() => setReloadToken((value) => value + 1)} type="button">{tr("retry")}</button>
          </div>
        )}
        {!loading && !error && promptPage.items.length === 0 && (
          <div className="prompt-state">
            <div className="prompt-empty-icon"><Icon name="edit" /></div>
            <h2>{query || tagIds.length ? tr("emptyFilteredTitle") : tr("emptyTitle")}</h2>
            <p>{query || tagIds.length ? tr("emptyFilteredBody") : tr("emptyBody")}</p>
            {!query && !tagIds.length && <button className="prompt-button prompt-button-primary" onClick={(event) => void openCreate(event.currentTarget)} type="button">{tr("add")}</button>}
          </div>
        )}
        {!loading && !error && promptPage.items.length > 0 && (
          <div className="prompt-grid">
            {promptPage.items.map((prompt) => {
              const visibleTags = prompt.tags.slice(0, 3);
              const extraTags = prompt.tags.length - visibleTags.length;
              return (
                <article
                  aria-label={prompt.title}
                  className={`prompt-card ${selectedPromptId === prompt.id ? "is-open" : ""}`}
                  key={prompt.id}
                  onClick={(event) => void openPrompt(prompt.id, event.currentTarget)}
                  onKeyDown={(event) => cardKeyDown(event, prompt)}
                  tabIndex={0}
                >
                  <div className="prompt-card-head">
                    <label className="prompt-card-check" onClick={stop}>
                      <input aria-label={tr("select", { title: prompt.title })} checked={isSelected(prompt.id)} onChange={() => toggleSelected(prompt.id)} type="checkbox" />
                    </label>
                    <h2>{prompt.title}</h2>
                    <button
                      aria-label={tr(prompt.pinned ? "unpin" : "pin", { title: prompt.title })}
                      aria-pressed={prompt.pinned}
                      className={`prompt-icon-button prompt-pin ${prompt.pinned ? "active" : ""}`}
                      disabled={pinningIds.has(prompt.id)}
                      onClick={(event) => { event.stopPropagation(); void togglePinned(prompt); }}
                      type="button"
                    ><Icon name="pin" /></button>
                  </div>
                  <div className="prompt-card-tags">
                    {visibleTags.map((tag) => <span className="prompt-tag" key={tag.id}>{tag.name}</span>)}
                    {extraTags > 0 && <span className="prompt-tag prompt-tag-more">+{extraTags}</span>}
                  </div>
                  <PromptExcerpt excerpt={prompt.excerpt} />
                  <footer>
                    <time dateTime={prompt.updatedAt}>{tr("updated", { date: formatDate(prompt.updatedAt, language) })}</time>
                    <button
                      aria-label={tr("copyPrompt", { title: prompt.title })}
                      className="prompt-copy-button"
                      disabled={copyingId === prompt.id}
                      onClick={(event) => { event.stopPropagation(); void copyPrompt(prompt); }}
                      type="button"
                    ><Icon name="copy" />{tr("copy")}</button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <nav aria-label={tr("page", { page: promptPage.page, pages: promptPage.totalPages })} className="prompt-pagination">
        <label>{tr("itemsPerPage")}
          <select aria-label={tr("itemsPerPage")} onChange={(event: ChangeEvent<HTMLSelectElement>) => setPageSize(Number(event.target.value) as 30 | 50 | 100)} value={pageSize}>
            <option value="30">30</option><option value="50">50</option><option value="100">100</option>
          </select>
        </label>
        <button aria-label={tr("previousPage")} disabled={promptPage.page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button"><Icon name="previous" /></button>
        <span>{tr("page", { page: promptPage.page, pages: promptPage.totalPages })}</span>
        <button aria-label={tr("nextPage")} disabled={promptPage.page >= promptPage.totalPages || loading} onClick={() => setPage((value) => Math.min(promptPage.totalPages, value + 1))} type="button"><Icon name="next" /></button>
      </nav>

      {drawerOpen && (
        <div className="prompt-drawer-layer">
          <aside aria-label={drawerTitle} aria-modal="false" className="prompt-drawer" role="dialog">
            <header className="prompt-drawer-header">
              <div>
                <h2>{drawerTitle}</h2>
                {detail && drawerMode === "view" && (
                  <div className="prompt-drawer-tags">{detail.tags.map((tag) => <span className="prompt-tag" key={tag.id}>{tag.name}</span>)}</div>
                )}
              </div>
              <button aria-label={tr("close")} className="prompt-icon-button" onClick={() => void closeDrawer("close")} ref={closeButtonRef} type="button"><Icon name="close" /></button>
            </header>

            {detailLoading && <div className="prompt-state"><span className="prompt-spinner" /><p>{tr("loadingDetail")}</p></div>}
            {!detailLoading && detailError && <div className="prompt-state prompt-state-error" role="alert"><h3>{tr("viewFailed")}</h3><p>{detailError}</p><button className="prompt-button" onClick={() => void openPrompt(selectedPromptId)} type="button">{tr("retry")}</button></div>}

            {!detailLoading && !detailError && drawerMode === "view" && detail && (
              <>
                <div className="prompt-drawer-meta"><span>{detail.pinned && <><Pin aria-hidden="true" size={14} />{tr("pinned")} · </>}{tr("updated", { date: formatDateTime(detail.updatedAt, language) })}</span><span>{tr("bytes", { count: detail.contentBytes })}</span></div>
                <div className="prompt-drawer-actions">
                  <button className="prompt-button" onClick={() => void copyPrompt(detail)} type="button"><Icon name="copy" />{tr("copy")}</button>
                  <button className="prompt-button" disabled={exporting} onClick={() => void exportSinglePrompt(detail)} type="button"><Icon name="download" />{tr("exportMd")}</button>
                  <button aria-label={tr(detail.pinned ? "unpin" : "pin", { title: detail.title })} className="prompt-button" disabled={pinningIds.has(detail.id)} onClick={() => void togglePinned(detail)} type="button"><Icon name="pin" /></button>
                  <button className="prompt-button prompt-button-primary" onClick={startEdit} type="button"><Icon name="edit" />{tr("edit")}</button>
                </div>
                {saveError && <p className="prompt-inline-error prompt-drawer-error" role="alert">{saveError}</p>}
                <div className="prompt-drawer-scroll">
                  <SafeMarkdown content={detail.content} language={language} openExternal={openExternal} />
                </div>
                <div className="prompt-drawer-danger"><button className="prompt-text-button prompt-danger-text" onClick={() => void deleteCurrentPrompt()} type="button">{tr("deletePrompt")}</button></div>
              </>
            )}

            {!detailLoading && !detailError && (drawerMode === "edit" || drawerMode === "create") && (
              <form className="prompt-editor" onSubmit={savePrompt}>
                <div className="prompt-editor-scroll">
                  <label className="prompt-field"><span>{tr("title")}</span><input aria-label={tr("title")} autoFocus onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder={tr("titlePlaceholder")} value={draft.title} /></label>
                  <fieldset className="prompt-tag-field"><legend>{tr("allTags")}</legend><div>{tags.map((tag) => <label key={tag.id}><input checked={draft.tagIds.includes(tag.id)} disabled={!draft.tagIds.includes(tag.id) && draft.tagIds.length >= 20} onChange={() => setDraft((current) => ({ ...current, tagIds: current.tagIds.includes(tag.id) ? current.tagIds.filter((id) => id !== tag.id) : [...current.tagIds, tag.id] }))} type="checkbox" /><span className="prompt-tag">{tag.name}</span></label>)}</div></fieldset>
                  <label className="prompt-field prompt-field-body"><span>{tr("body")}</span><textarea aria-label={tr("body")} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} spellCheck={false} value={draft.content} /><small>{tr("markdownHint")} · {draftContentBytes.toLocaleString()} / {MAX_CONTENT_BYTES.toLocaleString()}</small></label>
                  <label className="prompt-pin-field"><input checked={draft.pinned} onChange={(event) => setDraft((current) => ({ ...current, pinned: event.target.checked }))} type="checkbox" />{tr("pinned")}</label>
                  {saveError && <p className="prompt-inline-error" role="alert">{saveError}</p>}
                </div>
                <footer className="prompt-editor-actions"><button className="prompt-button" disabled={saving} onClick={() => void cancelEdit()} type="button">{tr("cancel")}</button><button className="prompt-button prompt-button-primary" disabled={saving} type="submit">{saving ? tr("saving") : tr("save")}</button></footer>
              </form>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
