import { api } from "./api";
import type { PromptLibraryApi } from "./PromptsView";

type PromptBackendClient = Pick<
  typeof api,
  | "listPrompts"
  | "getPromptDetail"
  | "createPrompt"
  | "updatePrompt"
  | "deletePrompt"
  | "setPromptPinned"
  | "reorderPrompt"
  | "listPromptTags"
  | "createPromptTag"
  | "renamePromptTag"
  | "mergePromptTags"
  | "deletePromptTag"
  | "exportPromptMarkdown"
  | "exportPromptsZip"
  | "previewPromptsZipImport"
  | "importPromptsZip"
>;

export function createPromptLibraryApi(client: PromptBackendClient = api): PromptLibraryApi {
  return {
    listPrompts: (request) => client.listPrompts(request),
    getPrompt: (id) => client.getPromptDetail(id),
    createPrompt: (input) => client.createPrompt(input),
    updatePrompt: (id, expectedRevision, input) =>
      client.updatePrompt({ id, expectedRevision, ...input }),
    deletePrompt: async (id, expectedRevision) => {
      await client.deletePrompt(id, expectedRevision);
    },
    setPromptPinned: (id, expectedRevision, pinned) =>
      client.setPromptPinned(id, pinned, expectedRevision),
    reorderPrompt: (request) => client.reorderPrompt(request),
    listTags: () => client.listPromptTags(),
    createTag: (name) => client.createPromptTag(name),
    renameTag: (id, name) => client.renamePromptTag(id, name),
    mergeTags: (sourceId, targetId) => client.mergePromptTags(sourceId, targetId),
    deleteTag: async (id) => {
      await client.deletePromptTag(id);
    },
    exportPrompt: (id) => client.exportPromptMarkdown(id),
    exportPrompts: (selection) => client.exportPromptsZip(selection),
    previewPromptsZipImport: async () => {
      const preview = await client.previewPromptsZipImport();
      if (preview.cancelled || !preview.path || !preview.sha256) return null;
      return {
        path: preview.path,
        fileName: preview.fileName || preview.path.split("/").pop() || "prompts.zip",
        sha256: preview.sha256,
        sizeBytes: preview.sizeBytes,
        libraryRevision: preview.expectedLibraryRevision,
        promptCount: preview.prompts,
        newCount: preview.newPrompts,
        identicalCount: preview.identicalPrompts,
        conflictCount: preview.conflictingPrompts,
        tagsToCreate: preview.tagsToCreate,
        tagsToReuse: preview.tagsToReuse,
        totalContentBytes: preview.totalContentBytes,
        conflicts: preview.conflicts,
      };
    },
    importPromptsZip: async (request) => {
      const result = await client.importPromptsZip(request);
      return {
        inserted: result.inserted,
        skipped: result.skippedSame + result.keptLocal,
        duplicated: result.duplicated,
        overwritten: result.overwritten,
        tagsCreated: result.createdTags,
        tagsReused: result.reusedTags,
        libraryRevision: result.libraryRevision,
        message: result.message,
      };
    },
  };
}

export const promptLibraryApi = createPromptLibraryApi();
