import { describe, expect, it } from "vitest";
import { formatTrigger, terminalSafe, terminalSafeDeep } from "../src/lib/format.ts";

describe("terminalSafe", () => {
  it("strips ESC sequences, OSC hyperlinks and C1 introducers", () => {
    expect(terminalSafe("\x1b]8;;https://evil\x07ceo@corp\x1b]8;;\x07")).toBe(
      "]8;;https://evilceo@corp]8;;",
    );
    expect(terminalSafe("a\x1b[2Jb")).toBe("a[2Jb");
    expect(terminalSafe("a\u009b2Jb\u009dc")).toBe("a2Jbc");
    expect(terminalSafe("a\rb\x7fc")).toBe("abc");
  });

  it("keeps tabs, newlines and ordinary text", () => {
    expect(terminalSafe("line 1\n\tline 2 · ä ✓")).toBe("line 1\n\tline 2 · ä ✓");
  });

  it("sanitizes every string in a nested payload and leaves other values", () => {
    expect(
      terminalSafeDeep({ a: "x\x1by", b: [1, "\x07z", null], c: { d: true, e: "\u0085w" } }),
    ).toEqual({ a: "xy", b: [1, "z", null], c: { d: true, e: "w" } });
  });
});

describe("formatTrigger", () => {
  it("labels the free-text actor", () => {
    expect(
      formatTrigger({ source: "cli", actor: "Requested by: ceo@corp", hostname: null, entrypoint: null }),
    ).toBe("cli · actor: Requested by: ceo@corp");
  });
});
