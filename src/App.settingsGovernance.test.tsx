import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { App } from "./App";

describe("settings governance", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    window.history.replaceState(null, "", "/?tab=settings&lang=zh");
  });

  it("does not present settings that the runtime never consumed", () => {
    render(<App />);

    expect(screen.getByText("自动检测间隔")).toBeInTheDocument();
    expect(screen.queryByText("元数据并发")).not.toBeInTheDocument();
    expect(screen.queryByText("失败重试次数")).not.toBeInTheDocument();
    expect(screen.queryByText("备份历史保留数量")).not.toBeInTheDocument();
  });
});
