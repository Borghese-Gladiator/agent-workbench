import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsPage } from './SettingsPage.js';

describe('SettingsPage', () => {
  it('renders the daemon base URL and the placeholder note', () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Daemon base URL')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/placeholder/);
  });
});
