import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { TaskFileBrowser } from "../task-file-browser";
import { listTaskFiles, type TaskFileEntry } from "@/lib/agent-task-api";

vi.mock("@/lib/agent-task-api", () => ({
  listTaskFiles: vi.fn(),
  readTaskFile: vi.fn(),
}));

const evalFile: TaskFileEntry = {
  name: "alpha.eval.ts",
  path: "alpha.eval.ts",
  type: "file",
  size_bytes: 40,
  extension: ".ts",
};

describe("TaskFileBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a published task's eval file and says where the other files are", async () => {
    vi.mocked(listTaskFiles).mockResolvedValueOnce({
      task_id: "chat/alpha",
      task_path: "chat/alpha",
      files: [evalFile],
      source_type: "published",
    });
    render(<TaskFileBrowser taskId="chat/alpha" projectId="p1" />);

    expect(await screen.findByText("alpha.eval.ts")).toBeInTheDocument();
    expect(screen.getByText(/Published catalogs upload only the eval file/)).toBeInTheDocument();
    expect(screen.getByText("chat/alpha")).toBeInTheDocument();
  });

  it("explains a published task that has no eval file instead of showing an empty browser", async () => {
    vi.mocked(listTaskFiles).mockResolvedValueOnce({
      task_id: "chat/alpha",
      task_path: "chat/alpha",
      files: [],
      source_type: "published",
    });
    render(<TaskFileBrowser taskId="chat/alpha" projectId="p1" />);

    expect(await screen.findByText(/published without its eval file/)).toBeInTheDocument();
  });

  it("shows no publish note for a task read from its source checkout", async () => {
    vi.mocked(listTaskFiles).mockResolvedValueOnce({
      task_id: "chat/alpha",
      task_path: "chat/alpha",
      files: [evalFile],
      source_type: "git",
    });
    render(<TaskFileBrowser taskId="chat/alpha" projectId="p1" />);

    expect(await screen.findByText("alpha.eval.ts")).toBeInTheDocument();
    expect(screen.queryByText(/Published catalogs/)).not.toBeInTheDocument();
  });
});
