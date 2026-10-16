import { describe, expect, it } from "vitest";

import { getFlatKeyValueEntries } from "../FlatKeyValuePreview";

describe("getFlatKeyValueEntries", () => {
  it("preserves every supported scalar without coercion", () => {
    expect(
      getFlatKeyValueEntries({ command: "pwd", timeout: 0, enabled: false, note: null }),
    ).toEqual([
      ["command", "pwd"],
      ["timeout", 0],
      ["enabled", false],
      ["note", null],
    ]);
  });

  it.each([
    ["an array", ["pwd"]],
    ["an empty object", {}],
    ["a nested value", { path: "/tmp", edits: [{ find: "a", replace: "b" }] }],
    ["more than eight entries", Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, i]))],
  ])("leaves %s to the JSON tree", (_label, value) => {
    expect(getFlatKeyValueEntries(value)).toBeNull();
  });
});
