import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Comment } from '@shared/types';
import {
  useComments,
  useCreateComment,
  useUpdateComment,
  useDeleteComment,
  useSendToTerminal,
} from '@client/services/hooks';
import { Textarea } from '@client/components/ui/textarea';
import { Button } from '@client/components/ui/button';
import { useToast } from '@client/components/Toast';
import { timeAgo } from '@client/utils/time';
import { ADVERSARIAL_REVIEW_BOT_ID } from '@shared/constants';

export function CommentList({
  workItemId,
  compact = false,
  activeSessionId = null,
}: {
  workItemId: string;
  compact?: boolean;
  activeSessionId?: string | null;
}) {
  const { data: comments, isLoading } = useComments(workItemId);
  const createComment = useCreateComment(workItemId);
  const [draft, setDraft] = useState('');

  function handlePost() {
    const body = draft.trim();
    if (!body) return;
    createComment.mutate(body, {
      onSuccess: () => { setDraft(''); },
    });
  }

  const headingSize = compact ? 'text-sm' : 'text-sm';
  const count = comments?.length ?? 0;

  return (
    <div>
      <h3 className={`${headingSize} font-medium mb-2`}>Comments{count > 0 ? ` (${count})` : ''}</h3>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading...</div>
      ) : (
        <div className="space-y-3">
          {comments?.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              workItemId={workItemId}
              compact={compact}
              activeSessionId={activeSessionId}
            />
          ))}
          {count === 0 && (
            <div className="text-xs text-muted-foreground italic">No comments yet.</div>
          )}
        </div>
      )}

      <div className="mt-3 space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handlePost();
            }
          }}
          placeholder="Write a comment..."
          className={compact ? 'min-h-[60px] text-sm' : 'min-h-[80px]'}
          disabled={createComment.isPending}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={handlePost}
            disabled={!draft.trim() || createComment.isPending}
          >
            {createComment.isPending ? 'Posting...' : 'Post'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  workItemId,
  compact,
  activeSessionId,
}: {
  comment: Comment;
  workItemId: string;
  compact: boolean;
  activeSessionId: string | null;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(comment.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const updateComment = useUpdateComment(workItemId);
  const deleteComment = useDeleteComment(workItemId);
  const sendToTerminal = useSendToTerminal();
  const { toast } = useToast();
  const navigate = useNavigate();

  const isReviewBot =
    comment.authorType === 'system' && comment.authorId === ADVERSARIAL_REVIEW_BOT_ID;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(comment.body);
      toast('Copied to clipboard', 'success');
    } catch (err) {
      toast(`Copy failed: ${(err as Error).message}`, 'error');
    }
  }

  function handleSendToTerminal() {
    if (!activeSessionId) return;
    sendToTerminal.mutate(
      { sessionId: activeSessionId, text: comment.body },
      {
        onSuccess: () => {
          toast('Sent to terminal', 'success');
          navigate(`/terminal?session=${activeSessionId}`);
        },
        onError: (err) => toast(`Send failed: ${(err as Error).message}`, 'error'),
      },
    );
  }

  useEffect(() => {
    setEditValue(comment.body);
  }, [comment.body]);

  useEffect(() => {
    if (isEditing) textareaRef.current?.focus();
  }, [isEditing]);

  function handleSave() {
    const trimmed = editValue.trim();
    if (!trimmed) return;
    if (trimmed === comment.body) {
      setIsEditing(false);
      return;
    }
    updateComment.mutate(
      { commentId: comment.id, body: trimmed },
      { onSuccess: () => setIsEditing(false) },
    );
  }

  function handleDelete() {
    if (!confirm('Delete this comment?')) return;
    deleteComment.mutate(comment.id);
  }

  const author = comment.authorId ?? comment.authorType;
  const textSize = compact ? 'text-xs' : 'text-sm';

  return (
    <div className="border border-border rounded p-3 bg-muted/20">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{author}</span>
          <span>{timeAgo(comment.updatedAt)}</span>
          {comment.editedAt && <span className="italic">(edited)</span>}
        </div>
        {!isEditing && (
          <div className="flex items-center gap-1">
            {isReviewBot && (
              <>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Copy
                </button>
                {activeSessionId && (
                  <>
                    <span className="text-xs text-border">·</span>
                    <button
                      type="button"
                      onClick={handleSendToTerminal}
                      disabled={sendToTerminal.isPending}
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {sendToTerminal.isPending ? 'Sending…' : 'Send to terminal'}
                    </button>
                  </>
                )}
                <span className="text-xs text-border">·</span>
              </>
            )}
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Edit
            </button>
            <span className="text-xs text-border">·</span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteComment.isPending}
              className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-2">
          <Textarea
            ref={textareaRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditValue(comment.body);
                setIsEditing(false);
              }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSave();
              }
            }}
            className={compact ? 'min-h-[60px] text-sm' : 'min-h-[80px]'}
            disabled={updateComment.isPending}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditValue(comment.body);
                setIsEditing(false);
              }}
              disabled={updateComment.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!editValue.trim() || updateComment.isPending}
            >
              {updateComment.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <p className={`${textSize} whitespace-pre-wrap`}>{comment.body}</p>
      )}
    </div>
  );
}
