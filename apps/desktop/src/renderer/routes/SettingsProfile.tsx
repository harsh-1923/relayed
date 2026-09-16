import { useSession } from '@/app/state';
import { Badge } from '@/components/ui/badge';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { ActorAvatar } from '@/components/ActorAvatar';

export function SettingsProfile() {
  const { state } = useSession();
  const active = state.workspaces.find(w => w.workspaceId === state.workspaceId);
  if (!active) return null;

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">Your profile in {active.name}</CardTitle>
        <CardDescription>
          Per workspace, not per account. Editing is not built yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <ActorAvatar id={active.actorId} fallbackName={active.actorDisplayName} fallbackBlob={active.actorAvatarBlob} className="size-12" />
          <div className="flex-1">
            <div className="font-medium">{active.actorDisplayName}</div>
            <div className="text-sm text-muted-foreground">@{active.actorHandle}</div>
          </div>
          <Badge variant="outline">{active.actorRole}</Badge>
        </div>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 font-mono text-xs text-muted-foreground">
          <dt>actor</dt><dd className="truncate">{active.actorId}</dd>
          <dt>workspace</dt><dd className="truncate">{active.workspaceId}</dd>
          <dt>org</dt><dd className="truncate">{active.orgId}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
