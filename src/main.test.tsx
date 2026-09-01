import { beforeEach, describe, expect, it, vi } from "vitest";

const reactDom = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  createRoot: reactDom.createRoot,
}));

vi.mock("./App", () => ({
  App: () => null,
}));

describe("application entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    reactDom.createRoot.mockReturnValue({ render: reactDom.render });
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("mounts the application into the governed root element", async () => {
    const root = document.getElementById("root");

    await import("./main");

    expect(reactDom.createRoot).toHaveBeenCalledWith(root);
    expect(reactDom.render).toHaveBeenCalledOnce();
  });

  it("fails closed when the HTML application root is missing", async () => {
    document.body.innerHTML = "";

    await expect(import("./main")).rejects.toThrow("Missing #root application mount point.");
    expect(reactDom.createRoot).not.toHaveBeenCalled();
  });
});
