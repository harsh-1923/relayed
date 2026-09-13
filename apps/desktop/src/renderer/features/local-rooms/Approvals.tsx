// What Claude Code is waiting on the person for, at the live edge of a local
// chat (docs/LOCAL-ROOMS.md §8.5).
//
// The turn is PAUSED while any of these is open: nothing happens until it is
// answered, the turn is stopped, or the app closes — each of which the runner
// answers for them. So they sit where the reply is being written, lined up with
// Claude's messages, not in a dialog that could be dismissed into limbo.
//
// Three kinds, one frame:
//   tool      Allow / Always allow for this session / Deny
//   question  Claude Code's AskUserQuestion, one question at a time
//   plan      its ExitPlanMode: the plan, then Approve or Keep planning
import { useState, type FormEvent, type ReactNode } from 'react';
import { ListCheck, QuestionMarkCircle, ShieldCheck } from '@relayed/icons';
import type { ApprovalDecision, PendingApproval } from '../../../preload/api';
import { Button } from '@/components/ui/button';
import {
  Questionnaire, QuestionnaireActions, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices,
  QuestionnaireInput, QuestionnaireItem, QuestionnaireNext, QuestionnairePrevious, QuestionnaireProgress,
  QuestionnaireSubmit, QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { MarkdownText } from '@/features/chat/MarkdownText';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';

export function Approvals({ chatId }: { chatId: string }) {
  const { rows: approvals } = useQuery('local.approvals.list', { chatId });
  if (!approvals || approvals.length === 0) return null;
  return (
    <>
      {approvals.map(approval => <Approval key={approval.id} approval={approval} />)}
    </>
  );
}

function Approval({ approval }: { approval: PendingApproval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    void call(api => api.query('local.approvals.respond', { chatId: approval.chatId, approvalId: approval.id, decision }))
      // On success the row is removed and this card unmounts; nothing to reset.
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  };

  switch (approval.kind) {
    case 'tool':
      return (
        <Frame
          icon={<ShieldCheck className="size-4" />}
          title={approval.title ?? `Claude wants to use ${approval.toolName}`}
          description={approval.description}
          error={error}
        >
          {detailOf(approval) && (
            <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm whitespace-pre-wrap select-text">
              {detailOf(approval)}
            </pre>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => respond({ type: 'deny' })}>Deny</Button>
            {approval.canAlwaysAllow && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => respond({ type: 'allow', always: true })}>
                Allow for this session
              </Button>
            )}
            <Button size="sm" disabled={busy} onClick={() => respond({ type: 'allow' })}>Allow</Button>
          </div>
        </Frame>
      );

    case 'plan':
      return (
        <Frame icon={<ListCheck className="size-4" />} title="Claude has a plan" error={error}>
          <div className="max-h-96 overflow-auto rounded-md border border-border px-4 py-3">
            <MarkdownText text={approval.plan} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => respond({ type: 'deny' })}>Keep planning</Button>
            <Button size="sm" disabled={busy} onClick={() => respond({ type: 'allow' })}>Go ahead</Button>
          </div>
        </Frame>
      );

    case 'question':
      return (
        <Frame
          icon={<QuestionMarkCircle className="size-4" />}
          title={approval.questions.length === 1 ? 'Claude has a question' : `Claude has ${approval.questions.length} questions`}
          error={error}
          aside={<Button variant="ghost" size="xs" disabled={busy} onClick={() => respond({ type: 'deny' })}>Dismiss</Button>}
        >
          <Questions approval={approval} busy={busy} onAnswer={answers => respond({ type: 'answer', answers })} />
        </Frame>
      );
  }
}

/**
 * One question at a time. Each is answered by picking its options or by
 * typing something else; a question with several answers joins them with
 * commas, which is the form Claude Code expects.
 */
function Questions({ approval, busy, onAnswer }: {
  approval: Extract<PendingApproval, { kind: 'question' }>;
  busy: boolean;
  onAnswer: (answers: Record<string, string>) => void;
}) {
  const name = (index: number) => `q${index}`;
  const items = approval.questions.map((question, index) => ({
    name: name(index), required: true, choices: question.options.map(option => ({ value: option.label })),
  }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onAnswer(Object.fromEntries(approval.questions.map((question, index) => [
      question.question,
      form.getAll(name(index)).map(String).map(value => value.trim()).filter(Boolean).join(', '),
    ])));
  };

  return (
    <Questionnaire items={items} onSubmit={submit}>
      {approval.questions.length > 1 && <QuestionnaireProgress />}
      {approval.questions.map((question, index) => (
        <QuestionnaireItem key={question.question} name={name(index)} required multiple={question.multiSelect}>
          <QuestionnaireTitle>{question.question}</QuestionnaireTitle>
          <QuestionnaireChoices>
            {question.options.map(option => (
              <QuestionnaireChoice key={option.label} value={option.label}>
                <span className="font-medium">{option.label}</span>
                {option.description && <QuestionnaireChoiceDescription>{option.description}</QuestionnaireChoiceDescription>}
              </QuestionnaireChoice>
            ))}
          </QuestionnaireChoices>
          <QuestionnaireInput placeholder="Something else…" />
        </QuestionnaireItem>
      ))}
      <QuestionnaireActions>
        <QuestionnairePrevious size="sm" />
        <QuestionnaireNext size="sm" />
        <QuestionnaireSubmit size="sm" disabled={busy}>Answer</QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  );
}

/** Lined up with Claude's replies (avatar + gap), and as wide as one. */
function Frame({ icon, title, description, error, aside, children }: {
  icon: ReactNode;
  title: string;
  description?: string | null;
  error: string | null;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="ml-9 flex max-w-[min(48rem,calc(100%-2.25rem))] flex-col gap-3 rounded-xl border border-border bg-card p-4 text-sm"
    >
      <header className="flex items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </header>
      {children}
      {error && <p className="text-destructive" role="alert">{error}</p>}
    </section>
  );
}

/** The part of a tool's input a person decides on: the whole command, or what it touches. */
function detailOf(approval: Extract<PendingApproval, { kind: 'tool' }>): string {
  const input = typeof approval.input === 'object' && approval.input !== null ? approval.input as Record<string, unknown> : {};
  const command = input['command'];
  return typeof command === 'string' ? command : approval.summary;
}
