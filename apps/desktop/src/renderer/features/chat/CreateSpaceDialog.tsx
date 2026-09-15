import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export function CreateSpaceDialog({ kind, workspaceId, onClose }: {
  kind: 'channel' | 'room';
  workspaceId: string;
  onClose: () => void;
}) {
  const { state } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submitting = useRef(false);
  const workspaceName = state.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.name;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || state.offline || !name.trim()) return;
    submitting.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await call(api => api.query('spaces.create', {
        workspaceId, kind, name: name.trim(), visibility: isPrivate ? 'private' : 'public',
      }));
      if (!answer) return;
      if (!answer.ok) {
        setFailure(answer.error === 'forbidden'
          ? `You no longer have permission to create a ${kind} in this workspace.`
          : answer.error === 'invalid'
            ? 'Enter a name between 1 and 100 characters and choose a visibility.'
            : `Could not create the ${kind}. Please try again.`);
        return;
      }
      onClose();
      void navigate(`/w/${workspaceId}/s/${answer.space_id}`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : `Could not create the ${kind}.`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !submitting.current) onClose(); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <form onSubmit={event => { void submit(event); }} className="contents">
          <DialogHeader>
            <DialogTitle>Create {kind === 'channel' ? 'channel' : 'room'}</DialogTitle>
            <DialogDescription>
              {kind === 'channel' ? 'A shared conversation' : 'A place to work together'} in {workspaceName ?? 'this workspace'}.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm">
            Name
            <Input
              autoFocus required maxLength={100} value={name} disabled={busy}
              placeholder={kind === 'channel' ? 'e.g. design' : 'e.g. Website launch'}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              Private {kind}
              <span className="mt-1 block text-xs text-muted-foreground">
                {isPrivate ? 'Only people you add can find and join it.' : 'Anyone in the workspace can find and join it.'}
              </span>
            </span>
            <Switch checked={isPrivate} onCheckedChange={setPrivate} disabled={busy} />
          </label>
          <p className="text-xs text-muted-foreground">You’ll join automatically. Add people after creating it.</p>
          {state.offline && <p role="status" className="text-sm text-muted-foreground">Connect to create a {kind}.</p>}
          {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || state.offline || !name.trim()}>
              {busy ? 'Creating…' : `Create ${kind}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
