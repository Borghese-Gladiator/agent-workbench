import { stageNeedsHumanApproval } from '@workbench/core';
import {
  Boxes,
  Coins,
  FolderCog,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '@/api';
import { PageHeaderProvider, usePageHeaderState } from '@/components/PageHeader';
import { cn } from '@/lib/utils';

/**
 * Sidebar is split into two zones: a Workflow zone at the top (where the day-to-
 * day work happens) and a Config zone pinned to the bottom (registry + usage).
 */
const workflowNav = [{ to: '/', label: 'Task Board', icon: LayoutDashboard, end: true }];
const configNav = [
  { to: '/usage', label: 'Token Usage', icon: Coins, end: false },
  { to: '/projects', label: 'Projects', icon: FolderCog, end: false },
];

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  badge,
  collapsed,
}: {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end: boolean;
  badge?: number;
  collapsed: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-2.5 rounded-md py-1.5 text-sm transition-colors',
          collapsed ? 'justify-center px-0' : 'pl-2.5 pr-2',
          isActive
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-foreground/80 hover:bg-accent/60 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Left accent bar marks the active row, Linear-style. */}
          <span
            aria-hidden
            className={cn(
              'absolute left-0 top-1/2 h-4 -translate-y-1/2 rounded-r-full bg-primary transition-all',
              isActive ? 'w-0.5 opacity-100' : 'w-0 opacity-0',
            )}
          />
          <Icon
            className={cn(
              'h-4 w-4 shrink-0 transition-colors',
              isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
            )}
          />
          {!collapsed && <span className="flex-1 truncate">{label}</span>}
          {!collapsed && badge ? (
            <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">
              {badge}
            </span>
          ) : null}
          {/* Collapsed: surface the badge as a small dot on the icon corner. */}
          {collapsed && badge ? (
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
          ) : null}
        </>
      )}
    </NavLink>
  );
}

/** Count of tasks parked at a human-approval gate — the one nav badge with real data. */
function useApprovalCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    api
      .listTasks()
      .then((tasks) =>
        setCount(
          tasks.filter((t) => t.status === 'active' && stageNeedsHumanApproval(t.stage)).length,
        ),
      )
      .catch(() => setCount(0));
  }, []);
  return count;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** The per-page contextual top bar. Renders nothing when a page suppresses it. */
function TopBar() {
  const header = usePageHeaderState();
  if (!header) return null;
  return (
    <div className="flex items-center justify-between border-b px-8 py-4">
      <h2 className="text-xl font-semibold">{header.title}</h2>
      {header.action}
    </div>
  );
}

/** Persisted sidebar collapse state (sticks across reloads). */
const COLLAPSE_KEY = 'workbench:sidebar-collapsed';
function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };
  return [collapsed, toggle];
}

export function App() {
  const approvalCount = useApprovalCount();
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  return (
    <PageHeaderProvider>
      <div className="flex h-screen overflow-hidden">
        <aside
          className={cn(
            'flex flex-shrink-0 flex-col border-r bg-card p-3 transition-[width]',
            collapsed ? 'w-16' : 'w-60',
          )}
        >
          {/* Identity zone: logo tile + title + collapse toggle, separated by a hairline. */}
          <div
            className={cn(
              'flex items-center gap-2.5 border-b px-1.5 pb-4 pt-1',
              collapsed && 'flex-col gap-2',
            )}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Boxes className="h-4 w-4" />
            </div>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold leading-tight">Agent Workbench</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  local-first control plane
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={toggleCollapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
          </div>

          <nav className="mt-4 space-y-0.5">
            {!collapsed && <SectionLabel>Workflow</SectionLabel>}
            {workflowNav.map((item) => (
              <NavItem
                key={item.to}
                {...item}
                collapsed={collapsed}
                badge={item.to === '/' ? approvalCount : undefined}
              />
            ))}
          </nav>

          {/* Config zone pinned to the bottom, set off by a quiet top divider. */}
          <nav className="mt-auto space-y-0.5 border-t pt-3">
            {!collapsed && <SectionLabel>Config</SectionLabel>}
            {configNav.map((item) => (
              <NavItem key={item.to} {...item} collapsed={collapsed} />
            ))}
          </nav>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
            <div className="mx-auto flex h-full min-h-0 max-w-[1400px] flex-col">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </PageHeaderProvider>
  );
}
