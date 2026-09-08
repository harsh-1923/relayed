import './index.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DbInfo, RelayedApi } from '../preload/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

declare const window: Window & { relayed?: RelayedApi };

function App() {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [ports, setPorts] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Absent when served by the standalone vite.config.ts, so degrade rather
    // than throw — component work should not require booting Electron.
    if (!window.relayed) { setError('sync engine unavailable (standalone renderer)'); return; }
    (async () => {
      try {
        setInfo(await window.relayed!.query('db.info'));
        setPorts((await window.relayed!.query('ports.live')).count);
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  return (
    <main className="min-h-svh bg-background text-foreground p-10">
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Relayed
            <Badge variant="secondary">Phase 0</Badge>
          </CardTitle>
          <CardDescription>
            renderer → MessagePort → utilityProcess → SQLite
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && <p className="text-sm text-muted-foreground">{error}</p>}
          {info && (
            <>
              <Table>
                <TableBody>
                  {Object.entries({ ...info, livePorts: ports }).map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="text-muted-foreground w-40">{k}</TableCell>
                      <TableCell className="font-mono">{String(v)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Separator className="my-4" />
              <div className="flex gap-2">
                <Tooltip>
                  <TooltipTrigger render={<Button variant="outline">Reload</Button>} />
                  <TooltipContent>Re-runs the MessagePort handshake</TooltipContent>
                </Tooltip>
                <Button onClick={() => location.reload()}>Reload window</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
