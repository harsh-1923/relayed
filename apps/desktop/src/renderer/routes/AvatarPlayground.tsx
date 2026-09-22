// A bench for the generated agent avatars. Not a product surface.
//
// EXPERIMENTAL — reachable at /playground/avatars and linked only from a
// footer row in the sidebar. It exists so we can look at the generators against
// real agent handles, next to the hosted service we were considering, before
// deciding what agents wear.
//
// Two families, deliberately shown together rather than on separate pages: the
// decision is which one, and that is a comparison.
import { useEffect, useState } from 'react';
import {
  ACTIVITY_NOTES, AGENT_ACTIVITIES, activityForTool, EYE_MOODS, PETAL_COLORS,
  type AgentActivity, type EyeMood,
} from '@relayed/avatars';
import { EyeAvatar, PetalAvatar, type PetalAnimation } from '@relayed/avatars/react';
import { useRunPosture } from '@/lib/agent-posture';
import type { RunActivity } from '@/lib/agent-activity';
import { useQuery } from '@/lib/query';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const ANIMATIONS: PetalAnimation[] = ['none', 'morph', 'flow', 'breathe', 'orbit', 'spin'];

// Stand-ins for agent handles, so the grids say something with no workspace open.
const SAMPLE_SEEDS = [
  'scribe', 'triage', 'reviewer', 'watchtower', 'cartographer', 'ledger',
  'sentry', 'harvest', 'oracle', 'lantern', 'compass', 'quarry',
  'beacon', 'drafter', 'archivist', 'signal', 'ferry', 'atlas',
];

export function AvatarPlayground() {
  const [seed, setSeed] = useState('scribe');
  const { rows: actors } = useQuery('actors.list');
  const agents = (actors ?? []).filter(actor => actor.type === 'agent');

  return (
    <div className="space-y-6 pb-16">
      <div>
        <h1 className="text-lg font-semibold">Avatar playground</h1>
        <p className="text-sm text-muted-foreground">
          Generated locally from a seed — an agent&apos;s handle or id. No network, no stored blob;
          the same seed gives the same face on every device, forever.
        </p>
      </div>

      <div className="flex max-w-xl gap-2">
        <Input value={seed} onChange={e => setSeed(e.target.value)} placeholder="agent handle or id" aria-label="Seed" />
        <Button variant="outline" onClick={() => setSeed(Math.random().toString(36).slice(2, 10))}>Random</Button>
      </div>

      <Tabs defaultValue="eyes" className="gap-6">
        <TabsList>
          <TabsTrigger value="eyes">Eyes</TabsTrigger>
          <TabsTrigger value="states">States</TabsTrigger>
          <TabsTrigger value="segments">Segments</TabsTrigger>
          <TabsTrigger value="hosted">Hosted</TabsTrigger>
        </TabsList>

        <TabsContent value="eyes" className="space-y-8">
          <Eyes seed={seed} onSeed={setSeed} agents={agents} />
        </TabsContent>

        <TabsContent value="states" className="space-y-8">
          <States seed={seed} />
        </TabsContent>

        <TabsContent value="segments" className="space-y-8">
          <Segments seed={seed} onSeed={setSeed} agents={agents} />
        </TabsContent>

        <TabsContent value="hosted" className="space-y-4">
          <Hosted />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type Agent = { id: string; handle: string; displayName: string };

/** The run the simulator walks, in the order a real one would. */
const RUN_SCRIPT: { activity: AgentActivity; for: number; caption: string }[] = [
  { activity: 'waiting', for: 2200, caption: 'queued behind another run' },
  { activity: 'thinking', for: 3200, caption: 'deciding what it needs' },
  { activity: 'searching', for: 3000, caption: 'find_tools — casting about' },
  { activity: 'working', for: 2600, caption: 'call_tool — hands on it' },
  { activity: 'laser', for: 2200, caption: 'the hard part' },
  { activity: 'thinking', for: 2400, caption: 'reading what came back' },
  { activity: 'speaking', for: 2600, caption: 'writing the reply' },
  { activity: 'done', for: 2600, caption: 'delivered' },
];


/**
 * The same thing driven by the data we ACTUALLY have, rather than by a script.
 * Flip the run between the three states the wire carries and watch what the
 * face can and cannot know.
 */
function LiveRun({ seed }: { seed: string }) {
  const [state, setState] = useState<RunActivity['state'] | 'ended'>('running');
  const [label, setLabel] = useState('');
  const [runId, setRunId] = useState('run_01H8XQ');

  const run: RunActivity | null = state === 'ended'
    ? null
    : { runId, agentId: 'demo', threadId: 'demo', state, ...(label ? { label } : {}) };
  const posture = useRunPosture(run);

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">Driven by the real wire states</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">
        <code>queued</code> and <code>waiting</code> map straight onto a posture.
        <code className="mx-1">running</code> has no detail in it at all, so the face cycles through
        the postures that are true at any moment of a run. A label, if one ever arrives, wins over
        the cycle — type one in and watch it take over.
      </p>

      <div className="flex flex-wrap items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <EyeAvatar seed={seed} activity={posture} className="size-40" />
          <div className="text-center">
            <div className="text-sm font-medium">{posture}</div>
            <div className="text-xs text-muted-foreground">
              {state === 'ended' ? 'no run' : label ? 'from the label' : state === 'running' ? 'from the cycle' : 'from the wire'}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-center gap-3">
          <EyeAvatar seed={seed} activity={posture} className="size-8" />
          <span className="text-xs text-muted-foreground">32px</span>
        </div>
        <PetalAvatar seed={seed} activity={posture} className="size-32" />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {(['queued', 'running', 'waiting', 'ended'] as const).map(name => (
            <Button key={name} size="sm" variant={state === name ? 'default' : 'outline'} onClick={() => setState(name)}>
              {name}
            </Button>
          ))}
        </div>
        <div className="flex max-w-xl flex-wrap gap-2">
          <Input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="run.label — empty today, because the server drops it"
            aria-label="Run label"
          />
          <Button variant="outline" onClick={() => setRunId(`run_${Math.random().toString(36).slice(2, 8)}`)}>
            New run id
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The cycle is seeded on the run id, so every surface showing this run shows the same face at
          the same moment — a new id reshuffles the schedule.
        </p>
      </div>
    </section>
  );
}

function States({ seed }: { seed: string }) {
  const [playing, setPlaying] = useState(true);
  const [step, setStep] = useState(0);
  const [probe, setProbe] = useState('LINEAR_SEARCH_ISSUES');
  const current = RUN_SCRIPT[step % RUN_SCRIPT.length]!;

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setStep(n => n + 1), current.for);
    return () => clearTimeout(timer);
  }, [playing, step, current.for]);

  return (
    <>
      <p className="max-w-3xl text-sm text-muted-foreground">
        A state changes the eye shape and the choreography — never the colour. The run stays legible
        without the agent stopping being itself.
      </p>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold">A run, end to end</h2>
        <div className="flex flex-wrap items-center gap-8">
          <div className="flex flex-col items-center gap-3">
            <EyeAvatar seed={seed} activity={current.activity} className="size-40" />
            <div className="text-center">
              <div className="text-sm font-medium">{current.activity}</div>
              <div className="text-xs text-muted-foreground">{current.caption}</div>
            </div>
          </div>
          {/* Beside it at the size it would actually appear on a message. */}
          <div className="flex flex-col items-center gap-3">
            <EyeAvatar seed={seed} activity={current.activity} className="size-8" />
            <span className="text-xs text-muted-foreground">32px, as on a message</span>
          </div>
          <div className="flex flex-col items-center gap-3">
            <PetalAvatar seed={seed} activity={current.activity} className="size-40" />
            <span className="text-xs text-muted-foreground">segments, same state</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant={playing ? 'default' : 'outline'} onClick={() => setPlaying(p => !p)}>
            {playing ? 'Pause' : 'Play'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setStep(n => n + 1)}>Step</Button>
        </div>
      </section>

      <Separator />

      <LiveRun seed={seed} />

      <Separator />

      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Every state</h2>
        <div className="grid gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {AGENT_ACTIVITIES.map(activity => (
            <div key={activity} className="flex items-start gap-3">
              <EyeAvatar seed={seed} activity={activity} className="size-14 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{activity}</div>
                <div className="text-xs text-muted-foreground">{ACTIVITY_NOTES[activity]}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Tool name to posture</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Matched on substrings, not an enumeration: the tool list is a connector catalogue that grows
          whenever someone installs something, and a table needing an edit per tool would be stale in a
          week. Anything unrecognised lands on <code>working</code>, which is both the safe answer and
          the true one.
        </p>
        <div className="flex max-w-xl gap-2">
          <Input value={probe} onChange={e => setProbe(e.target.value)} aria-label="Tool name" />
          <div className="flex items-center gap-2 rounded-md border px-3">
            <EyeAvatar seed={seed} activity={activityForTool(probe)} className="size-6" />
            <span className="text-sm">{activityForTool(probe)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {['find_tools', 'call_tool', 'LINEAR_SEARCH_ISSUES', 'SLACK_SEND_MESSAGE', 'GITHUB_CREATE_PR', 'NOTION_GET_PAGE'].map(name => (
            <Button key={name} size="sm" variant="outline" onClick={() => setProbe(name)}>{name}</Button>
          ))}
        </div>
      </section>

      <Separator />

      {/* The honest part. This is the reason the tab exists as an argument and
          not just as a demo. */}
      <section className="max-w-3xl space-y-2 rounded-lg border border-dashed p-4">
        <h2 className="text-sm font-semibold">What is missing to ship this</h2>
        <p className="text-sm text-muted-foreground">
          Everything above is driven by a prop. The live data cannot fill it yet:
          <code className="mx-1">RunActivity.state</code> is only
          <code className="mx-1">queued | running | waiting</code>, and the server drops the tool name
          for the only two tools a workspace run reports — <code>find_tools</code> and
          <code className="mx-1">call_tool</code> — because neither reads well in a sentence.
          That is right for a sentence. It is expensive here, because those two are exactly
          <em className="mx-1">searching</em> and <em className="mx-1">using a tool</em>.
          So today a running agent can only ever be <code>working</code>.
        </p>
        <p className="text-sm text-muted-foreground">
          The fix is not to start showing raw tool names in the indicator text. It is to carry the
          posture alongside the label, so the sentence and the face can disagree about how much detail
          a person wants.
        </p>
        <p className="text-sm text-muted-foreground">
          Until then the cycle above stands in — but only over the postures that assert nothing.
          <code className="mx-1">speaking</code>, <code>done</code>, <code className="mx-1">failed</code>
          and <code>laser</code> are kept out of it, because each is a specific claim a person could
          catch us getting wrong.
        </p>
      </section>
    </>
  );
}


function Eyes({ seed, onSeed, agents }: { seed: string; onSeed: (seed: string) => void; agents: Agent[] }) {
  const [mood, setMood] = useState<EyeMood | null>(null);
  const [spacing, setSpacing] = useState(36);
  const [scale, setScale] = useState(1);
  const [animated, setAnimated] = useState(true);

  const shape = { spacing, scale, animated, ...(mood !== null && { mood }) };

  return (
    <>
      <p className="text-sm text-muted-foreground">
        A solid disc with the eyes cut OUT of it, so the surface behind shows through —
        the same face works on any background without picking an eye colour to match.
      </p>

      {/* On a chequerboard, because the whole point is that the eyes are holes. */}
      <div
        className="flex flex-wrap items-center gap-8 rounded-lg p-6"
        style={{
          backgroundImage: 'linear-gradient(45deg,#8883 25%,transparent 25%,transparent 75%,#8883 75%),linear-gradient(45deg,#8883 25%,transparent 25%,transparent 75%,#8883 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 8px 8px',
        }}
      >
        <EyeAvatar seed={seed} className="size-48" {...shape} />
        <div className="flex items-end gap-6">
          {[64, 40, 28, 20].map(px => (
            <div key={px} className="flex flex-col items-center gap-2">
              <EyeAvatar seed={seed} style={{ width: px, height: px }} {...shape} />
              <span className="text-xs text-muted-foreground">{px}px</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid max-w-3xl gap-5 sm:grid-cols-2">
        <Knob label="Eye spacing" value={spacing} min={16} max={44} step={1} onChange={setSpacing} />
        <Knob label="Eye scale" value={scale} min={0.5} max={1.6} step={0.05} onChange={setScale} />
        <div className="flex items-center gap-3 sm:col-span-2">
          <Switch id="eye-animated" checked={animated} onCheckedChange={setAnimated} />
          <Label htmlFor="eye-animated">Animate — gaze, blink and breath, each on its own clock</Label>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Moods</h2>
        <p className="text-sm text-muted-foreground">
          Every eye is one rounded rect, so a mood is just its proportions — which means moods
          could interpolate into each other when an agent&apos;s state changes.
        </p>
        <div className="flex flex-wrap gap-5">
          {EYE_MOODS.map(name => (
            <button key={name} type="button" onClick={() => setMood(name)} className="flex flex-col items-center gap-1.5">
              <EyeAvatar seed={seed} mood={name} spacing={spacing} scale={scale} animated={animated} className="size-16" />
              <span className={mood === name ? 'text-xs font-medium' : 'text-xs text-muted-foreground'}>{name}</span>
            </button>
          ))}
        </div>
        <Button size="sm" variant={mood === null ? 'default' : 'outline'} onClick={() => setMood(null)}>
          Mood from seed
        </Button>
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Spread</h2>
        <div className="flex flex-wrap gap-5">
          {SAMPLE_SEEDS.map(sample => (
            <button key={sample} type="button" onClick={() => onSeed(sample)} className="flex flex-col items-center gap-1.5">
              <EyeAvatar seed={sample} spacing={spacing} scale={scale} animated={animated} className="size-16" />
              <span className="text-xs text-muted-foreground">{sample}</span>
            </button>
          ))}
        </div>
      </section>

      <AgentGrid agents={agents} onSeed={onSeed} render={handle => <EyeAvatar seed={handle} animated={animated} className="size-16" />} />
    </>
  );
}

function Segments({ seed, onSeed, agents }: { seed: string; onSeed: (seed: string) => void; agents: Agent[] }) {
  const [gap, setGap] = useState(3.5);
  const [corner, setCorner] = useState(6);
  const [cuts, setCuts] = useState<number | null>(null);
  const [animation, setAnimation] = useState<PetalAnimation>('morph');
  const [duration, setDuration] = useState(5);
  const [morphAmount, setMorphAmount] = useState(3);

  const shape = { gap, corner, morphAmount, animation, duration, ...(cuts !== null && { cuts }) };

  return (
    <>
      <p className="text-sm text-muted-foreground">
        <strong className="font-medium text-foreground">morph</strong> is the one that moves the cuts:
        the geometry is rebuilt per frame with each gap slid along its own normal, and the browser
        interpolates between them. The others transform finished cells, so they can only shuffle
        rigid tiles — which is what made the first pass feel shaky.
      </p>

      <div className="flex flex-wrap items-center gap-8">
        <PetalAvatar seed={seed} className="size-48" {...shape} />
        <div className="flex items-end gap-6">
          {[64, 40, 28, 20].map(px => (
            <div key={px} className="flex flex-col items-center gap-2">
              <PetalAvatar seed={seed} style={{ width: px, height: px }} {...shape} />
              <span className="text-xs text-muted-foreground">{px}px</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid max-w-3xl gap-5 sm:grid-cols-2">
        <Knob label="Gap" value={gap} min={0} max={10} step={0.5} onChange={setGap} />
        <Knob label="Corner" value={corner} min={0} max={16} step={0.5} onChange={setCorner} />
        <Knob label="Cycle" value={duration} min={1} max={12} step={0.5} unit="s" onChange={setDuration} />
        <Knob label="Cut travel" value={morphAmount} min={0} max={8} step={0.5} onChange={setMorphAmount} />

        <div className="space-y-2">
          <Label>Cuts {cuts === null ? <span className="text-muted-foreground">(from seed)</span> : null}</Label>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant={cuts === null ? 'default' : 'outline'} onClick={() => setCuts(null)}>Auto</Button>
            {[1, 2, 3, 4, 5].map(n => (
              <Button key={n} size="sm" variant={cuts === n ? 'default' : 'outline'} onClick={() => setCuts(n)}>{n}</Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Animation</Label>
          <div className="flex flex-wrap gap-1.5">
            {ANIMATIONS.map(name => (
              <Button key={name} size="sm" variant={animation === name ? 'default' : 'outline'} onClick={() => setAnimation(name)}>
                {name}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Every colour, one shape</h2>
        <div className="flex flex-wrap gap-4">
          {PETAL_COLORS.map(color => (
            <PetalAvatar key={color} seed={seed} color={color} className="size-16" {...shape} />
          ))}
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Spread</h2>
        <div className="flex flex-wrap gap-5">
          {SAMPLE_SEEDS.map(sample => (
            <button key={sample} type="button" onClick={() => onSeed(sample)} className="flex flex-col items-center gap-1.5">
              <PetalAvatar seed={sample} className="size-16" {...shape} />
              <span className="text-xs text-muted-foreground">{sample}</span>
            </button>
          ))}
        </div>
      </section>

      <AgentGrid agents={agents} onSeed={onSeed} render={handle => <PetalAvatar seed={handle} className="size-16" {...shape} />} />
    </>
  );
}

function Hosted() {
  const [show, setShow] = useState(false);
  return (
    <>
      <div className="flex items-center gap-3">
        <Switch id="hosted" checked={show} onCheckedChange={setShow} />
        <Label htmlFor="hosted">Fetch from agentcareer.lol</Label>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Off by default: it sends the seed to a third party on every render, and draws nothing offline.
        Here for comparison only.
      </p>
      {show && (
        <div className="flex flex-wrap gap-5">
          {SAMPLE_SEEDS.slice(0, 8).map(sample => (
            <div key={sample} className="flex flex-col items-center gap-1.5">
              <img src={`https://avatar.agentcareer.lol/api/avatar.svg?seed=${encodeURIComponent(sample)}&size=128`} alt="" className="size-16" />
              <span className="text-xs text-muted-foreground">{sample}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function AgentGrid({ agents, onSeed, render }: {
  agents: Agent[];
  onSeed: (seed: string) => void;
  render: (handle: string) => React.ReactNode;
}) {
  if (agents.length === 0) return null;
  return (
    <>
      <Separator />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">This workspace&apos;s agents</h2>
        <p className="text-sm text-muted-foreground">Seeded on the handle, which is the stable one a person can read.</p>
        <div className="flex flex-wrap gap-5">
          {agents.map(agent => (
            <button key={agent.id} type="button" onClick={() => onSeed(agent.handle)} className="flex w-24 flex-col items-center gap-1.5">
              {render(agent.handle)}
              <span className="truncate text-xs text-muted-foreground">{agent.displayName}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function Knob({ label, value, min, max, step, unit, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label} <span className="text-muted-foreground">{value}{unit ?? ''}</span></Label>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={next => onChange((Array.isArray(next) ? next[0] : next) ?? value)}
      />
    </div>
  );
}
