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
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Tag,
  Upload,
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
  PromptZipConflictStrategy,
  ReorderPromptRequest,
  ReorderPromptResult,
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

export type PromptZipImportPreviewModel = {
  path: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  libraryRevision: number;
  promptCount: number;
  newCount: number;
  identicalCount: number;
  conflictCount: number;
  tagsToCreate: number;
  tagsToReuse: number;
  totalContentBytes: number;
  conflicts: Array<{ id: string; importedTitle: string; localTitle: string }>;
};

export type PromptZipImportResultModel = {
  inserted: number;
  skipped: number;
  duplicated: number;
  overwritten: number;
  tagsCreated: number;
  tagsReused: number;
  libraryRevision: number;
  message: string;
};

type PromptDragState = {
  id: string;
  title: string;
  sourceIndex: number;
  targetIndex: number;
  overIndex: number;
  edge: "before" | "after";
  input: "keyboard" | "pointer";
  rect: { left: number; top: number; width: number; height: number };
  deltaX: number;
  deltaY: number;
};

type PromptPointerSession = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  sourceIndex: number;
  active: boolean;
  rect: { left: number; top: number; width: number; height: number };
  cardRects: Map<string, { left: number; top: number }>;
  itemIndices: Map<string, number>;
  previewTargetIndex: number | null;
};

export type PromptLibraryApi = {
  listPrompts: (request: PromptListRequest, signal?: AbortSignal) => Promise<PromptPage>;
  getPrompt: (id: string) => Promise<PromptDetail>;
  createPrompt: (input: PromptInput) => Promise<PromptDetail>;
  updatePrompt: (id: string, revision: number, input: PromptInput) => Promise<PromptDetail>;
  deletePrompt: (id: string, revision: number) => Promise<void>;
  setPromptPinned: (id: string, revision: number, pinned: boolean) => Promise<PromptSummary>;
  reorderPrompt: (request: ReorderPromptRequest) => Promise<ReorderPromptResult>;
  listTags: () => Promise<PromptTag[]>;
  createTag: (name: string) => Promise<PromptTag>;
  renameTag: (id: string, name: string) => Promise<PromptTag>;
  mergeTags: (sourceId: string, targetId: string) => Promise<PromptTag>;
  deleteTag: (id: string) => Promise<void>;
  exportPrompt: (id: string) => Promise<PromptExportSummary>;
  exportPrompts: (selection: PromptSelection) => Promise<PromptExportSummary>;
  previewPromptsZipImport: () => Promise<PromptZipImportPreviewModel | null>;
  importPromptsZip: (request: {
    path: string;
    sha256: string;
    sizeBytes: number;
    expectedLibraryRevision: number;
    conflictStrategy: PromptZipConflictStrategy;
  }) => Promise<PromptZipImportResultModel>;
};

export type PromptLeaveContext = "cancel" | "close" | "escape" | "switch" | "new" | "outside";
export type PromptExportKind = "single" | "batch";

type PromptAction = "delete-prompt" | "delete-tag" | "merge-tag" | "overwrite-import";

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
    batchImport: "批量导入",
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
    tagManagerSearch: "搜索要管理的标签",
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
    conflictStrategy: "冲突处理",
    conflictImported: "导入：{title}",
    conflictLocal: "本机：{title}",
    importComplete: "导入完成",
    importDialogTitle: "导入提示词 ZIP",
    importFailed: "导入失败：{message}",
    importMetrics: "{count} 篇提示词",
    importNew: "新增 {count}",
    importIdentical: "相同 {count}",
    importConflicts: "冲突 {count}",
    importTags: "新建 {created} 个标签 · 复用 {reused} 个标签",
    importPlaintextWarning: "ZIP 中的提示词正文为明文。导入前请确认文件来源可信，且不包含不应保存到本机的密码或凭证。",
    importPrompts: "导入提示词",
    importing: "正在导入…",
    importResult: "新增 {inserted} · 覆盖 {overwritten}",
    strategyDuplicate: "导入为副本（推荐）",
    strategyKeepLocal: "保留本机",
    strategyOverwrite: "覆盖本机",
    sortLabel: "排序方式",
    sortManual: "手动排序",
    sortUpdated: "最近更新",
    dragMove: "移动：{title}",
    dragOptions: "移动选项：{title}",
    dragUnavailable: "清除搜索和标签筛选后可手动排序",
    dragCancelled: "已取消移动 {title}",
    moveFirst: "移到分组开头",
    moveLast: "移到分组末尾",
    movedTo: "已将 {title} 移到第 {position} 位",
    reorderFailed: "调整顺序失败：{message}",
  },
  en: {
    add: "New prompt",
    allTags: "All tags",
    anyTags: "Any selected tag",
    allSelectedTags: "All selected tags",
    batchExport: "Batch export",
    batchImport: "Batch import",
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
    tagManagerSearch: "Search managed tags",
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
    conflictStrategy: "Conflict strategy",
    conflictImported: "Imported: {title}",
    conflictLocal: "Local: {title}",
    importComplete: "Import complete",
    importDialogTitle: "Import prompt ZIP",
    importFailed: "Import failed: {message}",
    importMetrics: "{count} prompts",
    importNew: "{count} new",
    importIdentical: "{count} identical",
    importConflicts: "{count} conflicts",
    importTags: "{created} tags to create · {reused} tags to reuse",
    importPlaintextWarning: "Prompt bodies in this ZIP are plaintext. Import only from a trusted source and confirm it contains no passwords or credentials you should not store locally.",
    importPrompts: "Import prompts",
    importing: "Importing…",
    importResult: "{inserted} inserted · {overwritten} overwritten",
    strategyDuplicate: "Import as copies (recommended)",
    strategyKeepLocal: "Keep local",
    strategyOverwrite: "Overwrite local",
    sortLabel: "Sort order",
    sortManual: "Manual order",
    sortUpdated: "Recently updated",
    dragMove: "Move: {title}",
    dragOptions: "Move options: {title}",
    dragUnavailable: "Clear search and tag filters to reorder manually",
    dragCancelled: "Cancelled moving {title}",
    moveFirst: "Move to start of group",
    moveLast: "Move to end of group",
    movedTo: "Moved {title} to position {position}",
    reorderFailed: "Couldn’t reorder: {message}",
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
  drag: GripVertical,
  more: MoreHorizontal,
  tag: Tag,
  upload: Upload,
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

function PromptCardTags({ tags }: { tags: PromptTag[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const maximum = Math.min(5, tags.length);
  const [visibleCount, setVisibleCount] = useState(maximum);
  const signature = tags.map((tag) => `${tag.id}:${tag.name}`).join("|");

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return undefined;

    const measureVisibleTags = () => {
      const availableWidth = container.clientWidth;
      if (availableWidth <= 0) {
        setVisibleCount(maximum);
        return;
      }
      const samples = Array.from(measure.querySelectorAll<HTMLElement>("[data-tag-measure]"));
      const widths = samples.slice(0, maximum).map((sample) => {
        const measured = sample.getBoundingClientRect().width;
        return measured > 0
          ? measured
          : Math.min(110, 18 + Array.from(sample.textContent || "").length * 7);
      });
      const badgeSample = measure.querySelector<HTMLElement>("[data-tag-more-measure]");
      const measuredBadgeWidth = badgeSample?.getBoundingClientRect().width ?? 0;
      const badgeWidth = measuredBadgeWidth > 0 ? measuredBadgeWidth : 38;

      const fitsTwoRows = (count: number) => {
        const itemWidths = widths.slice(0, count);
        if (count < tags.length) itemWidths.push(badgeWidth);
        let rows = 1;
        let used = 0;
        for (const itemWidth of itemWidths) {
          const width = Math.min(availableWidth, itemWidth);
          if (used > 0 && used + 5 + width > availableWidth) {
            rows += 1;
            used = width;
          } else {
            used += (used > 0 ? 5 : 0) + width;
          }
        }
        return rows <= 2;
      };

      let nextCount = maximum;
      while (nextCount > 1 && !fitsTwoRows(nextCount)) nextCount -= 1;
      setVisibleCount(nextCount);
    };

    measureVisibleTags();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measureVisibleTags);
    observer?.observe(container);
    window.addEventListener("resize", measureVisibleTags);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureVisibleTags);
    };
  }, [maximum, signature, tags.length]);

  const count = Math.min(visibleCount, maximum);
  const hiddenCount = Math.max(0, tags.length - count);
  return (
    <div className="prompt-card-tags" data-visible-count={count} ref={containerRef}>
      <div className="prompt-card-tag-items">
        {tags.slice(0, count).map((tag) => <span className="prompt-tag" key={tag.id}>{tag.name}</span>)}
        {hiddenCount > 0 && <span className="prompt-tag prompt-tag-more">+{hiddenCount}</span>}
      </div>
      <div aria-hidden="true" className="prompt-card-tag-measure" ref={measureRef}>
        {tags.slice(0, maximum).map((tag) => <span className="prompt-tag" data-tag-measure key={tag.id}>{tag.name}</span>)}
        {tags.length > maximum && <span className="prompt-tag prompt-tag-more" data-tag-more-measure>+{tags.length}</span>}
      </div>
    </div>
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
  const [tagManagerMotion, setTagManagerMotion] = useState<"instant" | "pointer">("instant");
  const [tagManagerSearch, setTagManagerSearch] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [renamingTagId, setRenamingTagId] = useState("");
  const [renamingTagName, setRenamingTagName] = useState("");
  const [tagCreating, setTagCreating] = useState(false);
  const [tagPendingIds, setTagPendingIds] = useState<Set<string>>(() => new Set());
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
  const [importPreview, setImportPreview] = useState<PromptZipImportPreviewModel | null>(null);
  const [importResult, setImportResult] = useState<PromptZipImportResultModel | null>(null);
  const [importStrategy, setImportStrategy] = useState<PromptZipConflictStrategy>("duplicate");
  const [previewingImport, setPreviewingImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importDialogMotion, setImportDialogMotion] = useState<"instant" | "pointer">("instant");
  const [sortMode, setSortMode] = useState<"manual" | "updatedDesc">("manual");
  const [dragState, setDragState] = useState<PromptDragState | null>(null);
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const [reorderingIds, setReorderingIds] = useState<Set<string>>(() => new Set());
  const [moveMenuId, setMoveMenuId] = useState("");
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== "undefined"
    && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  ));
  const [drawerClosing, setDrawerClosing] = useState(false);
  const [drawerMotion, setDrawerMotion] = useState<"instant" | "pointer">("instant");
  const requestSequence = useRef(0);
  const detailRequestSequence = useRef(0);
  const drawerSession = useRef(0);
  const mutationSequence = useRef(0);
  const saveSequence = useRef(0);
  const deleteSequence = useRef(0);
  const pinSequences = useRef(new Map<string, number>());
  const tagCreatingRef = useRef(false);
  const tagPendingIdsRef = useRef(new Set<string>());
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const selectedPromptIdRef = useRef("");
  const allPromptCount = useRef(0);
  const lastFocus = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const tagManagerRef = useRef<HTMLDivElement | null>(null);
  const importDialogRef = useRef<HTMLElement | null>(null);
  const importTriggerRef = useRef<HTMLElement | null>(null);
  const drawerCloseTimer = useRef<number | null>(null);
  const drawerWasOpen = useRef(false);
  const activeDragRef = useRef<PromptDragState | null>(null);
  const pointerDragRef = useRef<PromptPointerSession | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const reorderingIdsRef = useRef(new Set<string>());
  const reducedMotionRef = useRef(reducedMotion);
  const siblingResetTimerRef = useRef<number | null>(null);
  const dropFlipTimerRef = useRef<number | null>(null);
  const pendingDropFlipRef = useRef<Map<string, { left: number; top: number }> | null>(null);
  const promptGridRef = useRef<HTMLDivElement | null>(null);

  selectedPromptIdRef.current = selectedPromptId;
  reducedMotionRef.current = reducedMotion;

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
      pointerDragRef.current = null;
      activeDragRef.current = null;
      reorderingIdsRef.current.clear();
      savingRef.current = false;
      if (drawerCloseTimer.current !== null) window.clearTimeout(drawerCloseTimer.current);
      if (siblingResetTimerRef.current !== null) window.clearTimeout(siblingResetTimerRef.current);
      if (dropFlipTimerRef.current !== null) window.clearTimeout(dropFlipTimerRef.current);
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return undefined;
    const update = () => setReducedMotion(media.matches);
    update();
    if (typeof media.addEventListener === "function") media.addEventListener("change", update);
    else media.addListener?.(update);
    return () => {
      if (typeof media.removeEventListener === "function") media.removeEventListener("change", update);
      else media.removeListener?.(update);
    };
  }, []);

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
  }, [query, tagKey, tagMode, pageSize, sortMode, clearSelection]);

  const request = useMemo<PromptListRequest>(() => ({
    page,
    pageSize,
    query,
    tagIds,
    tagMode,
    sort: sortMode,
  }), [page, pageSize, query, sortMode, tagIds, tagMode]);

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

  useLayoutEffect(() => {
    const previousPositions = pendingDropFlipRef.current;
    if (!previousPositions) return;
    pendingDropFlipRef.current = null;
    if (reducedMotionRef.current) return;
    const movedCards = promptCardElements().filter((card) => {
      const previous = previousPositions.get(card.dataset.promptId || "");
      if (!previous) return false;
      card.style.transition = "none";
      card.style.transform = "none";
      const next = card.getBoundingClientRect();
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
        card.style.removeProperty("transition");
        card.style.removeProperty("transform");
        return false;
      }
      card.setAttribute("data-drop-flip", "true");
      card.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
      return true;
    });
    if (!movedCards.length) return;
    if (promptGridRef.current) void promptGridRef.current.offsetWidth;
    window.requestAnimationFrame(() => {
      movedCards.forEach((card) => {
        card.style.removeProperty("transition");
        card.style.transform = "translate3d(0, 0, 0)";
      });
    });
    if (dropFlipTimerRef.current !== null) window.clearTimeout(dropFlipTimerRef.current);
    dropFlipTimerRef.current = window.setTimeout(() => {
      dropFlipTimerRef.current = null;
      movedCards.forEach((card) => {
        card.removeAttribute("data-drop-flip");
        card.style.removeProperty("transform");
        card.style.removeProperty("transition");
      });
    }, 180);
  }, [promptPage.items]);

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
      if (importPreview || importResult) return;
      if (activeDragRef.current) return;
      event.preventDefault();
      void closeDrawer("escape", { animate: false, restoreOpenerFocus: true });
    };
    window.addEventListener("keydown", onKeyDown);
    if (justOpened) window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => window.removeEventListener("keydown", onKeyDown);
    // closeDrawer intentionally reads the latest component state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPromptId, drawerMode, importPreview, importResult]);

  useEffect(() => {
    if (!importPreview && !importResult) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || importing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setImportPreview(null);
      setImportResult(null);
      setImportError("");
      window.setTimeout(() => importTriggerRef.current?.focus(), 0);
    };
    window.addEventListener("keydown", onKeyDown);
    window.setTimeout(() => {
      importDialogRef.current?.querySelector<HTMLElement>("button, select")?.focus();
    }, 0);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [importPreview, importResult, importing]);

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

  function cancelDrawerClose() {
    if (drawerCloseTimer.current !== null) {
      window.clearTimeout(drawerCloseTimer.current);
      drawerCloseTimer.current = null;
    }
    setDrawerClosing(false);
  }

  function resetDrawer() {
    cancelDrawerClose();
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

  function finishDrawerClose({
    focusTarget,
    restoreOpenerFocus,
  }: {
    focusTarget?: HTMLElement | null;
    restoreOpenerFocus: boolean;
  }) {
    resetDrawer();
    if (focusTarget) window.setTimeout(() => focusTarget.focus(), 0);
    else if (restoreOpenerFocus) restoreFocus();
  }

  function beginDrawerClose({
    animate,
    focusTarget,
    restoreOpenerFocus,
  }: {
    animate: boolean;
    focusTarget?: HTMLElement | null;
    restoreOpenerFocus: boolean;
  }) {
    cancelDrawerClose();
    if (!animate || reducedMotionRef.current) {
      finishDrawerClose({ focusTarget, restoreOpenerFocus });
      return;
    }
    setDrawerClosing(true);
    drawerCloseTimer.current = window.setTimeout(() => {
      drawerCloseTimer.current = null;
      finishDrawerClose({ focusTarget, restoreOpenerFocus });
    }, 160);
  }

  async function closeDrawer(
    context: PromptLeaveContext = "close",
    options: {
      animate?: boolean;
      focusTarget?: HTMLElement | null;
      restoreOpenerFocus?: boolean;
    } = {},
  ) {
    if (!(await canDiscard(context))) return;
    beginDrawerClose({
      animate: options.animate ?? false,
      focusTarget: options.focusTarget,
      restoreOpenerFocus: options.restoreOpenerFocus ?? true,
    });
  }

  async function openPrompt(id: string, trigger?: HTMLElement, motion: "instant" | "pointer" = "pointer") {
    if (id === selectedPromptId && drawerMode === "view" && detail) return;
    if (!(await canDiscard("switch"))) return;
    cancelDrawerClose();
    setDrawerMotion(motion);
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

  async function openCreate(trigger?: HTMLElement, motion: "instant" | "pointer" = "pointer") {
    if (!(await canDiscard("new"))) return;
    cancelDrawerClose();
    setDrawerMotion(motion);
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

  function closeImportDialog() {
    if (importing) return;
    setImportPreview(null);
    setImportResult(null);
    setImportError("");
    window.setTimeout(() => importTriggerRef.current?.focus(), 0);
  }

  async function previewPromptZipImport(
    trigger: HTMLElement,
    motion: "instant" | "pointer",
  ) {
    if (previewingImport || importing) return;
    if (!(await canDiscard("switch"))) return;
    importTriggerRef.current = trigger;
    setImportDialogMotion(motion);
    if (selectedPromptId || drawerMode === "create") resetDrawer();
    setPreviewingImport(true);
    setImportError("");
    setImportResult(null);
    try {
      const preview = await api.previewPromptsZipImport();
      if (!preview || !mounted.current) return;
      setImportStrategy("duplicate");
      setImportPreview(preview);
    } catch (reason) {
      if (mounted.current) {
        setStatusMessage(tr("importFailed", {
          message: localizedApiErrorMessage(reason, language, tr("batchImport")),
        }));
      }
    } finally {
      if (mounted.current) setPreviewingImport(false);
    }
  }

  async function importPromptZip() {
    if (!importPreview || importing) return;
    if (
      importStrategy === "overwrite"
      && importPreview.conflictCount > 0
      && !(await runConfirmed(
        "overwrite-import",
        importPreview.fileName,
        String(importPreview.conflictCount),
      ))
    ) return;

    setImporting(true);
    setImportError("");
    try {
      const result = await api.importPromptsZip({
        path: importPreview.path,
        sha256: importPreview.sha256,
        sizeBytes: importPreview.sizeBytes,
        expectedLibraryRevision: importPreview.libraryRevision,
        conflictStrategy: importStrategy,
      });
      if (!mounted.current) return;
      setImportResult(result);
      clearSelection();
      resetDrawer();
      setPage(1);
      await loadTags();
      if (mounted.current) setReloadToken((value) => value + 1);
    } catch (reason) {
      if (mounted.current) {
        setImportError(tr("importFailed", {
          message: localizedApiErrorMessage(reason, language, tr("batchImport")),
        }));
      }
    } finally {
      if (mounted.current) setImporting(false);
    }
  }

  async function createTag(event: FormEvent) {
    event.preventDefault();
    if (tagCreatingRef.current) return;
    const name = tagDraft.trim().normalize("NFC");
    if (!name || codePointLength(name) > 50) return;
    tagCreatingRef.current = true;
    setTagCreating(true);
    try {
      const created = await api.createTag(name);
      setTagDraft("");
      setTags((current) => current.some((tag) => tag.id === created.id) ? current : [...current, created]);
      await loadTags();
    } catch (reason) {
      setTagsError(localizedApiErrorMessage(reason, language, tr("tagCreate")));
    } finally {
      tagCreatingRef.current = false;
      if (mounted.current) setTagCreating(false);
    }
  }

  function replaceTagId(ids: string[], sourceId: string, targetId?: string) {
    return ids.reduce<string[]>((next, id) => {
      const candidate = id === sourceId ? targetId : id;
      if (candidate && !next.includes(candidate)) next.push(candidate);
      return next;
    }, []);
  }

  function replacePromptTags(promptTags: PromptTag[], sourceId: string, target?: PromptTag) {
    const next = promptTags
      .filter((tag) => tag.id !== sourceId && tag.id !== target?.id)
      .concat(target && promptTags.some((tag) => tag.id === sourceId || tag.id === target.id) ? [target] : []);
    return next;
  }

  function applyTagRename(updated: PromptTag) {
    setTags((current) => current.map((tag) => tag.id === updated.id ? updated : tag));
    setDetail((current) => current ? { ...current, tags: current.tags.map((tag) => tag.id === updated.id ? updated : tag) } : current);
    setPromptPage((current) => ({
      ...current,
      items: current.items.map((prompt) => ({
        ...prompt,
        tags: prompt.tags.map((tag) => tag.id === updated.id ? updated : tag),
      })),
    }));
  }

  function applyTagReplacement(sourceId: string, target?: PromptTag) {
    setTagIds((current) => replaceTagId(current, sourceId, target?.id));
    setDraft((current) => ({ ...current, tagIds: replaceTagId(current.tagIds, sourceId, target?.id) }));
    setBaseline((current) => ({ ...current, tagIds: replaceTagId(current.tagIds, sourceId, target?.id) }));
    setDetail((current) => current ? { ...current, tags: replacePromptTags(current.tags, sourceId, target) } : current);
    setPromptPage((current) => ({
      ...current,
      items: current.items.map((prompt) => ({
        ...prompt,
        tags: replacePromptTags(prompt.tags, sourceId, target),
      })),
    }));
    setTags((current) => {
      const withoutSource = current.filter((tag) => tag.id !== sourceId && tag.id !== target?.id);
      return target ? [...withoutSource, target] : withoutSource;
    });
  }

  function setTagPending(tagId: string, pending: boolean) {
    if (pending) tagPendingIdsRef.current.add(tagId);
    else tagPendingIdsRef.current.delete(tagId);
    setTagPendingIds(new Set(tagPendingIdsRef.current));
  }

  async function saveTagRename(tag: PromptTag) {
    if (tagPendingIdsRef.current.has(tag.id)) return;
    const name = renamingTagName.trim().normalize("NFC");
    if (!name || codePointLength(name) > 50) return;
    const collision = tags.find((candidate) => candidate.id !== tag.id && normalizeTagName(candidate.name) === normalizeTagName(name));
    setTagPending(tag.id, true);
    try {
      if (collision) {
        if (!(await runConfirmed("merge-tag", tag.name, collision.name))) return;
        const merged = await api.mergeTags(tag.id, collision.id);
        applyTagReplacement(tag.id, merged);
      } else {
        const updated = await api.renameTag(tag.id, name);
        applyTagRename(updated);
      }
      setRenamingTagId("");
      await loadTags();
      setReloadToken((value) => value + 1);
    } catch (reason) {
      setTagsError(localizedApiErrorMessage(reason, language, tr("tagRename")));
    } finally {
      setTagPending(tag.id, false);
    }
  }

  async function removeTag(tag: PromptTag) {
    if (tagPendingIdsRef.current.has(tag.id)) return;
    setTagPending(tag.id, true);
    try {
      if (!(await runConfirmed("delete-tag", tag.name))) return;
      await api.deleteTag(tag.id);
      applyTagReplacement(tag.id);
      await loadTags();
      setReloadToken((value) => value + 1);
    } catch (reason) {
      setTagsError(localizedApiErrorMessage(reason, language, tr("delete")));
    } finally {
      setTagPending(tag.id, false);
    }
  }

  function updateDragState(next: PromptDragState | null) {
    activeDragRef.current = next;
    setDragState(next);
  }

  function dragGroupIndices(prompt: PromptSummary) {
    return promptPage.items.reduce<number[]>((indices, candidate, index) => {
      if (candidate.pinned === prompt.pinned) indices.push(index);
      return indices;
    }, []);
  }

  function announceDragPosition(prompt: PromptSummary, targetIndex: number) {
    setDragAnnouncement(tr("movedTo", {
      title: prompt.title,
      position: (promptPage.page - 1) * promptPage.pageSize + targetIndex + 1,
    }));
  }

  function promptCardElements() {
    return Array.from(promptGridRef.current?.querySelectorAll<HTMLElement>(".prompt-card[data-prompt-id]") ?? []);
  }

  function clearSiblingPreview(animate: boolean) {
    if (siblingResetTimerRef.current !== null) {
      window.clearTimeout(siblingResetTimerRef.current);
      siblingResetTimerRef.current = null;
    }
    const cards = promptCardElements().filter((card) => card.hasAttribute("data-drag-shift"));
    const removeStyles = () => {
      cards.forEach((card) => {
        card.removeAttribute("data-drag-shift");
        card.style.removeProperty("--prompt-drag-x");
        card.style.removeProperty("--prompt-drag-y");
      });
    };
    if (!animate || reducedMotionRef.current) {
      removeStyles();
      return;
    }
    cards.forEach((card) => {
      card.style.setProperty("--prompt-drag-x", "0px");
      card.style.setProperty("--prompt-drag-y", "0px");
    });
    siblingResetTimerRef.current = window.setTimeout(() => {
      siblingResetTimerRef.current = null;
      removeStyles();
    }, 170);
  }

  function previewSiblingPositions(
    prompt: PromptSummary,
    session: PromptPointerSession,
    targetIndex: number,
  ) {
    if (reducedMotionRef.current) {
      clearSiblingPreview(false);
      return;
    }
    const nextItems = [...promptPage.items];
    nextItems.splice(session.sourceIndex, 1);
    nextItems.splice(targetIndex, 0, prompt);
    const targetIndices = new Map(nextItems.map((candidate, index) => [candidate.id, index]));
    const slotRects = promptPage.items.map((candidate) => session.cardRects.get(candidate.id));

    promptCardElements().forEach((card) => {
      const id = card.dataset.promptId || "";
      if (id === prompt.id) return;
      const originalIndex = session.itemIndices.get(id);
      const targetPosition = targetIndices.get(id);
      const origin = session.cardRects.get(id);
      const destination = targetPosition === undefined ? undefined : slotRects[targetPosition];
      if (originalIndex === undefined || targetPosition === undefined || !origin || !destination) return;
      const deltaX = destination.left - origin.left;
      const deltaY = destination.top - origin.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5 && !card.hasAttribute("data-drag-shift")) return;
      const translateX = `${deltaX}px`;
      const translateY = `${deltaY}px`;
      if (!card.hasAttribute("data-drag-shift")) card.setAttribute("data-drag-shift", "true");
      if (card.style.getPropertyValue("--prompt-drag-x") !== translateX) {
        card.style.setProperty("--prompt-drag-x", translateX);
      }
      if (card.style.getPropertyValue("--prompt-drag-y") !== translateY) {
        card.style.setProperty("--prompt-drag-y", translateY);
      }
    });
  }

  function preparePointerDropFlip(sourceId: string) {
    if (reducedMotionRef.current) {
      clearSiblingPreview(false);
      return;
    }
    const cards = promptCardElements();
    pendingDropFlipRef.current = new Map(cards.filter((card) => card.dataset.promptId !== sourceId).map((card) => {
      const rect = card.getBoundingClientRect();
      return [card.dataset.promptId || "", { left: rect.left, top: rect.top }];
    }));
    cards.forEach((card) => {
      card.style.transition = "none";
      card.style.transform = "none";
      card.removeAttribute("data-drag-shift");
      card.style.removeProperty("--prompt-drag-x");
      card.style.removeProperty("--prompt-drag-y");
    });
    if (promptGridRef.current) void promptGridRef.current.offsetWidth;
  }

  async function reorderPromptToIndex(
    prompt: PromptSummary,
    requestedIndex: number,
    boundary?: "first" | "last",
  ) {
    if (!manualReorderEnabled || reorderingIdsRef.current.size > 0) return;
    const sourceIndex = promptPage.items.findIndex((candidate) => candidate.id === prompt.id);
    if (sourceIndex < 0) return;
    const groupIndices = dragGroupIndices(prompt);
    const firstIndex = groupIndices[0];
    const lastIndex = groupIndices.at(-1);
    if (firstIndex === undefined || lastIndex === undefined) return;
    const targetIndex = Math.min(lastIndex, Math.max(firstIndex, requestedIndex));
    if (!boundary && targetIndex === sourceIndex) return;

    const previousItems = promptPage.items;
    const nextItems = [...previousItems];
    nextItems.splice(sourceIndex, 1);
    nextItems.splice(targetIndex, 0, prompt);
    const positionedIndex = nextItems.findIndex((candidate) => candidate.id === prompt.id);
    const previous = nextItems[positionedIndex - 1];
    const next = nextItems[positionedIndex + 1];
    const previousId = boundary ? null : previous?.pinned === prompt.pinned ? previous.id : null;
    const nextId = boundary ? null : next?.pinned === prompt.pinned ? next.id : null;

    reorderingIdsRef.current.add(prompt.id);
    setReorderingIds(new Set(reorderingIdsRef.current));
    setPromptPage((current) => ({ ...current, items: nextItems }));
    announceDragPosition(prompt, targetIndex);
    try {
      const response = await api.reorderPrompt({
        id: prompt.id,
        previousId,
        nextId,
        ...(boundary ? { boundary } : {}),
        expectedRevision: prompt.revision,
        expectedLibraryRevision: promptPage.libraryRevision,
      });
      if (!mounted.current) return;
      setPromptPage((current) => ({ ...current, libraryRevision: response.libraryRevision }));
      if (boundary) setReloadToken((value) => value + 1);
    } catch (reason) {
      if (!mounted.current) return;
      setPromptPage((current) => ({ ...current, items: previousItems }));
      setDragAnnouncement(tr("reorderFailed", {
        message: localizedApiErrorMessage(reason, language, tr("sortManual")),
      }));
      setReloadToken((value) => value + 1);
    } finally {
      reorderingIdsRef.current.delete(prompt.id);
      if (mounted.current) setReorderingIds(new Set(reorderingIdsRef.current));
    }
  }

  function startPointerDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    prompt: PromptSummary,
    sourceIndex: number,
  ) {
    event.stopPropagation();
    if (!manualReorderEnabled || reorderingIdsRef.current.size > 0) return;
    const card = event.currentTarget.closest<HTMLElement>(".prompt-card");
    if (!card) return;
    clearSiblingPreview(false);
    const rect = card.getBoundingClientRect();
    const cardRects = new Map(promptCardElements().map((candidate) => {
      const candidateRect = candidate.getBoundingClientRect();
      return [candidate.dataset.promptId || "", { left: candidateRect.left, top: candidateRect.top }];
    }));
    pointerDragRef.current = {
      id: prompt.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      sourceIndex,
      active: false,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      cardRects,
      itemIndices: new Map(promptPage.items.map((candidate, index) => [candidate.id, index])),
      previewTargetIndex: null,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePointerDrag(event: ReactPointerEvent<HTMLButtonElement>, prompt: PromptSummary) {
    const session = pointerDragRef.current;
    if (!session || session.id !== prompt.id || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = event.clientX - session.startX;
    const deltaY = event.clientY - session.startY;
    if (!session.active && Math.hypot(deltaX, deltaY) < 6) return;
    session.active = true;

    const hit = typeof document.elementFromPoint === "function"
      ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".prompt-card[data-prompt-index]")
      : null;
    let overIndex = activeDragRef.current?.overIndex ?? session.sourceIndex;
    let edge: "before" | "after" = activeDragRef.current?.edge ?? "before";
    let targetIndex = activeDragRef.current?.targetIndex ?? session.sourceIndex;
    if (hit) {
      const candidateIndex = Number(hit.dataset.promptIndex);
      const candidate = promptPage.items[candidateIndex];
      if (candidate && candidate.pinned === prompt.pinned) {
        const rect = hit.getBoundingClientRect();
        const verticalDistance = Math.abs(event.clientY - (rect.top + rect.height / 2));
        const before = verticalDistance > rect.height * 0.25
          ? event.clientY < rect.top + rect.height / 2
          : event.clientX < rect.left + rect.width / 2;
        overIndex = candidateIndex;
        edge = before ? "before" : "after";
        let insertionIndex = candidateIndex + (before ? 0 : 1);
        if (insertionIndex > session.sourceIndex) insertionIndex -= 1;
        const group = dragGroupIndices(prompt);
        targetIndex = Math.min(group.at(-1) ?? session.sourceIndex, Math.max(group[0] ?? session.sourceIndex, insertionIndex));
      }
    }

    const next: PromptDragState = {
      id: prompt.id,
      title: prompt.title,
      sourceIndex: session.sourceIndex,
      targetIndex,
      overIndex,
      edge,
      input: "pointer",
      rect: session.rect,
      deltaX,
      deltaY,
    };
    activeDragRef.current = next;
    setDragState((current) => (
      current
      && current.overIndex === next.overIndex
      && current.edge === next.edge
      && current.targetIndex === next.targetIndex
        ? current
        : next
    ));
    if (dragGhostRef.current) {
      dragGhostRef.current.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    }
    if (session.previewTargetIndex !== targetIndex) {
      session.previewTargetIndex = targetIndex;
      previewSiblingPositions(prompt, session, targetIndex);
      announceDragPosition(prompt, targetIndex);
    }
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, prompt: PromptSummary) {
    const session = pointerDragRef.current;
    if (!session || session.id !== prompt.id || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const completed = session.active ? activeDragRef.current : null;
    pointerDragRef.current = null;
    if (completed && completed.targetIndex !== completed.sourceIndex) preparePointerDropFlip(prompt.id);
    else clearSiblingPreview(true);
    updateDragState(null);
    if (completed) void reorderPromptToIndex(prompt, completed.targetIndex);
  }

  function cancelPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const session = pointerDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    pointerDragRef.current = null;
    clearSiblingPreview(true);
    updateDragState(null);
  }

  function dragHandleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    prompt: PromptSummary,
    sourceIndex: number,
  ) {
    event.stopPropagation();
    const active = activeDragRef.current;
    if (event.key === "Escape" && active?.id === prompt.id) {
      event.preventDefault();
      updateDragState(null);
      setDragAnnouncement(tr("dragCancelled", { title: prompt.title }));
      return;
    }
    if (!manualReorderEnabled || reorderingIdsRef.current.size > 0) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (active?.id === prompt.id && active.input === "keyboard") {
        const targetIndex = active.targetIndex;
        updateDragState(null);
        void reorderPromptToIndex(prompt, targetIndex);
      } else {
        clearSiblingPreview(false);
        const card = event.currentTarget.closest<HTMLElement>(".prompt-card");
        const rect = card?.getBoundingClientRect();
        updateDragState({
          id: prompt.id,
          title: prompt.title,
          sourceIndex,
          targetIndex: sourceIndex,
          overIndex: sourceIndex,
          edge: "before",
          input: "keyboard",
          rect: {
            left: rect?.left ?? 0,
            top: rect?.top ?? 0,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
          },
          deltaX: 0,
          deltaY: 0,
        });
      }
      return;
    }
    if (active?.id !== prompt.id || active.input !== "keyboard") return;
    const group = dragGroupIndices(prompt);
    const firstIndex = group[0] ?? sourceIndex;
    const lastIndex = group.at(-1) ?? sourceIndex;
    let targetIndex = active.targetIndex;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") targetIndex -= 1;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") targetIndex += 1;
    else if (event.key === "Home") targetIndex = firstIndex;
    else if (event.key === "End") targetIndex = lastIndex;
    else return;
    event.preventDefault();
    targetIndex = Math.min(lastIndex, Math.max(firstIndex, targetIndex));
    const next = {
      ...active,
      targetIndex,
      overIndex: targetIndex,
      edge: targetIndex < sourceIndex ? "before" as const : "after" as const,
    };
    updateDragState(next);
    announceDragPosition(prompt, targetIndex);
  }

  const filteredTags = tags.filter((tag) => normalizeTagName(tag.name).includes(normalizeTagName(tagSearch)));
  const filteredManagedTags = tags.filter((tag) => normalizeTagName(tag.name).includes(normalizeTagName(tagManagerSearch)));
  const drawerOpen = Boolean(selectedPromptId) || drawerMode === "create";
  const manualReorderEnabled = sortMode === "manual"
    && !queryInput.trim()
    && !query
    && tagIds.length === 0
    && !loading
    && reorderingIds.size === 0
    && !drawerOpen
    && selectedCount === 0
    && !exporting
    && !previewingImport
    && !importing
    && !importPreview
    && !importResult;
  const drawerTitle = drawerMode === "create" ? tr("create") : detail?.title || tr("loadingDetail");

  function cardKeyDown(event: KeyboardEvent<HTMLElement>, prompt: PromptSummary) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void openPrompt(prompt.id, event.currentTarget, "instant");
  }

  function rootClickCapture(event: MouseEvent<HTMLElement>) {
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    if (tagManagerOpen && !tagManagerRef.current?.contains(element)) setTagManagerOpen(false);
    if (moveMenuId && !element.closest(".prompt-move-menu")) setMoveMenuId("");
    if (!drawerOpen || drawerClosing || drawerRef.current?.contains(element)) return;

    const card = element.closest(".prompt-card");
    const nestedCardControl = element.closest("button, input, label, summary, select, textarea, a");
    if ((card && !nestedCardControl) || element.closest("[data-prompt-drawer-intent]")) return;

    const focusTarget = element.closest<HTMLElement>(
      "button, input, summary, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
    );
    if (savingRef.current || dirty) {
      event.preventDefault();
      event.stopPropagation();
      void closeDrawer("outside", {
        animate: event.detail !== 0,
        focusTarget,
        restoreOpenerFocus: !focusTarget,
      });
      return;
    }
    beginDrawerClose({
      animate: event.detail !== 0,
      focusTarget: null,
      restoreOpenerFocus: false,
    });
  }

  function stop(event: MouseEvent) {
    event.stopPropagation();
  }

  return (
    <section
      className={`prompts-view${drawerOpen ? " has-drawer" : ""}`}
      data-density={compact ? "compact" : "comfortable"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-theme={theme}
      onClickCapture={rootClickCapture}
    >
      <h1 className="sr-only">{language === "zh" ? "提示词库" : "Prompt Library"}</h1>
      <div className="prompt-toolbar" role="toolbar">
        <button className="prompt-button" data-prompt-drawer-intent onClick={(event) => void openCreate(event.currentTarget, event.detail === 0 ? "instant" : "pointer")} type="button">
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
        <div className="prompt-segmented prompt-sort-toggle" aria-label={tr("sortLabel")}>
          <button aria-pressed={sortMode === "manual"} onClick={() => setSortMode("manual")} type="button">{tr("sortManual")}</button>
          <button aria-pressed={sortMode === "updatedDesc"} onClick={() => setSortMode("updatedDesc")} type="button">{tr("sortUpdated")}</button>
        </div>
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
        <div className="prompt-tag-manager-anchor" data-prompt-drawer-intent ref={tagManagerRef}>
          <button
            aria-controls="prompt-tag-manager"
            aria-expanded={tagManagerOpen}
            className="prompt-button"
            onClick={(event) => {
              if (!tagManagerOpen) setTagManagerMotion(event.detail === 0 ? "instant" : "pointer");
              setTagManagerOpen((value) => !value);
            }}
            type="button"
          ><Icon name="tag" />{tr("manageTags")}</button>
          {tagManagerOpen && (
            <section
              aria-label={tr("manageTags")}
              aria-modal="false"
              className="prompt-tag-manager"
              data-motion={tagManagerMotion}
              id="prompt-tag-manager"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setRenamingTagId("");
                setTagManagerOpen(false);
              }}
              role="dialog"
            >
              <div className="prompt-tag-manager-heading">
                <strong>{tr("manageTags")}</strong>
                <button aria-label={tr("close")} className="prompt-icon-button" onClick={() => setTagManagerOpen(false)} type="button"><Icon name="close" /></button>
              </div>
              <form className="prompt-tag-create" onSubmit={createTag}>
                <label><span className="sr-only">{tr("tagName")}</span><input aria-label={tr("tagName")} disabled={tagCreating} onChange={(event) => setTagDraft(event.target.value)} placeholder={tr("tagName")} value={tagDraft} /></label>
                <button className="prompt-button prompt-button-primary" disabled={tagCreating} type="submit">{tr("tagCreate")}</button>
              </form>
              <label className="prompt-tag-manager-search">
                <span className="sr-only">{tr("tagManagerSearch")}</span>
                <Icon name="search" />
                <input aria-label={tr("tagManagerSearch")} onChange={(event) => setTagManagerSearch(event.target.value)} placeholder={tr("tagManagerSearch")} type="search" value={tagManagerSearch} />
              </label>
              {tagsError && <p className="prompt-inline-error" role="alert">{tagsError}</p>}
              <div className="prompt-tag-manager-list">
                {filteredManagedTags.map((tag) => (
                  <div className="prompt-tag-manager-row" key={tag.id}>
                    {renamingTagId === tag.id ? (
                      <input
                        aria-label={`${tr("tagRename")}: ${tag.name}`}
                        autoFocus
                        disabled={tagPendingIds.has(tag.id)}
                        onChange={(event) => setRenamingTagName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") { event.preventDefault(); void saveTagRename(tag); }
                          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setRenamingTagId(""); }
                        }}
                        value={renamingTagName}
                      />
                    ) : <span>{tag.name}<small>{tag.promptCount ?? 0}</small></span>}
                    <div>
                      {renamingTagId === tag.id ? (
                        <button className="prompt-text-button" disabled={tagPendingIds.has(tag.id)} onClick={() => void saveTagRename(tag)} type="button">{tr("tagSave")}</button>
                      ) : (
                        <button className="prompt-text-button" disabled={tagPendingIds.has(tag.id)} onClick={() => { setRenamingTagId(tag.id); setRenamingTagName(tag.name); }} type="button">{tr("tagRename")}</button>
                      )}
                      <button aria-label={tr("tagDelete", { name: tag.name })} className="prompt-text-button prompt-danger-text" disabled={tagPendingIds.has(tag.id)} onClick={() => void removeTag(tag)} type="button">{tr("delete")}</button>
                    </div>
                  </div>
                ))}
                {!filteredManagedTags.length && <p className="prompt-muted">{tr("noTags")}</p>}
              </div>
            </section>
          )}
        </div>
        <button
          className="prompt-button"
          data-prompt-drawer-intent
          disabled={previewingImport || importing}
          onClick={(event) => void previewPromptZipImport(event.currentTarget, event.detail === 0 ? "instant" : "pointer")}
          type="button"
        ><Icon name="upload" />{tr("batchImport")}</button>
        <button className="prompt-button" disabled={!selectedCount || exporting} onClick={() => void exportSelection()} type="button"><Icon name="download" />{tr("batchExport")}</button>
      </div>

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
      <div aria-atomic="true" aria-live="polite" className="sr-only">{dragAnnouncement}</div>
      <p className="sr-only" id="prompt-drag-help">
        {language === "zh"
          ? "按空格抓取卡片，使用方向键移动，再按空格确认；按 Escape 取消。"
          : "Press Space to pick up a card, use the arrow keys to move it, then press Space to drop. Press Escape to cancel."}
      </p>

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
            {!query && !tagIds.length && (
              <div className="prompt-empty-actions">
                <button className="prompt-button prompt-button-primary" data-prompt-drawer-intent onClick={(event) => void openCreate(event.currentTarget, event.detail === 0 ? "instant" : "pointer")} type="button">{tr("add")}</button>
                <button className="prompt-button" data-prompt-drawer-intent disabled={previewingImport || importing} onClick={(event) => void previewPromptZipImport(event.currentTarget, event.detail === 0 ? "instant" : "pointer")} type="button"><Icon name="upload" />{tr("batchImport")}</button>
              </div>
            )}
          </div>
        )}
        {!loading && !error && promptPage.items.length > 0 && (
          <div className="prompt-grid" ref={promptGridRef}>
            {promptPage.items.map((prompt) => {
              const promptIndex = promptPage.items.findIndex((candidate) => candidate.id === prompt.id);
              const groupIndices = dragGroupIndices(prompt);
              const isDragSource = dragState?.id === prompt.id;
              const isDropTarget = dragState?.id !== prompt.id && dragState?.overIndex === promptIndex;
              return (
                <article
                  aria-label={prompt.title}
                  className={`prompt-card${selectedPromptId === prompt.id ? " is-open" : ""}${isDragSource && dragState?.input === "pointer" ? " is-drag-placeholder" : ""}${isDragSource && dragState?.input === "keyboard" ? " is-keyboard-drag" : ""}${isDropTarget ? ` is-drop-${dragState.edge}` : ""}`}
                  data-prompt-id={prompt.id}
                  data-drag-input={isDragSource ? dragState?.input : undefined}
                  data-prompt-index={promptIndex}
                  data-prompt-pinned={prompt.pinned ? "true" : "false"}
                  key={prompt.id}
                  onClick={(event) => void openPrompt(prompt.id, event.currentTarget, event.detail === 0 ? "instant" : "pointer")}
                  onKeyDown={(event) => cardKeyDown(event, prompt)}
                  tabIndex={0}
                >
                  <div className="prompt-card-head">
                    <button
                      aria-describedby="prompt-drag-help"
                      aria-label={tr("dragMove", { title: prompt.title })}
                      aria-pressed={isDragSource}
                      className="prompt-drag-handle"
                      disabled={!manualReorderEnabled}
                      onClick={stop}
                      onKeyDown={(event) => dragHandleKeyDown(event, prompt, promptIndex)}
                      onPointerCancel={cancelPointerDrag}
                      onPointerDown={(event) => startPointerDrag(event, prompt, promptIndex)}
                      onPointerMove={(event) => movePointerDrag(event, prompt)}
                      onPointerUp={(event) => finishPointerDrag(event, prompt)}
                      title={manualReorderEnabled ? tr("dragMove", { title: prompt.title }) : tr("dragUnavailable")}
                      type="button"
                    ><Icon name="drag" /></button>
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
                  <PromptCardTags tags={prompt.tags} />
                  <PromptExcerpt excerpt={prompt.excerpt} />
                  <footer>
                    <time dateTime={prompt.updatedAt}>{tr("updated", { date: formatDate(prompt.updatedAt, language) })}</time>
                    <div className="prompt-move-menu" onClick={stop}>
                      <button
                        aria-expanded={moveMenuId === prompt.id}
                        aria-label={tr("dragOptions", { title: prompt.title })}
                        onClick={() => setMoveMenuId((current) => current === prompt.id ? "" : prompt.id)}
                        type="button"
                      ><Icon name="more" /></button>
                      {moveMenuId === prompt.id && <div>
                        <button
                          disabled={!manualReorderEnabled}
                          onClick={() => {
                            setMoveMenuId("");
                            void reorderPromptToIndex(prompt, groupIndices[0] ?? promptIndex, "first");
                          }}
                          type="button"
                        >{tr("moveFirst")}</button>
                        <button
                          disabled={!manualReorderEnabled}
                          onClick={() => {
                            setMoveMenuId("");
                            void reorderPromptToIndex(prompt, groupIndices.at(-1) ?? promptIndex, "last");
                          }}
                          type="button"
                        >{tr("moveLast")}</button>
                      </div>}
                    </div>
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
        {dragState?.input === "pointer" && (
          <div
            aria-hidden="true"
            className="prompt-drag-ghost"
            ref={dragGhostRef}
            style={{
              height: dragState.rect.height,
              left: dragState.rect.left,
              top: dragState.rect.top,
              transform: `translate3d(${dragState.deltaX}px, ${dragState.deltaY}px, 0)`,
              width: dragState.rect.width,
            }}
          ><Icon name="drag" /><span>{dragState.title}</span></div>
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

      {(importPreview || importResult) && (
        <div className="prompt-modal-layer">
          <section
            aria-label={tr("importDialogTitle")}
            aria-modal="true"
            className="prompt-import-dialog"
            data-motion={importDialogMotion}
            ref={importDialogRef}
            role="dialog"
          >
            <header>
              <div>
                <h2>{importResult ? tr("importComplete") : tr("importDialogTitle")}</h2>
                {importPreview && <p title={importPreview.path}>{importPreview.fileName}</p>}
              </div>
              <button aria-label={tr("close")} className="prompt-icon-button" disabled={importing} onClick={closeImportDialog} type="button"><Icon name="close" /></button>
            </header>

            {importResult ? (
              <div className="prompt-import-result">
                <div className="prompt-import-success" aria-hidden="true">✓</div>
                <p>{tr("importResult", { inserted: importResult.inserted, overwritten: importResult.overwritten })}</p>
                <p className="prompt-muted">
                  {tr("importTags", { created: importResult.tagsCreated, reused: importResult.tagsReused })}
                  {importResult.duplicated > 0 ? ` · ${language === "zh" ? `副本 ${importResult.duplicated}` : `${importResult.duplicated} copies`}` : ""}
                  {importResult.skipped > 0 ? ` · ${language === "zh" ? `跳过 ${importResult.skipped}` : `${importResult.skipped} skipped`}` : ""}
                </p>
              </div>
            ) : importPreview && (
              <>
                <div className="prompt-import-body">
                  <div className="prompt-import-metrics" aria-label={tr("importMetrics", { count: importPreview.promptCount })}>
                    <strong>{tr("importMetrics", { count: importPreview.promptCount })}</strong>
                    <span>{tr("importNew", { count: importPreview.newCount })}</span>
                    <span>{tr("importIdentical", { count: importPreview.identicalCount })}</span>
                    <span>{tr("importConflicts", { count: importPreview.conflictCount })}</span>
                  </div>
                  <p className="prompt-import-tags">{tr("importTags", { created: importPreview.tagsToCreate, reused: importPreview.tagsToReuse })}</p>

                  {importPreview.conflicts.length > 0 && (
                    <div className="prompt-import-conflicts">
                      <h3>{tr("importConflicts", { count: importPreview.conflictCount })}</h3>
                      <div className="prompt-import-conflict-list">
                        {importPreview.conflicts.map((conflict) => (
                          <article key={conflict.id}>
                            <code>{conflict.id}</code>
                            <p>{tr("conflictImported", { title: conflict.importedTitle })}</p>
                            <p>{tr("conflictLocal", { title: conflict.localTitle })}</p>
                          </article>
                        ))}
                      </div>
                    </div>
                  )}

                  <label className="prompt-import-strategy">
                    <span>{tr("conflictStrategy")}</span>
                    <select
                      aria-label={tr("conflictStrategy")}
                      className={importStrategy === "overwrite" ? "is-danger" : ""}
                      disabled={importing}
                      onChange={(event) => setImportStrategy(event.target.value as PromptZipConflictStrategy)}
                      value={importStrategy}
                    >
                      <option value="duplicate">{tr("strategyDuplicate")}</option>
                      <option value="keep-local">{tr("strategyKeepLocal")}</option>
                      <option value="overwrite">{tr("strategyOverwrite")}</option>
                    </select>
                  </label>
                  <p className="prompt-import-warning">{tr("importPlaintextWarning")}</p>
                  {importError && <p className="prompt-inline-error" role="alert">{importError}</p>}
                </div>
              </>
            )}

            <footer>
              {importResult ? (
                <button className="prompt-button prompt-button-primary" onClick={closeImportDialog} type="button">{tr("close")}</button>
              ) : (
                <>
                  <button className="prompt-button" disabled={importing} onClick={closeImportDialog} type="button">{tr("cancel")}</button>
                  <button className={`prompt-button prompt-button-primary${importStrategy === "overwrite" ? " prompt-button-danger" : ""}`} disabled={importing} onClick={() => void importPromptZip()} type="button">{importing ? tr("importing") : tr("importPrompts")}</button>
                </>
              )}
            </footer>
          </section>
        </div>
      )}

      {drawerOpen && (
        <div className={`prompt-drawer-layer${drawerClosing ? " is-closing" : ""}`} data-motion={drawerMotion}>
          <aside aria-label={drawerTitle} aria-modal="false" className="prompt-drawer" ref={drawerRef} role="dialog">
            <header className="prompt-drawer-header">
              <div>
                <h2>{drawerTitle}</h2>
                {detail && drawerMode === "view" && (
                  <div className="prompt-drawer-tags">{detail.tags.map((tag) => <span className="prompt-tag" key={tag.id}>{tag.name}</span>)}</div>
                )}
              </div>
              <button aria-label={tr("close")} className="prompt-icon-button" onClick={(event) => void closeDrawer("close", { animate: event.detail !== 0, restoreOpenerFocus: true })} ref={closeButtonRef} type="button"><Icon name="close" /></button>
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
