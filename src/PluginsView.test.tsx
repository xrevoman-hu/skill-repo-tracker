import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PluginsView } from "./PluginsView";
import type { UiPlugin } from "./api";

const plugin: UiPlugin = {
  id: "plugin-1",
  repoId: "repo-1",
  repoName: "example/plugin-repo",
  name: "example-plugin",
  description: "A detected plugin entry",
  kind: "structured-plugin",
  installCommand: "plugin install example",
  sourcePath: "README.md",
  sourceExcerpt: "install docs",
  status: "detected",
  skillCount: 2,
  detectedSha: "abcdef123456",
  createdAt: "2026-08-31T00:00:00Z",
  updatedAt: "2026-08-31T00:00:00Z",
  note: "",
};

describe("PluginsView injected navigation", () => {
  it("opens keyboard-selected plugins and routes source actions by stable ids", async () => {
    const user = userEvent.setup();
    const openPluginDetail = vi.fn();
    const setActiveTab = vi.fn();
    const setSelectedRepoId = vi.fn();
    const setInspectorRepoId = vi.fn();

    render(
      <PluginsView
        plugins={[plugin]}
        openPluginDetail={openPluginDetail}
        setActiveTab={setActiveTab}
        setSelectedRepoId={setSelectedRepoId}
        setInspectorRepoId={setInspectorRepoId}
        hasPlugins
        hasInspector={false}
        selectedPluginId=""
        pluginSort={{ key: "name", direction: "asc" }}
        setPluginSort={vi.fn()}
        language="en"
        t={(key) => key}
        Tag={({ value }) => <span>{value}</span>}
        EmptyState={({ title }) => <div>{title}</div>}
        displayRepoName={(value) => value}
        displayValue={(value) => String(value ?? "")}
        manifestShaPreview={(value) => value?.slice(0, 7) || ""}
      />,
    );

    const row = screen.getAllByRole("button", { name: "more: example-plugin" })[0];
    fireEvent.keyDown(row, { key: "Enter" });
    expect(openPluginDetail).toHaveBeenCalledWith(plugin);

    await user.click(screen.getByRole("button", { name: "source: example-plugin" }));
    expect(setSelectedRepoId).toHaveBeenCalledWith("repo-1");
    expect(setInspectorRepoId).toHaveBeenCalledWith("repo-1");
    expect(setActiveTab).toHaveBeenCalledWith("repositories");
  });
});
