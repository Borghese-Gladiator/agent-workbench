import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Panel, PanelBody, PanelHeader, StatTile } from './panel';

describe('Panel', () => {
  it('renders a header title as a heading and shows its body + action', () => {
    render(
      <Panel>
        <PanelHeader title="Recent Runs" action={<button type="button">Export</button>} />
        <PanelBody>content</PanelBody>
      </Panel>,
    );
    expect(screen.getByRole('heading', { name: 'Recent Runs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('StatTile renders its label and value', () => {
    render(<StatTile label="Run Duration" value="425.021s" tone="accent" />);
    expect(screen.getByText('Run Duration')).toBeInTheDocument();
    expect(screen.getByText('425.021s')).toBeInTheDocument();
  });
});
