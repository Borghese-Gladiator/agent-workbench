import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { AgentQuestion, AgentQuestionAnswer } from '../api.js';

/**
 * The interactive quiz for a mid-run agent question (Anthropic AskUserQuestion
 * shape). A question with options is selection-only — the backend rejects free
 * text for it (see validateAnswer) — so we render the options as single- or
 * multi-select chips and nothing else. A free-text-only question (no options)
 * renders a text box instead. Submitting posts the answer and the paused run
 * resumes.
 */
export function QuestionCard({
  question,
  onAnswer,
}: {
  question: AgentQuestion;
  onAnswer: (questionId: string, answer: AgentQuestionAnswer) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isPermission = question.permission != null;
  const freeTextOnly = !question.options || question.options.length === 0;

  const toggle = (label: string) => {
    if (question.multiSelect) {
      setSelected((cur) =>
        cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      );
    } else {
      setSelected([label]);
    }
  };

  const canSubmit = freeTextOnly ? other.trim().length > 0 : selected.length > 0;

  const submit = async () => {
    const answer: AgentQuestionAnswer = freeTextOnly
      ? { text: other.trim() }
      : { selected };
    setSubmitting(true);
    try {
      await onAnswer(question.id, answer);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-l-4 border-l-amber-400">
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <Badge variant="approval">{isPermission ? 'permission' : question.header}</Badge>
          <strong className="text-sm">{question.question}</strong>
        </div>

        {!freeTextOnly && (
          <div className="mt-3 flex flex-col gap-1.5">
            {question.options!.map((o) => {
              const active = selected.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => toggle(o.label)}
                  className={`rounded-md border px-3 py-2 text-left text-sm transition ${
                    active ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
                  }`}
                >
                  <div className="font-medium">{o.label}</div>
                  {o.description && (
                    <div className="text-xs text-muted-foreground">{o.description}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {freeTextOnly && (
          <div className="mt-3">
            <Input
              placeholder="Your answer…"
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" disabled={!canSubmit || submitting} onClick={submit}>
            Submit answer
          </Button>
          {question.multiSelect && !freeTextOnly && (
            <span className="text-xs text-muted-foreground">Select one or more</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
