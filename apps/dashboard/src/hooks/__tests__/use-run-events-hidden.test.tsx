import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getBrowserBackendBaseUrl: () => "http://backend.test",
  getProjectId: () => "proj-1",
}));

vi.mock("@/lib/backend-fetch", () => ({
  toBrowserProxyUrl: (url: string) => url,
}));

import { useRunEvents } from "../use-run-events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true;
  }
}

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

function Consumer({
  onReconnect,
  closeWhenHidden,
}: {
  onReconnect: () => void;
  closeWhenHidden?: boolean;
}) {
  useRunEvents({
    project: "proj-1",
    enabled: true,
    onEvent: () => {},
    onReconnect,
    closeWhenHidden,
  });
  return null;
}

let hidden = false;
function setHidden(next: boolean, dispatch = true) {
  hidden = next;
  if (dispatch) {
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }
}

describe("useRunEvents closeWhenHidden", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    hidden = false;
  });

  it("closes the stream while hidden and reopens it, as a reconnect, when seen again", () => {
    const onReconnect = vi.fn();
    render(<Consumer onReconnect={onReconnect} closeWhenHidden />);
    act(() => latest().onopen?.());

    setHidden(true);
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    setHidden(false);
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => latest().onopen?.());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps the stream open while hidden without the option", () => {
    render(<Consumer onReconnect={vi.fn()} />);
    act(() => latest().onopen?.());

    setHidden(true);
    expect(FakeEventSource.instances[0].closed).toBe(false);
  });

  it("does not connect a tab opened in the background until it is seen", () => {
    const onReconnect = vi.fn();
    setHidden(true, false);
    render(<Consumer onReconnect={onReconnect} closeWhenHidden />);
    expect(FakeEventSource.instances).toHaveLength(0);

    setHidden(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    // The server-rendered page may have gone stale while nobody looked.
    act(() => latest().onopen?.());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("drops a pending reconnect when the tab is hidden", () => {
    render(<Consumer onReconnect={vi.fn()} closeWhenHidden />);
    act(() => latest().onopen?.());
    act(() => latest().onerror?.());

    setHidden(true);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(1);

    setHidden(false);
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
