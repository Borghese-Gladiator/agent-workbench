import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

/**
 * The contextual top bar. Each page declares its own title + primary action via
 * `usePageHeader`; the shell renders whatever the active page set. Task Detail
 * sets nothing (it owns its own header), so the bar collapses to empty there.
 */
export interface PageHeaderState {
  title: string;
  /** Optional right-aligned action node (e.g. a Create button / modal trigger). */
  action?: ReactNode;
}

interface PageHeaderContextValue {
  header: PageHeaderState | null;
  setHeader: (h: PageHeaderState | null) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue | null>(null);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [header, setHeader] = useState<PageHeaderState | null>(null);
  return (
    <PageHeaderContext.Provider value={{ header, setHeader }}>
      {children}
    </PageHeaderContext.Provider>
  );
}

/** Read the current header (shell side). */
export function usePageHeaderState(): PageHeaderState | null {
  const ctx = useContext(PageHeaderContext);
  return ctx?.header ?? null;
}

/**
 * Declare this page's top-bar title + action. Pass `null` to suppress the bar
 * entirely (Task Detail does this).
 *
 * The `action` is JSX with a fresh identity every render, so we must NOT key the
 * sync effect on it — doing so would loop (set → provider re-render → new action
 * → set → …). Instead we key on `title` and push the latest header (read from a
 * ref) so the freshest action lands without retriggering.
 */
export function usePageHeader(header: PageHeaderState | null): void {
  const ctx = useContext(PageHeaderContext);
  const setHeader = ctx?.setHeader;
  const title = header?.title ?? null;

  const latest = useRef(header);
  latest.current = header;

  useEffect(() => {
    setHeader?.(latest.current);
    return () => setHeader?.(null);
    // Re-sync only when the page changes its title (or context appears).
  }, [setHeader, title]);
}
