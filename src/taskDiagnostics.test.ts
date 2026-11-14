import { describe, expect, it } from "vitest";
import type { UiTask } from "./api";
import { failedTaskDiagnostic, formatTaskDiagnostic, visibleTaskDiagnostics } from "./taskDiagnostics";

const pending: UiTask = {
  id: "pending-update", kind: "Update Skill", target: "example-skill", status: "running",
  progress: "…", summary: "started", retryable: false, log: ["started"], optimistic: true,
};

describe("task diagnostic retention", () => {
  it("keeps an earlier session failure when a later same-object task fails for a different reason", () => {
    const earlier = failedTaskDiagnostic(pending, { code: "github_timeout", message: "timeout", details: "request=A" }, "failed", "session only");
    const later = { ...pending, id: "stored-later", status: "failed", summary: "disk full", log: ["disk full request=B"], optimistic: false };
    const shown = visibleTaskDiagnostics([later], [earlier]);
    expect(shown).toEqual([earlier, later]);
    expect(formatTaskDiagnostic(shown[0])).toContain("request=A");
    expect(formatTaskDiagnostic(shown[1])).toContain("request=B");
  });

  it("does not duplicate the same session failure when a service returns its snapshot", () => {
    const failure = failedTaskDiagnostic(pending, "network unavailable", "failed", "session only");
    expect(visibleTaskDiagnostics([failure], [failure])).toEqual([failure]);
  });

  it("retains only explicit diagnostic fields and explains empty logs in a copied report", () => {
    const failure = failedTaskDiagnostic(pending, { message: "failed", code: "denied", details: "status=403", unrelatedSecret: "never-copy-this" }, "fallback", "session only");
    const report = formatTaskDiagnostic(failure);
    expect(report).toContain("[denied]");
    expect(report).toContain("status=403");
    expect(report).toContain("Retry reason: session only");
    expect(report).not.toContain("never-copy-this");
    expect(formatTaskDiagnostic({ ...pending, log: [] })).toContain("No detailed log was saved");
  });
});
