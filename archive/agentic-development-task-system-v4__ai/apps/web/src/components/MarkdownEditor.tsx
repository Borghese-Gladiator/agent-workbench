import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import { Markdown } from 'tiptap-markdown';

/** tiptap-markdown augments editor storage but isn't on Tiptap's Storage type. */
function getMarkdown(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown();
}

/**
 * Editable rendered-markdown surface for the Task Detail center (e.g. a ready
 * plan). Powered by Tiptap + the markdown extension so the value round-trips as
 * markdown text. Controlled-ish: we seed from `value` and emit markdown on edit.
 */
export function MarkdownEditor({
  value,
  editable = true,
  onChange,
}: {
  value: string;
  editable?: boolean;
  onChange?: (markdown: string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: value,
    editable,
    editorProps: {
      attributes: {
        class:
          'prose prose-sm max-w-none min-h-[200px] rounded-md border bg-background p-3.5 focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.(getMarkdown(editor));
    },
  });

  // Reseed when the upstream value changes (e.g. a new artifact loads).
  useEffect(() => {
    if (editor && value !== getMarkdown(editor)) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  return <EditorContent editor={editor} />;
}
