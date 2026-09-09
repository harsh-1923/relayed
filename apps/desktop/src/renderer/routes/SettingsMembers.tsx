import { useState } from 'react';
import { Invitations } from '@/features/settings/Invitations';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export function SettingsMembers() {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive" className="max-w-xl">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {/* Renders nothing when the local mirror says neither action exists —
          hidden rather than disabled (AUTHZ.md §3). */}
      <Invitations onError={setError} />
    </div>
  );
}
