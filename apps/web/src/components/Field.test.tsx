import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from './Field.js';

describe('Field', () => {
  it('associates the visible label with the control via id', () => {
    render(<Field label="Email">{(id) => <input id={id} type="email" />}</Field>);
    const input = screen.getByLabelText('Email');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('generates a unique id per field instance', () => {
    render(
      <>
        <Field label="One">{(id) => <input id={id} />}</Field>
        <Field label="Two">{(id) => <input id={id} />}</Field>
      </>,
    );
    const one = screen.getByLabelText('One');
    const two = screen.getByLabelText('Two');
    expect(one.id).not.toBe('');
    expect(one.id).not.toBe(two.id);
  });
});
