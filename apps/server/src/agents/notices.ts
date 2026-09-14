// A run never ends silently (docs/WORKSPACE-AGENTS.md §5.7).
//
// One line of text per outcome that is not an answer, from a closed set —
// closed so it can be shown, logged and counted without ever carrying
// anything a model wrote. `reply.ts` posts the result as an ordinary message
// from the agent; nothing here writes to the database.
import type { RefusalCode } from './checkpoints.ts';

/** Why a run that reached the runtime still did not finish. */
export type FailureReason = 'runtime_unavailable' | 'run_failed';

const REFUSAL_TEXT: Record<RefusalCode, string> = {
  invoker_inactive: "I can't run this: whoever asked is no longer active here.",
  agent_inactive: "I can't run: I've been deactivated.",
  not_a_member: "I can't run here: I'm no longer a member of this space.",
  trigger_deleted: "I can't run this: the message that mentioned me was deleted.",
};

const FAILURE_TEXT: Record<FailureReason, string> = {
  runtime_unavailable: "I couldn't finish: the model provider is unavailable.",
  run_failed: "I couldn't finish: something went wrong partway through.",
};

/** The one line an agent posts for a terminal outcome that is not an answer. */
export function noticeFor(outcome: {
  state: 'refused'; code: RefusalCode;
} | {
  state: 'failed'; reason: FailureReason;
} | {
  state: 'timeout';
} | {
  state: 'interrupted';
} | {
  state: 'cancelled'; by: string;
}): string {
  switch (outcome.state) {
    case 'refused': return REFUSAL_TEXT[outcome.code];
    case 'failed': return FAILURE_TEXT[outcome.reason];
    case 'timeout': return 'I ran out of time before finishing.';
    case 'interrupted': return 'I was interrupted by a restart — ask again.';
    case 'cancelled': return `Stopped by ${outcome.by}.`;
  }
}
