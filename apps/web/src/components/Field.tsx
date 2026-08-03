import { useId, type ReactNode } from 'react';

/**
 * Labelled form field wrapper. Associates a visible <label> with its control via a generated id
 * (WCAG: real labels, not placeholder-only). Pass a render function that receives the id to wire
 * onto the input/select/textarea.
 */
export function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}
