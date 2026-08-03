import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepositorySelect } from './RepositorySelect.js';
import type { Repository } from '../api/client.js';

const repositories: Repository[] = [
  { id: 'id-1', canonicalPath: '/repos/alpha', name: 'alpha', defaultBranch: 'main', trusted: true, createdAt: '', updatedAt: '' },
  { id: 'id-2', canonicalPath: '/repos/beta', name: 'beta', defaultBranch: 'main', trusted: false, createdAt: '', updatedAt: '' },
];

describe('RepositorySelect', () => {
  it('lists repositories by name and yields the id on an exact name match', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RepositorySelect id="repo" repositories={repositories} value="" onChange={onChange} />,
    );
    const input = screen.getByRole('combobox');
    // Options are rendered by name (datalist), never as UUIDs.
    const options = Array.from(container.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['alpha', 'beta']);

    await userEvent.setup().type(input, 'beta');
    expect(onChange).toHaveBeenLastCalledWith('id-2');
  });

  it('yields empty string when the text is not an exact repository name', async () => {
    const onChange = vi.fn();
    render(<RepositorySelect id="repo" repositories={repositories} value="" onChange={onChange} />);
    await userEvent.setup().type(screen.getByRole('combobox'), 'alph');
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});
