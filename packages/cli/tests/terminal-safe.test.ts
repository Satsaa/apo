import { describe, expect, it } from "vitest";
import { formatTrigger, terminalSafe, terminalSafeDeep } from "../src/lib/format.ts";

describe("terminalSafe", () => {
  it("strips whole CSI sequences, leaving no residue", () => {
    expect(terminalSafe("\x1b[31mred\x1b[0m")).toBe("red");
    expect(terminalSafe("a\x1b[2Jb\x1b[?25lc")).toBe("abc");
    expect(terminalSafe("a\u009b31mb")).toBe("ab");
  });

  it("strips OSC sequences however they end, keeping the visible text", () => {
    expect(terminalSafe("\x1b]8;;https://evil\x07ceo@corp\x1b]8;;\x07")).toBe("ceo@corp");
    expect(terminalSafe("a\x1b]0;title\x1b\\b")).toBe("ab");
    expect(terminalSafe("a\u009d0;title\u009cb")).toBe("ab");
    expect(terminalSafe("a\x1b]0;never terminated")).toBe("a");
  });

  it("strips lone controls", () => {
    expect(terminalSafe("a\rb\x7fc\x07d\u0085e")).toBe("abcde");
    expect(terminalSafe("lone \x1b escape")).toBe("lone  escape");
  });

  it("keeps tabs, newlines and ordinary text", () => {
    expect(terminalSafe("line 1\n\tline 2 · ä ✓ [31m")).toBe("line 1\n\tline 2 · ä ✓ [31m");
  });

  it("sanitizes every string and key in a nested payload and leaves other values", () => {
    expect(
      terminalSafeDeep({
        a: "x\x1b[1my",
        b: [1, "\x07z", null],
        c: { d: true, "k\x1b]0;t\x07ey": "\u0085w" },
      }),
    ).toEqual({ a: "xy", b: [1, "z", null], c: { d: true, key: "w" } });
  });
});

describe("formatTrigger", () => {
  it("labels the free-text actor", () => {
    expect(
      formatTrigger({ source: "cli", actor: "Requested by: ceo@corp", hostname: null, entrypoint: null }),
    ).toBe("cli · actor: Requested by: ceo@corp");
  });
});
