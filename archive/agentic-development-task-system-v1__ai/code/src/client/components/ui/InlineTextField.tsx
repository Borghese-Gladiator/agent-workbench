import { useEffect, useRef, useState } from 'react';
import { cn } from '@client/lib/utils';

type Props = {
  value: string;
  onSave: (next: string) => void;
  multiline?: boolean;
  placeholder?: string;
  allowEmpty?: boolean;
  ariaLabel?: string;
  className?: string;
  displayClassName?: string;
  editClassName?: string;
  autoFocus?: boolean;
  onEditingChange?: (editing: boolean) => void;
};

export function InlineTextField({
  value,
  onSave,
  multiline = false,
  placeholder,
  allowEmpty = false,
  ariaLabel,
  className,
  displayClassName,
  editClassName,
  autoFocus = false,
  onEditingChange,
}: Props) {
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
      autoResize(el);
    }
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  function commit() {
    const trimmed = multiline ? draft : draft.trim();
    if (!allowEmpty && trimmed.length === 0) {
      setDraft(value);
      setEditing(false);
      return;
    }
    if (trimmed !== value) onSave(trimmed);
    setEditing(false);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === 'Enter' && (!multiline || !e.shiftKey)) {
      e.preventDefault();
      commit();
      return;
    }
  }

  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        className={cn(
          'cursor-text rounded px-1 py-0.5 -mx-1 hover:bg-accent/40 focus:outline-none focus:ring-1 focus:ring-ring',
          className,
          displayClassName,
        )}
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {value || (placeholder ? <span className="text-muted-foreground">{placeholder}</span> : null)}
      </span>
    );
  }

  return (
    <textarea
      ref={textareaRef}
      rows={1}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        setDraft(e.target.value);
        autoResize(e.target);
      }}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      className={cn(
        'w-full resize-none rounded border border-ring bg-background px-1 py-0.5 -mx-1 focus:outline-none',
        className,
        editClassName,
      )}
    />
  );
}

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}
