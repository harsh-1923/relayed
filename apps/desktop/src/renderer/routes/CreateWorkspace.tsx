import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@/app/state';
import { WorkspaceForm } from '@/features/identity/WorkspaceForm';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';

export function CreateWorkspace() {
  const { state, apply } = useSession();
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // A first workspace can pre-fill from the identity WorkOS gave us; an
  // additional one has nothing to pre-fill from, and guessing would be worse
  // than an empty field.
  const first = state.auth.status === 'needs_workspace' ? state.auth : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{first ? 'Name your workspace' : 'New workspace'}</CardTitle>
        <CardDescription>
          {first
            ? `Signed in as ${first.identity.email}.`
            : 'A separate org, actor and local replica. Your handle here can differ.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not create it</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <WorkspaceForm
          defaultName={first?.identity.displayName
            ? `${first.identity.displayName}'s workspace` : ''}
          suggestions={first?.handleSuggestions ?? []}
          submitLabel="Create workspace"
          onError={setError}
          onDone={(s) => {
            apply(s);
            // The engine made it active; the URL follows, because the URL is
            // where "which workspace" is expressed (§4.5).
            if (s.workspaceId) void navigate(`/w/${s.workspaceId}`, { replace: true });
          }} />
      </CardContent>
    </Card>
  );
}
