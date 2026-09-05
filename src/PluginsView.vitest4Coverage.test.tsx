import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { PluginInspector, PluginsView } from "./PluginsView";
import type { PluginDetail, PluginSkillSummary, UiPlugin } from "./api";

const linkedSkill: PluginSkillSummary = {
  id: "skill-1",
  name: "linked-skill",
  path: "skills/linked-skill",
  version: "1.2.3",
  status: "healthy",
};

const plugin: UiPlugin = {
  id: "plugin-1",
  repoId: "repo-1",
  repoName: "example/plugin-repo",
  name: "example-plugin",
  description: "A detected plugin entry",
  kind: "structured-plugin",
  installCommand: "plugin install example",
  updateCommand: "plugin update example",
  sourcePath: "README.md",
  sourceExcerpt: "install docs",
  status: "detected",
  skillCount: 1,
  detectedSha: "abcdef123456",
  createdAt: "2026-08-31T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  linkedSkills: [linkedSkill],
  note: "review before install",
};

const sparsePlugin: UiPlugin = {
  ...plugin,
  id: "plugin-2",
  repoId: "",
  repoName: "",
  name: "sparse-plugin",
  description: "",
  kind: "",
  installCommand: "",
  updateCommand: null,
  sourcePath: "",
  sourceExcerpt: "",
  status: "",
  skillCount: 0,
  detectedSha: "",
  createdAt: "",
  updatedAt: "",
  linkedSkills: undefined,
  note: "",
};

function TestTag({ value, tone, language }: { value: string; tone?: string; language?: string }) {
  return (
    <span data-language={language} data-tone={tone}>
      {value}
    </span>
  );
}

function TestEmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      <p>{body}</p>
      {actionLabel && (
        <button onClick={onAction} type="button">
          {actionLabel}
        </button>
      )}
    </section>
  );
}

function TestButton({
  children,
  variant,
  onClick,
  disabled,
  className,
  type = "button",
}: {
  children: ReactNode;
  variant?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button className={className} data-variant={variant} disabled={disabled} onClick={onClick} type={type}>
      {children}
    </button>
  );
}

function TestSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function TestDetail({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="test-detail">
      <span>{label}</span>
      <strong data-mono={mono || undefined}>{value}</strong>
    </div>
  );
}

type ViewProps = ComponentProps<typeof PluginsView>;
type InspectorProps = ComponentProps<typeof PluginInspector>;

function createViewProps(overrides: Partial<ViewProps> = {}): ViewProps {
  return {
    plugins: [plugin],
    openPluginDetail: vi.fn(),
    setActiveTab: vi.fn(),
    setSelectedRepoId: vi.fn(),
    setInspectorRepoId: vi.fn(),
    hasPlugins: true,
    hasInspector: false,
    selectedPluginId: "",
    focusPluginRow: false,
    pluginSort: { key: "name", direction: "asc" },
    setPluginSort: vi.fn(),
    language: "en",
    t: (key) => key,
    Tag: TestTag,
    EmptyState: TestEmptyState,
    displayRepoName: (value) => value || "unknown repository",
    displayValue: (value) => (value ? String(value) : "—"),
    manifestShaPreview: (value) => value?.slice(0, 7) || "",
    ...overrides,
  };
}

function createInspectorProps(overrides: Partial<InspectorProps> = {}): InspectorProps {
  return {
    plugin,
    detail: { ...plugin, linkedSkills: [linkedSkill] },
    loading: false,
    error: "",
    onClose: vi.fn(),
    setActiveTab: vi.fn(),
    setSelectedRepoId: vi.fn(),
    setInspectorRepoId: vi.fn(),
    openSkillDetail: vi.fn(),
    copyInstallCommand: vi.fn(),
    onSaveNote: vi.fn().mockResolvedValue(undefined),
    isPending: () => false,
    skills: [linkedSkill],
    repositories: [{ id: "repo-1", name: "example/plugin-repo" }],
    language: "en",
    t: (key) => key,
    Tag: TestTag,
    Button: TestButton,
    Section: TestSection,
    Detail: TestDetail,
    displayRepoName: (value) => value || "unknown repository",
    displayValue: (value) => (value ? String(value) : "—"),
    statusLabel: (value) => `status:${value}`,
    ...overrides,
  };
}

function SortHarness({ plugins = [plugin] }: { plugins?: UiPlugin[] }) {
  const [pluginSort, setPluginSort] = useState<ViewProps["pluginSort"]>({
    key: "name",
    direction: "asc",
  });
  return (
    <PluginsView
      {...createViewProps({
        plugins,
        pluginSort,
        setPluginSort,
        hasInspector: true,
        selectedPluginId: plugin.id,
        focusPluginRow: true,
      })}
    />
  );
}

describe("PluginsView Vitest 4 behavior coverage", () => {
  it("renders selected/focused rows and exposes controlled sort direction", async () => {
    const user = userEvent.setup();
    const { container } = render(<SortHarness plugins={[plugin, sparsePlugin]} />);

    expect(container.querySelector("section.main-pane")).not.toHaveClass("single");
    const selectedRow = screen.getAllByRole("button", { name: "more: example-plugin" })[0];
    expect(selectedRow).toHaveClass("active-row", "keyboard-focus-row");
    const sparseRow = screen.getAllByRole("button", { name: "more: sparse-plugin" })[0];
    expect(sparseRow).not.toHaveClass("active-row", "keyboard-focus-row");
    expect(within(sparseRow).getAllByText("unknown").length).toBeGreaterThanOrEqual(2);
    expect(within(sparseRow).getByText("pluginInstallEntryHint")).toBeInTheDocument();
    expect(within(sparseRow).getByText("unknown repository")).toBeInTheDocument();
    expect(within(sparseRow).getByText("-")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "plugin ↑" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "plugin ↑" }));
    expect(screen.getByRole("button", { name: "plugin ↓" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "createdAt" }));
    expect(screen.getByRole("button", { name: "createdAt ↑" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "createdAt ↑" }));
    expect(screen.getByRole("button", { name: "createdAt ↓" })).toBeInTheDocument();
  });

  it("opens rows by mouse, Enter, and Space but ignores unrelated keys", async () => {
    const user = userEvent.setup();
    const openPluginDetail = vi.fn();
    render(<PluginsView {...createViewProps({ openPluginDetail })} />);
    const row = screen.getAllByRole("button", { name: "more: example-plugin" })[0];

    fireEvent.keyDown(row, { key: "Escape" });
    expect(openPluginDetail).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    await user.click(row);
    expect(openPluginDetail).toHaveBeenCalledTimes(3);
    expect(openPluginDetail).toHaveBeenNthCalledWith(1, plugin);
  });

  it("keeps row action clicks isolated and routes repositories only when an id exists", async () => {
    const user = userEvent.setup();
    const openPluginDetail = vi.fn();
    const setActiveTab = vi.fn();
    const setSelectedRepoId = vi.fn();
    const setInspectorRepoId = vi.fn();
    render(
      <PluginsView
        {...createViewProps({
          plugins: [plugin, sparsePlugin],
          openPluginDetail,
          setActiveTab,
          setSelectedRepoId,
          setInspectorRepoId,
        })}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "more: example-plugin" })[1]);
    expect(openPluginDetail).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "source: example-plugin" }));
    expect(setSelectedRepoId).toHaveBeenCalledWith(plugin.repoId);
    expect(setInspectorRepoId).toHaveBeenCalledWith(plugin.repoId);
    expect(setActiveTab).toHaveBeenCalledWith("repositories");
    expect(openPluginDetail).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "source: sparse-plugin" }));
    expect(setSelectedRepoId).toHaveBeenCalledTimes(1);
    expect(setInspectorRepoId).toHaveBeenCalledTimes(1);
    expect(setActiveTab).toHaveBeenLastCalledWith("repositories");
  });

  it("distinguishes a first-run empty state from an empty filtered result", async () => {
    const user = userEvent.setup();
    const setActiveTab = vi.fn();
    const { rerender } = render(
      <PluginsView {...createViewProps({ plugins: [], hasPlugins: false, setActiveTab })} />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "firstPluginTitle" })).toBeInTheDocument();
    expect(screen.getByText("firstPluginText")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "rescanSources" }));
    expect(setActiveTab).toHaveBeenCalledWith("repositories");

    rerender(<PluginsView {...createViewProps({ plugins: [], hasPlugins: true, setActiveTab })} />);
    expect(screen.getByRole("heading", { level: 2, name: "noFilteredPluginsTitle" })).toBeInTheDocument();
    expect(screen.getByText("noFilteredPluginsText")).toBeInTheDocument();
  });
});

describe("PluginInspector Vitest 4 behavior coverage", () => {
  it("renders server detail and executes copy, navigation, close, and note actions", async () => {
    const user = userEvent.setup();
    const detail: PluginDetail = {
      ...plugin,
      note: "server-side note",
      sourceExcerpt: "server detail docs",
      linkedSkills: [linkedSkill],
    };
    const onClose = vi.fn();
    const setActiveTab = vi.fn();
    const setSelectedRepoId = vi.fn();
    const setInspectorRepoId = vi.fn();
    const openSkillDetail = vi.fn();
    const copyInstallCommand = vi.fn();
    const onSaveNote = vi.fn().mockResolvedValue(undefined);
    render(
      <PluginInspector
        {...createInspectorProps({
          detail,
          onClose,
          setActiveTab,
          setSelectedRepoId,
          setInspectorRepoId,
          openSkillDetail,
          copyInstallCommand,
          onSaveNote,
        })}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: plugin.name })).toBeInTheDocument();
    expect(screen.getByText("server detail docs")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "linkedSkills (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "copy: installCommand" }));
    await user.click(screen.getByRole("button", { name: "copy: updateCommand" }));
    expect(copyInstallCommand).toHaveBeenNthCalledWith(1, plugin.installCommand);
    expect(copyInstallCommand).toHaveBeenNthCalledWith(2, plugin.updateCommand);

    await user.click(screen.getByRole("button", { name: "source" }));
    expect(setSelectedRepoId).toHaveBeenCalledWith(plugin.repoId);
    expect(setInspectorRepoId).toHaveBeenCalledWith(plugin.repoId);
    expect(setActiveTab).toHaveBeenCalledWith("repositories");

    await user.click(screen.getByRole("button", { name: /linked-skill/ }));
    expect(openSkillDetail).toHaveBeenCalledWith(linkedSkill);
    expect(setActiveTab).toHaveBeenLastCalledWith("skills");

    const note = screen.getByPlaceholderText("notePlaceholder");
    expect(note).toHaveValue("server-side note");
    await user.clear(note);
    await user.type(note, "approved locally");
    await user.click(screen.getByRole("button", { name: "saveNote" }));
    expect(onSaveNote).toHaveBeenCalledWith(plugin, "approved locally");
    await user.click(screen.getByRole("button", { name: "clearNote" }));
    expect(note).toHaveValue("");
    expect(onSaveNote).toHaveBeenLastCalledWith(plugin, "");

    await user.click(screen.getByRole("button", { name: "close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("falls back from a missing repo id to the displayed repository name", async () => {
    const user = userEvent.setup();
    const aliasedPlugin = { ...plugin, repoId: "missing-id", repoName: "alias/repository" };
    const setActiveTab = vi.fn();
    const setSelectedRepoId = vi.fn();
    const setInspectorRepoId = vi.fn();
    render(
      <PluginInspector
        {...createInspectorProps({
          plugin: aliasedPlugin,
          detail: null,
          repositories: [{ id: "matched-repo", name: "alias/repository" }],
          setActiveTab,
          setSelectedRepoId,
          setInspectorRepoId,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "source" }));
    expect(setSelectedRepoId).toHaveBeenCalledWith("matched-repo");
    expect(setInspectorRepoId).toHaveBeenCalledWith("matched-repo");
    expect(setActiveTab).toHaveBeenCalledWith("repositories");
  });

  it("still routes tabs when linked records can no longer be resolved", async () => {
    const user = userEvent.setup();
    const missingSkill = { ...linkedSkill, id: "", name: "missing linked skill", version: "" };
    const orphanPlugin = {
      ...plugin,
      repoId: "orphan-repo",
      repoName: "orphan/repository",
      linkedSkills: [missingSkill],
    };
    const setActiveTab = vi.fn();
    const setSelectedRepoId = vi.fn();
    const setInspectorRepoId = vi.fn();
    const openSkillDetail = vi.fn();
    render(
      <PluginInspector
        {...createInspectorProps({
          plugin: orphanPlugin,
          detail: null,
          repositories: [],
          skills: [],
          setActiveTab,
          setSelectedRepoId,
          setInspectorRepoId,
          openSkillDetail,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "source" }));
    expect(setSelectedRepoId).not.toHaveBeenCalled();
    expect(setInspectorRepoId).not.toHaveBeenCalled();
    expect(setActiveTab).toHaveBeenCalledWith("repositories");
    await user.click(screen.getByRole("button", { name: /missing linked skill/ }));
    expect(openSkillDetail).not.toHaveBeenCalled();
    expect(setActiveTab).toHaveBeenLastCalledWith("skills");
  });

  it("renders loading, error, and no-linked-skill states without mixing success content", () => {
    const noLinksDetail: PluginDetail = { ...plugin, linkedSkills: [], skillCount: 3 };
    const { rerender } = render(
      <PluginInspector {...createInspectorProps({ detail: noLinksDetail, loading: true, error: "" })} />,
    );

    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.queryByText("noSkillsFound")).not.toBeInTheDocument();
    rerender(
      <PluginInspector
        {...createInspectorProps({ detail: noLinksDetail, loading: false, error: "GitHub request failed" })}
      />,
    );
    expect(screen.getByText("GitHub request failed")).toHaveClass("error-note");
    expect(screen.queryByText("noSkillsFound")).not.toBeInTheDocument();
    rerender(<PluginInspector {...createInspectorProps({ detail: noLinksDetail, loading: false, error: "" })} />);
    expect(screen.getByRole("heading", { level: 3, name: "linkedSkills (3)" })).toBeInTheDocument();
    expect(screen.getByText("noSkillsFound")).toBeInTheDocument();
  });

  it("shows missing-value fallbacks and disables note actions while saving", () => {
    render(
      <PluginInspector
        {...createInspectorProps({
          plugin: sparsePlugin,
          detail: null,
          skills: [],
          repositories: [],
          isPending: (key) => key === "note:plugin:plugin-2",
        })}
      />,
    );

    expect(screen.getAllByText("unknown").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("readmeUnavailable")).toBeInTheDocument();
    expect(screen.getByText("status:unknown")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "copy: installCommand" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "copy: updateCommand" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "saving" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "clearNote" })).toBeDisabled();
  });

  it("rehydrates the note editor when a refreshed detail changes", async () => {
    const firstDetail: PluginDetail = { ...plugin, note: "first note", linkedSkills: [] };
    const secondDetail: PluginDetail = { ...firstDetail, note: "refreshed note" };
    const { rerender } = render(<PluginInspector {...createInspectorProps({ detail: firstDetail })} />);
    expect(screen.getByPlaceholderText("notePlaceholder")).toHaveValue("first note");

    rerender(<PluginInspector {...createInspectorProps({ detail: secondDetail })} />);
    await waitFor(() => expect(screen.getByPlaceholderText("notePlaceholder")).toHaveValue("refreshed note"));
  });
});
