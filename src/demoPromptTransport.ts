import type {
  CreatePromptRequest,
  PromptDetail,
  PromptExportSummary,
  PromptListFilter,
  PromptListRequest,
  PromptPage,
  PromptSelection,
  PromptSummary,
  PromptTag,
  PromptZipImportPreview,
  PromptZipImportRequest,
  PromptZipImportResult,
  ReorderPromptRequest,
  ReorderPromptResult,
  UpdatePromptRequest,
} from "./api";

type DemoArchive = {
  path: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  prompts: PromptDetail[];
};

export class DemoPromptTransport {
  private readonly now: () => Date;
  private prompts: PromptDetail[];
  private tags: PromptTag[];
  private archive: DemoArchive | null = null;
  private libraryRevision = 1;
  private nextPromptId = 3;
  private nextTagId = 1;

  constructor(now: () => Date) {
    this.now = now;
    this.tags = [
      demoPromptTag("research", "研究"),
      demoPromptTag("release", "发布"),
    ];
    this.prompts = [
      demoPrompt("demo-prompt-1", "本地优先检查清单", "# 检查\n\n验证本地状态与公开实物。", [this.tags[0]], true),
      demoPrompt("demo-prompt-2", "发布异常处置", "# 处置\n\n上传不明时先查询远端。", [this.tags[1]], false),
    ];
  }

  async listPrompts(request: PromptListRequest): Promise<PromptPage> {
    let prompts = this.prompts.filter((prompt) => promptMatchesFilter(prompt, request));
    if (request.sort === "updatedDesc") {
      prompts = [...prompts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    const totalPages = Math.max(1, Math.ceil(prompts.length / request.pageSize));
    const page = Math.min(Math.max(1, request.page), totalPages);
    const start = (page - 1) * request.pageSize;
    return clone({
      items: prompts.slice(start, start + request.pageSize).map(promptSummary),
      total: prompts.length,
      page,
      pageSize: request.pageSize,
      totalPages,
      libraryRevision: this.libraryRevision,
    });
  }

  async getPromptDetail(id: string): Promise<PromptDetail> {
    return clone(this.requirePrompt(id));
  }

  async createPrompt(request: CreatePromptRequest): Promise<PromptDetail> {
    const prompt = demoPrompt(
      `demo-prompt-${this.nextPromptId++}`,
      request.title,
      request.content,
      this.promptTags(request.tagIds),
      Boolean(request.pinned),
      this.now().toISOString(),
    );
    this.prompts = [prompt, ...this.prompts];
    this.libraryRevision += 1;
    return clone(prompt);
  }

  async updatePrompt(request: UpdatePromptRequest): Promise<PromptDetail> {
    const current = this.requirePrompt(request.id);
    this.requirePromptRevision(current, request.expectedRevision);
    const updated = {
      ...current,
      title: request.title,
      content: request.content,
      excerpt: promptExcerpt(request.content),
      contentBytes: byteLength(request.content),
      tags: this.promptTags(request.tagIds),
      pinned: Boolean(request.pinned),
      updatedAt: this.now().toISOString(),
      revision: current.revision + 1,
    };
    this.prompts = this.prompts.map((prompt) => prompt.id === request.id ? updated : prompt);
    this.libraryRevision += 1;
    return clone(updated);
  }

  async deletePrompt(id: string, expectedRevision: number): Promise<void> {
    const current = this.requirePrompt(id);
    this.requirePromptRevision(current, expectedRevision);
    this.prompts = this.prompts.filter((prompt) => prompt.id !== id);
    this.libraryRevision += 1;
  }

  async setPromptPinned(id: string, pinned: boolean, expectedRevision: number): Promise<PromptSummary> {
    const current = this.requirePrompt(id);
    this.requirePromptRevision(current, expectedRevision);
    const updated = {
      ...current,
      pinned,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    this.prompts = this.prompts.map((prompt) => prompt.id === id ? updated : prompt);
    this.libraryRevision += 1;
    return clone(promptSummary(updated));
  }

  async reorderPrompt(request: ReorderPromptRequest): Promise<ReorderPromptResult> {
    if (request.expectedLibraryRevision !== this.libraryRevision) {
      throw new Error("Prompt library changed.");
    }
    const current = this.requirePrompt(request.id);
    this.requirePromptRevision(current, request.expectedRevision);
    const withoutCurrent = this.prompts.filter((prompt) => prompt.id !== current.id);
    let insertAt: number;

    if (request.boundary) {
      if (request.previousId || request.nextId) throw new Error("Prompt reorder boundary cannot have neighbors.");
      const groupIndices = withoutCurrent
        .map((prompt, index) => ({ prompt, index }))
        .filter(({ prompt }) => prompt.pinned === current.pinned)
        .map(({ index }) => index);
      insertAt = request.boundary === "first"
        ? (groupIndices[0] ?? 0)
        : ((groupIndices.at(-1) ?? (withoutCurrent.length - 1)) + 1);
    } else {
      if (!request.previousId && !request.nextId) throw new Error("Prompt reorder needs a target gap.");
      const previous = request.previousId ? this.requirePrompt(request.previousId) : null;
      const next = request.nextId ? this.requirePrompt(request.nextId) : null;
      if (previous?.id === current.id || next?.id === current.id) throw new Error("Prompt cannot anchor itself.");
      if (previous && previous.pinned !== current.pinned) throw new Error("Prompt cannot cross pinned groups.");
      if (next && next.pinned !== current.pinned) throw new Error("Prompt cannot cross pinned groups.");
      const previousIndex = previous ? withoutCurrent.findIndex((prompt) => prompt.id === previous.id) : -1;
      const nextIndex = next ? withoutCurrent.findIndex((prompt) => prompt.id === next.id) : -1;
      if (previous && previousIndex < 0) throw new Error("Previous prompt is missing.");
      if (next && nextIndex < 0) throw new Error("Next prompt is missing.");
      if (previous && next && nextIndex !== previousIndex + 1) {
        throw new Error("Prompt reorder neighbors changed.");
      }
      insertAt = previous ? previousIndex + 1 : nextIndex;
    }

    const reordered = [...withoutCurrent];
    reordered.splice(Math.max(0, insertAt), 0, current);
    if (reordered.some((prompt, index) => prompt.id !== this.prompts[index]?.id)) {
      this.prompts = reordered;
      this.libraryRevision += 1;
    }
    return { libraryRevision: this.libraryRevision };
  }

  async listPromptTags(): Promise<PromptTag[]> {
    return clone(this.tags.map((tag) => ({
      ...tag,
      promptCount: this.prompts.filter((prompt) => prompt.tags.some((candidate) => candidate.id === tag.id)).length,
    })));
  }

  async createPromptTag(name: string): Promise<PromptTag> {
    const normalized = name.trim().normalize("NFC");
    const existing = this.tags.find((tag) => tag.name.normalize("NFC") === normalized);
    if (existing) return clone(existing);
    const tag = demoPromptTag(`demo-tag-${this.nextTagId++}`, normalized, this.now().toISOString());
    this.tags = [...this.tags, tag];
    this.libraryRevision += 1;
    return clone(tag);
  }

  async renamePromptTag(tagId: string, name: string): Promise<PromptTag> {
    const current = this.requireTag(tagId);
    const updated = { ...current, name: name.trim().normalize("NFC"), updatedAt: this.now().toISOString() };
    this.tags = this.tags.map((tag) => tag.id === tagId ? updated : tag);
    this.prompts = this.prompts.map((prompt) => ({
      ...prompt,
      tags: prompt.tags.map((tag) => tag.id === tagId ? updated : tag),
    }));
    this.libraryRevision += 1;
    return clone(updated);
  }

  async mergePromptTags(sourceTagId: string, targetTagId: string): Promise<PromptTag> {
    const target = this.requireTag(targetTagId);
    this.requireTag(sourceTagId);
    this.prompts = this.prompts.map((prompt) => {
      if (!prompt.tags.some((tag) => tag.id === sourceTagId)) return prompt;
      return {
        ...prompt,
        tags: [...prompt.tags.filter((tag) => tag.id !== sourceTagId && tag.id !== targetTagId), target],
      };
    });
    this.tags = this.tags.filter((tag) => tag.id !== sourceTagId);
    this.libraryRevision += 1;
    return clone(target);
  }

  async deletePromptTag(tagId: string): Promise<void> {
    this.requireTag(tagId);
    this.tags = this.tags.filter((tag) => tag.id !== tagId);
    this.prompts = this.prompts.map((prompt) => ({
      ...prompt,
      tags: prompt.tags.filter((tag) => tag.id !== tagId),
    }));
    this.libraryRevision += 1;
  }

  async exportPromptMarkdown(id: string): Promise<PromptExportSummary> {
    const prompt = this.requirePrompt(id);
    return exportSummary(`${prompt.id}.md`, 1, prompt.contentBytes);
  }

  async exportPromptsZip(selection: PromptSelection): Promise<PromptExportSummary> {
    if (selection.mode === "filter" && selection.expectedLibraryRevision !== this.libraryRevision) {
      throw new Error("Prompt library changed.");
    }
    const selected = this.resolveSelection(selection);
    const bytes = selected.reduce((sum, prompt) => sum + prompt.contentBytes, 0);
    const serialized = JSON.stringify(selected.map((prompt) => ({
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
      tagIds: prompt.tags.map((tag) => tag.id),
      pinned: prompt.pinned,
    })));
    this.archive = {
      path: "/tmp/prompts.zip",
      fileName: "prompts.zip",
      sha256: deterministicSha(serialized),
      sizeBytes: Math.max(1, byteLength(serialized)),
      prompts: clone(selected),
    };
    return exportSummary("prompts.zip", selected.length, bytes);
  }

  async previewPromptsZipImport(): Promise<PromptZipImportPreview> {
    const archive = this.archive ?? defaultArchive(this.tags[1]);
    const conflicts = archive.prompts.flatMap((imported) => {
      const local = this.prompts.find((prompt) => prompt.id === imported.id);
      return local && !samePrompt(local, imported)
        ? [{ id: imported.id, importedTitle: imported.title, localTitle: local.title }]
        : [];
    });
    const newPrompts = archive.prompts.filter((imported) => (
      !this.prompts.some((local) => local.id === imported.id)
    )).length;
    const identicalPrompts = archive.prompts.filter((imported) => (
      this.prompts.some((local) => local.id === imported.id && samePrompt(local, imported))
    )).length;
    const archiveTagIds = new Set(archive.prompts.flatMap((prompt) => prompt.tags.map((tag) => tag.id)));
    const knownTagIds = new Set(this.tags.map((tag) => tag.id));
    const tagsToReuse = [...archiveTagIds].filter((id) => knownTagIds.has(id)).length;
    return {
      path: archive.path,
      fileName: archive.fileName,
      cancelled: false,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      expectedLibraryRevision: this.libraryRevision,
      prompts: archive.prompts.length,
      totalContentBytes: archive.prompts.reduce((sum, prompt) => sum + prompt.contentBytes, 0),
      newPrompts,
      identicalPrompts,
      conflictingPrompts: conflicts.length,
      tagsToCreate: archiveTagIds.size - tagsToReuse,
      tagsToReuse,
      conflicts,
      valid: true,
      message: "demo import preview",
    };
  }

  async importPromptsZip(request: PromptZipImportRequest): Promise<PromptZipImportResult> {
    const archive = this.archive ?? defaultArchive(this.tags[1]);
    if (request.expectedLibraryRevision !== this.libraryRevision) throw new Error("Prompt library changed.");
    if (request.path !== archive.path || request.sha256 !== archive.sha256 || request.sizeBytes !== archive.sizeBytes) {
      throw new Error("Prompt archive identity changed.");
    }

    let inserted = 0;
    let skippedSame = 0;
    let keptLocal = 0;
    let overwritten = 0;
    let duplicated = 0;
    let createdTags = 0;
    const reusedTagIds = new Set<string>();
    const imported: PromptDetail[] = [];
    for (const archived of archive.prompts) {
      const tags = archived.tags.map((tag) => {
        const existing = this.tags.find((candidate) => candidate.id === tag.id || candidate.name === tag.name);
        if (existing) {
          reusedTagIds.add(existing.id);
          return existing;
        }
        const created = { ...tag, promptCount: 0 };
        this.tags = [...this.tags, created];
        createdTags += 1;
        return created;
      });
      const candidate = { ...clone(archived), tags };
      const existingIndex = this.prompts.findIndex((prompt) => prompt.id === archived.id);
      if (existingIndex < 0) {
        imported.push(candidate);
        inserted += 1;
      } else if (samePrompt(this.prompts[existingIndex], candidate)) {
        skippedSame += 1;
      } else if (request.conflictStrategy === "keep-local") {
        keptLocal += 1;
      } else if (request.conflictStrategy === "overwrite") {
        this.prompts[existingIndex] = candidate;
        overwritten += 1;
      } else {
        imported.push({ ...candidate, id: `${candidate.id}-import-${this.nextPromptId++}` });
        duplicated += 1;
      }
    }
    if (imported.length > 0) this.prompts = [...imported, ...this.prompts];
    if (inserted + overwritten + duplicated + createdTags > 0) this.libraryRevision += 1;
    return {
      inserted,
      skippedSame,
      keptLocal,
      overwritten,
      duplicated,
      createdTags,
      reusedTags: reusedTagIds.size,
      libraryRevision: this.libraryRevision,
      message: "demo import complete",
    };
  }

  private resolveSelection(selection: PromptSelection) {
    if (selection.mode === "explicit") {
      const ids = new Set(selection.ids);
      return this.prompts.filter((prompt) => ids.has(prompt.id));
    }
    const excluded = new Set(selection.excludedIds);
    return this.prompts.filter((prompt) => (
      !excluded.has(prompt.id) && promptMatchesFilter(prompt, selection.filter)
    ));
  }

  private requirePrompt(id: string) {
    const prompt = this.prompts.find((candidate) => candidate.id === id);
    if (!prompt) throw new Error("Prompt not found.");
    return prompt;
  }

  private requirePromptRevision(prompt: PromptDetail, expected: number) {
    if (prompt.revision !== expected) throw new Error("Prompt revision changed.");
  }

  private requireTag(id: string) {
    const tag = this.tags.find((candidate) => candidate.id === id);
    if (!tag) throw new Error("Prompt tag not found.");
    return tag;
  }

  private promptTags(ids: string[]) {
    return ids.map((id) => this.requireTag(id));
  }
}

function promptMatchesFilter(prompt: PromptDetail, filter: PromptListFilter) {
  const query = filter.query.trim().normalize("NFC").toLocaleLowerCase();
  const queryMatches = !query
    || `${prompt.title}\n${prompt.content}`.normalize("NFC").toLocaleLowerCase().includes(query);
  const promptTagIds = new Set(prompt.tags.map((tag) => tag.id));
  const tagMatches = filter.tagIds.length === 0
    || (filter.tagMode === "all"
      ? filter.tagIds.every((id) => promptTagIds.has(id))
      : filter.tagIds.some((id) => promptTagIds.has(id)));
  return queryMatches && tagMatches;
}

function defaultArchive(releaseTag: PromptTag): DemoArchive {
  const prompt = demoPrompt(
    "demo-imported-prompt",
    "导入的发布恢复清单",
    "# 恢复\n\n先查询远端状态，再决定是否重试。",
    [releaseTag],
    false,
  );
  const serialized = JSON.stringify(prompt);
  return {
    path: "/tmp/skill-repo-tracker-demo-prompts.zip",
    fileName: "skill-repo-tracker-demo-prompts.zip",
    sha256: deterministicSha(serialized),
    sizeBytes: Math.max(1, byteLength(serialized)),
    prompts: [prompt],
  };
}

function samePrompt(left: PromptDetail, right: PromptDetail) {
  return left.title === right.title
    && left.content === right.content
    && left.pinned === right.pinned
    && left.tags.map((tag) => tag.name).join("\0") === right.tags.map((tag) => tag.name).join("\0");
}

function demoPromptTag(id: string, name: string, timestamp = "2026-06-30T10:00:00.000Z"): PromptTag {
  return { id, name, promptCount: 0, createdAt: timestamp, updatedAt: timestamp };
}

function demoPrompt(
  id: string,
  title: string,
  content: string,
  tags: PromptTag[],
  pinned: boolean,
  timestamp = "2026-06-30T10:00:00.000Z",
): PromptDetail {
  return {
    id,
    title,
    content,
    excerpt: promptExcerpt(content),
    tags,
    pinned,
    contentBytes: byteLength(content),
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
}

function promptSummary(prompt: PromptDetail): PromptSummary {
  const { content: _content, ...summary } = prompt;
  return summary;
}

function promptExcerpt(content: string) {
  return content.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function exportSummary(name: string, count: number, bytes: number): PromptExportSummary {
  return { path: `/tmp/${name}`, cancelled: false, count, bytes, message: "demo export complete" };
}

function deterministicSha(value: string) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
