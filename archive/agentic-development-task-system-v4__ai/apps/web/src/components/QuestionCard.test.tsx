import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AgentQuestion } from '../api.js';
import { QuestionCard } from './QuestionCard';

function makeQuestion(overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    id: 'q1',
    runId: 'r1',
    taskId: 't1',
    header: 'Choose',
    question: 'Allow WebFetch?',
    options: null,
    multiSelect: false,
    permission: null,
    answer: null,
    ...overrides,
  };
}

describe('QuestionCard', () => {
  it('renders no free-text input for a question with options (selection-only)', () => {
    render(
      <QuestionCard
        question={makeQuestion({
          options: [
            { label: 'allow', description: 'Permit WebFetch' },
            { label: 'deny', description: 'Block WebFetch' },
          ],
          permission: { toolName: 'WebFetch', toolInput: {} },
        })}
        onAnswer={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /allow/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deny/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('submits the selected option, never free text, for an option question', async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    render(
      <QuestionCard
        question={makeQuestion({
          options: [
            { label: 'allow', description: '' },
            { label: 'deny', description: '' },
          ],
        })}
        onAnswer={onAnswer}
      />,
    );

    await user.click(screen.getByRole('button', { name: /allow/ }));
    await user.click(screen.getByRole('button', { name: /submit answer/i }));

    expect(onAnswer).toHaveBeenCalledWith('q1', { selected: ['allow'] });
  });

  it('renders a free-text input for an options-less question', async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    render(<QuestionCard question={makeQuestion({ options: null })} onAnswer={onAnswer} />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'use Linear MCP');
    await user.click(screen.getByRole('button', { name: /submit answer/i }));

    expect(onAnswer).toHaveBeenCalledWith('q1', { text: 'use Linear MCP' });
  });
});
