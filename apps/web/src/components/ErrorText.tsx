/** Inline error message, announced to assistive tech via role="alert". */
export function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p className="error" role="alert">
      {children}
    </p>
  );
}
