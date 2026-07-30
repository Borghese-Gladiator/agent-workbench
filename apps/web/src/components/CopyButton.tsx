import { useEffect, useRef, useState } from 'react';

/**
 * One-click copy control. Shows a transient "Copied" confirmation. Falls back to a temporary
 * textarea + execCommand when the async clipboard API is unavailable (older/insecure contexts).
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const el = document.createElement('textarea');
        el.value = value;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — leave state unchanged.
    }
  }

  return (
    <button
      type="button"
      className="copy-button"
      aria-label={copied ? 'Copied' : label}
      onClick={() => void copy()}
    >
      <span aria-hidden="true">{copied ? 'Copied' : '⧉'}</span>
    </button>
  );
}
