// Which model Claude runs on in a local room, and how hard it thinks — chosen in
// the composer, beside the mode.
//
// The list is the person's own Claude Code's, from the start-up handshake the
// status probe already does (agent-runner/claude/status.ts), so it offers
// exactly what their plan can run. A new model takes effect from the next
// message; a new effort restarts the room's Claude Code and resumes it.
import { useState } from 'react';
import { ChevronDown } from '@relayed/icons';
import { DEFAULT_ROOM_MODEL } from '../../../shared/claude.ts';
import type { ClaudeModel, EffortLevel, LocalRoomSettings } from '../../../preload/api';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/query';
import { cn } from '@/lib/utils';

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};

/** Radio values are strings; the model's own default is this one. */
const DEFAULT_EFFORT = 'default';

export function RoomModelPicker({ spaceId, className, open, onOpenChange }: {
  spaceId: string;
  className?: string;
  /** Controlled, so /model and /effort can open it from the composer. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { rows } = useQuery('local.rooms.get', { spaceId });
  const { rows: statuses } = useQuery('claude.status');
  const [error, setError] = useState<string | null>(null);
  const room = rows?.[0];
  if (!room) return null;

  const status = statuses?.[0];
  const models = status?.state === 'ready' ? status.models : [];
  const chosen = room.model ?? DEFAULT_ROOM_MODEL;
  const current = find(models, chosen);

  const save = (model: string | null, effort: EffortLevel | null) => {
    setError(null);
    void call(api => api.query('local.rooms.setModel', { spaceId, model, effort }))
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); });
  };

  const chooseModel = (value: string) => {
    const next = models.find(model => model.value === value);
    // An effort the new model does not take goes back to its default.
    save(value, room.effort && next?.efforts.includes(room.effort) ? room.effort : null);
  };

  return (
    <DropdownMenu {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange: (next: boolean) => onOpenChange(next) } : {})}>
      <DropdownMenuTrigger
        aria-label={`Model: ${current?.displayName ?? chosen}`}
        title={error ?? current?.description ?? chosen}
        className={cn(className, error && 'text-destructive')}
      >
        <span>{current?.displayName ?? chosen}</span>
        {room.effort && <span className="composer-model-tone">{EFFORT_LABELS[room.effort]}</span>}
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-72">
        {models.length === 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              {status ? 'Claude Code is not ready. See Settings → Claude Agent.' : 'Asking Claude Code which models it has…'}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        ) : (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={current?.value ?? chosen} onValueChange={value => chooseModel(value as string)}>
                {models.map(model => (
                  <DropdownMenuRadioItem key={model.value} value={model.value} className="items-start py-1.5">
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{model.displayName}</span>
                      {model.description && <span className="text-xs text-muted-foreground">{model.description}</span>}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            {current && current.efforts.length > 0 && <Efforts room={room} model={current} onChoose={effort => save(room.model, effort)} />}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Efforts({ room, model, onChoose }: { room: LocalRoomSettings; model: ClaudeModel; onChoose: (effort: EffortLevel | null) => void }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={room.effort ?? DEFAULT_EFFORT}
          onValueChange={value => onChoose(value === DEFAULT_EFFORT ? null : value as EffortLevel)}
        >
          <DropdownMenuRadioItem value={DEFAULT_EFFORT}>Default</DropdownMenuRadioItem>
          {model.efforts.map(effort => (
            <DropdownMenuRadioItem key={effort} value={effort}>{EFFORT_LABELS[effort]}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </>
  );
}

/** The listed model a stored name means: its alias, or the id an alias resolves to. */
const find = (models: readonly ClaudeModel[], name: string): ClaudeModel | undefined =>
  models.find(model => model.value === name) ?? models.find(model => model.resolvedModel === name);
