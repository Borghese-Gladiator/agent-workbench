import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AppSidebar } from '../components/layout/AppSidebar.js';

vi.mock('../hooks/useEventStream.js', () => ({
  useEventStream: () => ({ events: [], status: 'connecting' }),
}));

vi.mock('../api/tasks.js', () => ({
  tasksApi: {
    list: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockRejectedValue(new Error('not found')),
  },
  artifactContentUrl: (id: string) => `/api/artifacts/${id}/content`,
}));

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('app routing after the /approvals removal', () => {
  it('has no /approvals route', () => {
    window.history.pushState({}, '', '/approvals');
    render(<App />);
    // The removed page rendered a heading "Approvals"; with no matching route,
    // the Routes render nothing, so that heading must be absent.
    expect(screen.queryByRole('heading', { name: 'Approvals' })).toBeNull();
  });

  it('has no Approvals entry in the sidebar', () => {
    render(<AppSidebar />, { wrapper: withRouter });
    expect(screen.queryByRole('link', { name: 'Approvals' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
  });
});

function withRouter({ children }: { children: ReactNode }) {
  return <BrowserRouter>{children}</BrowserRouter>;
}
