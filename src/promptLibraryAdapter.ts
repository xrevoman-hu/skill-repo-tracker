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
  | "listPromptTags"
  | "createPromptTag"
  | "renamePromptTag"
  | "mergePromptTags"
  | "deletePromptTag"
  | "exportPromptMarkdown"
  | "exportPromptsZip"
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
    listTags: () => client.listPromptTags(),
    createTag: (name) => client.createPromptTag(name),
    renameTag: (id, name) => client.renamePromptTag(id, name),
    mergeTags: async (sourceId, targetId) => {
      await client.mergePromptTags(sourceId, targetId);
    },
    deleteTag: async (id) => {
      await client.deletePromptTag(id);
    },
    exportPrompt: (id) => client.exportPromptMarkdown(id),
    exportPrompts: (selection) => client.exportPromptsZip(selection),
  };
}

export const promptLibraryApi = createPromptLibraryApi();
