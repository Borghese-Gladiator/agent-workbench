import { Boxes, FolderGit2, LayoutDashboard, ListChecks, Settings, SquareKanban } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/board', label: 'Task Board', icon: SquareKanban },
  { to: '/tasks', label: 'Tasks', icon: ListChecks },
  { to: '/repositories', label: 'Repositories', icon: FolderGit2 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function AppSidebar() {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Boxes className="h-4 w-4" />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight text-foreground">Factory</div>
          <div className="text-[11px] text-muted-foreground">Agent Workbench</div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-2 py-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
