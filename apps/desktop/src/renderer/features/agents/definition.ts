// An agent's definition, read over the socket when a surface opens
// (WORKSPACE-AGENTS.md §4.5). Online-only: the instructions are never in the
// replica, so this is the one agent read that can be unreachable.
import { useCallback, useEffect, useState } from 'react';
import type { AgentDefinition } from '../../../preload/api';
import { call } from '@/lib/ipc';

export type DefinitionState =
  | { status: 'loading' }
  | { status: 'unreachable' }
  | { status: 'not_found' }
  | { status: 'ready'; definition: NonNullable<AgentDefinition['definition']> };

/**
 * Read it on mount and whenever `revision` moves — the summary's `configRev`
 * from the replica, which a directory event bumps when someone else edits the
 * agent, so an open profile does not keep showing what it was told before.
 */
export function useAgentDefinition(agentId: string | undefined, revision?: number) {
  const [state, setState] = useState<DefinitionState>({ status: 'loading' });

  const load = useCallback(async () => {
    if (!agentId) return;
    try {
      const answer = await call(api => api.query('agents.definition', { agentId }));
      if (answer === null) setState({ status: 'unreachable' });
      else if (!answer.found || !answer.definition) setState({ status: 'not_found' });
      else setState({ status: 'ready', definition: answer.definition });
    } catch {
      setState({ status: 'unreachable' });
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load, revision]);
  return { state, reload: load };
}

/** What the server's refusal reasons mean, in words for beside a field. */
export function describeRefusal(field: string | undefined, reason: string | undefined, error: string): string {
  if (error === 'handle_taken') return 'That handle is taken — by a person or an agent.';
  if (error === 'agent_deactivated') return 'This agent is deactivated.';
  if (error === 'forbidden') return 'You do not have permission to do that.';
  if (error === 'not_found') return 'This agent no longer exists here.';
  const words: Record<string, string> = {
    required: 'Required.',
    too_long: 'Too long.',
    one_line: 'Keep it to one line.',
    reserved: 'That handle is reserved.',
    too_short: 'At least 3 characters.',
    bad_start: 'Start with a letter.',
    bad_chars: 'Lowercase letters, numbers, dots, dashes and underscores only.',
    provider_slash_model: 'Write it as provider/model, or leave it blank for the default.',
    not_a_workspace_member: 'Only people in this workspace can maintain an agent.',
    too_many: 'Too many.',
  };
  return (reason && words[reason]) ?? `${field ?? 'This'} could not be saved (${reason ?? error}).`;
}
