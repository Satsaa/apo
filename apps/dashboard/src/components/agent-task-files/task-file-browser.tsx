"use client";

import { useReducer, useCallback, useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  listTaskFiles,
  readTaskFile,
  type TaskFileEntry,
  type TaskFileListResponse,
  type TaskFileContentResponse,
} from "@/lib/agent-task-api";
import { TaskFileList } from "./task-file-list";
import { TaskFileViewer } from "./task-file-viewer";

interface TaskFileBrowserProps {
  taskId: string;
  projectId: string;
  commitSha?: string | null;
}

type FileBrowserState = {
  files: TaskFileEntry[];
  sourceType: string | null;
  taskPath: string | null;
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  fileContent: TaskFileContentResponse | null;
  viewerError: string | null;
};

type FileBrowserAction =
  | { type: "FETCH_START" }
  | { type: "FETCH_SUCCESS"; response: TaskFileListResponse }
  | { type: "FETCH_ERROR"; error: string }
  | { type: "SELECT_FILE"; path: string }
  | { type: "VIEWER_SUCCESS"; content: TaskFileContentResponse }
  | { type: "VIEWER_ERROR"; error: string };

function fileBrowserReducer(state: FileBrowserState, action: FileBrowserAction): FileBrowserState {
  switch (action.type) {
    case "FETCH_START":
      return { ...state, loading: true, error: null };
    case "FETCH_SUCCESS":
      return {
        ...state,
        files: action.response.files,
        sourceType: action.response.source_type ?? null,
        taskPath: action.response.task_path,
        loading: false,
      };
    case "FETCH_ERROR":
      return { ...state, error: action.error, loading: false };
    case "SELECT_FILE":
      return { ...state, selectedPath: action.path, fileContent: null, viewerError: null };
    case "VIEWER_SUCCESS":
      return { ...state, fileContent: action.content };
    case "VIEWER_ERROR":
      return { ...state, viewerError: action.error };
  }
}

export function TaskFileBrowser({
  taskId,
  projectId,
  commitSha,
}: TaskFileBrowserProps) {
  const [state, dispatch] = useReducer(fileBrowserReducer, {
    files: [],
    sourceType: null,
    taskPath: null,
    loading: true,
    error: null,
    selectedPath: null,
    fileContent: null,
    viewerError: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function fetchFiles() {
      try {
        dispatch({ type: "FETCH_START" });
        const response: TaskFileListResponse = await listTaskFiles(
          taskId,
          projectId,
          commitSha,
        );
        if (!cancelled) {
          dispatch({ type: "FETCH_SUCCESS", response });
        }
      } catch (e: unknown) {
        if (!cancelled) {
          dispatch({ type: "FETCH_ERROR", error: e instanceof Error ? e.message : "Failed to load files" });
        }
      }
    }

    fetchFiles();
    return () => {
      cancelled = true;
    };
  }, [taskId, projectId, commitSha]);

  const handleSelect = useCallback(
    async (path: string) => {
      dispatch({ type: "SELECT_FILE", path });

      try {
        const content = await readTaskFile(
          taskId,
          path,
          projectId,
          commitSha,
        );
        dispatch({ type: "VIEWER_SUCCESS", content });
      } catch (e: unknown) {
        dispatch({ type: "VIEWER_ERROR", error: e instanceof Error ? e.message : "Failed to load file" });
      }
    },
    [taskId, projectId, commitSha]
  );

  const onlyFile =
    state.files.length === 1 && state.files[0].type === "file" ? state.files[0].path : null;

  useEffect(() => {
    if (onlyFile !== null && state.selectedPath === null) {
      void handleSelect(onlyFile);
    }
  }, [onlyFile, state.selectedPath, handleSelect]);

  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load task files</AlertTitle>
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }

  if (state.loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px] text-sm text-muted-foreground">
        Loading files...
      </div>
    );
  }

  const published = state.sourceType === "published";

  if (published && state.files.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
        This task was published without its eval file. Run <span className="font-mono">apo task publish</span>{" "}
        again with a current apo CLI to upload it. Its files are in the publisher&apos;s task folder{" "}
        <span className="font-mono">{state.taskPath}</span>.
      </div>
    );
  }

  const browser = (
    <div className="flex max-h-[600px] min-h-[400px] flex-col rounded-lg border border-border bg-card overflow-hidden md:flex-row">
      <div className="max-h-44 shrink-0 overflow-y-auto border-b border-border/60 md:max-h-none md:w-[280px] md:border-b-0 md:border-r">
        <TaskFileList files={state.files} selectedPath={state.selectedPath} onSelect={handleSelect} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
        <TaskFileViewer file={state.fileContent} error={state.viewerError} />
      </div>
    </div>
  );

  if (!published) return browser;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted-foreground">
        Published catalogs upload only the eval file. The task&apos;s other files are in the
        publisher&apos;s task folder <span className="font-mono">{state.taskPath}</span>.
      </p>
      {browser}
    </div>
  );
}
