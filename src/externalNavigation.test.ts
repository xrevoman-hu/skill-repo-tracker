import { afterEach, describe, expect, it, vi } from "vitest";

import { openGithub } from "./externalNavigation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openGithub", () => {
  it("opens a canonical github.com HTTPS URL with an isolated browsing context", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    expect(openGithub("https://github.com/example/repository?tab=readme#usage")).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      "https://github.com/example/repository?tab=readme#usage",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it.each([
    "http://github.com/example/repository",
    "https://github.com.evil.example/example/repository",
    "https://user@github.com/example/repository",
    "https://user:secret@github.com/example/repository",
    "https://github.com:443/example/repository",
    "https://github.com:8443/example/repository",
    "https://api.github.com/repos/example/repository",
    "javascript:alert(1)",
    "/example/repository",
    " https://github.com/example/repository",
  ])("rejects an unapproved browser destination: %s", (url) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    expect(openGithub(url)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
