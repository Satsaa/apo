"use client";

import { useEffect, useState } from "react";

interface UseTableSelectionProps {
  projectId: string;
  tableName: string;
}

/**
 * Manages a table's "select all" flag: persisted in sessionStorage under a
 * per-project/table key and cleared on browser back/forward navigation
 * (popstate). Client-side route changes within the app do not clear it.
 */
export function useTableSelection({
  projectId,
  tableName,
}: UseTableSelectionProps) {
  // Generate storage key unique to project and table
  const storageKey = `selectAll-${projectId}-${tableName}`;

  // Read initial value from session storage
  const initialValue =
    typeof window !== "undefined"
      ? window.sessionStorage.getItem(storageKey) === "true"
      : false;

  const [selectAll, setSelectAll] = useState<boolean>(initialValue);

  // Sync state to session storage
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(storageKey, selectAll.toString());
    }
  }, [selectAll, storageKey]);

  useEffect(() => {
    const handleRouteChange = () => {
      setSelectAll(false);
    };

    // Note: Next.js App Router doesn't have router.events like Pages Router
    // We use popstate for browser back/forward
    window.addEventListener("popstate", handleRouteChange);

    return () => {
      window.removeEventListener("popstate", handleRouteChange);
    };
  }, []);

  return { selectAll, setSelectAll };
}
