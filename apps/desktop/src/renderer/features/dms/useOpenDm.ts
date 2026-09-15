// Open the DM or group DM with some people, and go to it (DESIGN.md §7.1).
//
// The server decides whether it already exists: asking for the same people
// again, in any order, opens the same conversation. So this never checks the
// replica first — a conversation made a moment ago on another device, or by
// the other person, is found by the one request either way.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { DM_MAX_MEMBERS } from '../../../shared/spaces.ts';

export function useOpenDm() {
  const { state } = useSession();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /** Resolves true once the conversation is open on screen. */
  async function open(actorIds: readonly string[]): Promise<boolean> {
    const workspaceId = state.workspaceId;
    if (!workspaceId || opening || actorIds.length === 0) return false;
    setOpening(true);
    setFailure(null);
    try {
      const answer = await call(api => api.query('dms.open', { workspaceId, actorIds: [...actorIds] }));
      if (!answer) return false;
      if (!answer.ok) {
        setFailure(
          answer.error === 'actor_unavailable' ? 'Someone you chose is no longer in this workspace.'
          : answer.reason === 'too_many' ? `A group message holds at most ${DM_MAX_MEMBERS} people, you included.`
          : answer.error === 'forbidden' ? 'You can no longer start conversations in this workspace.'
          : 'Could not open the conversation. Please try again.',
        );
        return false;
      }
      void navigate(`/w/${workspaceId}/s/${answer.space_id}`);
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not open the conversation.');
      return false;
    } finally {
      setOpening(false);
    }
  }

  return { open, opening, failure, offline: state.offline };
}
