import { expect, test } from "vitest";

test("gate probe: Vitest failure blocks merge", () => {
  expect("blocked").toBe("mergeable");
});
