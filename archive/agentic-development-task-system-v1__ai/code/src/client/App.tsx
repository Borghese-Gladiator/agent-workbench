import { BrowserRouter, Link, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRouter } from '@client/router';
import { ToastProvider } from '@client/components/Toast';
import { CommandPaletteProvider, CommandPaletteButton } from '@client/components/CommandPalette';
import {
  LayoutGrid,
  CheckSquare,
  Terminal,
  Activity,
} from 'lucide-react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
  },
});

const NAV_ITEMS = [
  { to: '/', label: 'Issues', icon: LayoutGrid },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/terminal', label: 'Terminal', icon: Terminal },
  { to: '/activity', label: 'Activity', icon: Activity },
];

function TopNav() {
  const location = useLocation();

  return (
    <div className="border-b border-border bg-black">
      <div className="flex items-center h-14 px-6 gap-6">
        <div className="flex items-center gap-2 shrink-0">
          <img src="/logo.svg" alt="TS Agent Orchestrator" className="size-8" />
          <span className="font-mono text-sm font-semibold">TS Agent Orchestrator</span>
        </div>
        <div className="flex-1" />
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
            const isActive = to === '/'
              ? location.pathname === '/'
              : location.pathname === to || location.pathname.startsWith(`${to}/`);
            return (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-xl transition-colors ${
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground'
                }`}
              >
                <Icon className="size-5" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="flex-1 flex justify-end">
          <CommandPaletteButton />
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <CommandPaletteProvider>
            <div className="h-screen flex flex-col bg-background text-foreground dark">
              <TopNav />
              <main className="flex-1 overflow-auto">
                <AppRouter />
              </main>
            </div>
          </CommandPaletteProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
