import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PageHeaderProvider, usePageHeaderState } from '@/components/PageHeader';
import { Usage } from './Usage';

function TopBarStub() {
  const header = usePageHeaderState();
  return <>{header?.action}</>;
}

function renderUsage() {
  return render(
    <PageHeaderProvider>
      <TopBarStub />
      <Usage />
    </PageHeaderProvider>,
  );
}

describe('Usage (Token Analytics)', () => {
  it('renders a recent-runs table with tokens + cost $ columns, no charts/stat-cards', () => {
    renderUsage();
    expect(screen.getByRole('columnheader', { name: 'Tokens' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Cost ($)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Timestamp' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Model' })).toBeInTheDocument();
    // Removed framing must not appear.
    expect(
      screen.queryByText(/Total Tokens|Avg Cost\/Task|Active Agents|Quota Remaining/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Consumption Over Time|Add API Provider/i)).not.toBeInTheDocument();
  });

  it('session-count dropdown changes the number of rows', async () => {
    renderUsage();
    const bodyRowCount = () => screen.getAllByRole('row').length - 1; // minus header row

    expect(bodyRowCount()).toBe(10); // default "Last 10"

    await userEvent.click(screen.getByRole('combobox', { name: /Recent sessions/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Last 25' }));

    expect(bodyRowCount()).toBe(12); // capped skeleton, but distinct from 10
  });
});
