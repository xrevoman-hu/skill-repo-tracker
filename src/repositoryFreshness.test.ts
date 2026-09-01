import { describe, expect, it } from "vitest";

import { latestRepositoryCheck } from "./repositoryFreshness";

describe("repository check freshness", () => {
  it("shows the newest real repository check instead of a build-time constant", () => {
    expect(latestRepositoryCheck([
      { lastChecked: "2026-06-14T09:30:00Z" },
      { lastChecked: "2026-06-14T10:04:00Z" },
      { lastChecked: "" },
    ])).toBe("2026-06-14T10:04:00Z");
  });

  it("hides freshness when no repository has been checked", () => {
    expect(latestRepositoryCheck([{ lastChecked: undefined }, {}])).toBeNull();
  });

  it("ignores invalid later values and recovers when the first value is invalid", () => {
    expect(latestRepositoryCheck([
      { lastChecked: "2026-06-14T10:04:00Z" },
      { lastChecked: "not-a-timestamp" },
    ])).toBe("2026-06-14T10:04:00Z");
    expect(latestRepositoryCheck([
      { lastChecked: "not-a-timestamp" },
      { lastChecked: "2026-06-14T10:04:00Z" },
    ])).toBe("2026-06-14T10:04:00Z");
  });
});
