import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDuration } from "../runs-utils";

describe("formatDuration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T11:23:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("measures start to end", () => {
    expect(formatDuration("2026-09-14T09:20:27.938671Z", "2026-09-14T09:20:41.335580Z", false)).toBe("13.4s");
  });

  it("counts a live run up to now", () => {
    expect(formatDuration("2026-09-14T11:20:00Z", null, true)).toBe("3m 00s");
  });

  it("does not count a finished run without an end up to now", () => {
    expect(formatDuration("2026-09-14T09:20:27.938671Z", null, false)).toBe("—");
  });
});
