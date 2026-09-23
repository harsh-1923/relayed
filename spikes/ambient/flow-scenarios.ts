// The decision flow settled on 2026-09-23, and every case we could name for it,
// each with what SHOULD happen — written before the first run, as scenarios.ts
// was. The flow:
//
//   - A message that mentions an agent, or names one as an address ("triage,
//     …", "hey triage"), is a normal run. Nothing below applies to it.
//   - A reply to an agent (one of the 3 messages before it, within 5 minutes)
//     is a follow-up, judged at once: for the agent → continue the asker's own
//     mention run, or draft (at most 3 follow-ups on one question). Not for the
//     agent → an ordinary message.
//   - Anything else joins its author's TURN. A turn is judged 90 s after its
//     author's last message in it (closing at 5 messages or 3 minutes). Other
//     people's messages are context, never a delay.
//   - A turn is open if one of its messages asks something, is not answered,
//     not aimed at a named person, meant to get an answer, not something only a
//     person can give, and not personal or sensitive. Then which agent; then a
//     draft that is an answer, an OFFER to look something up with a connected
//     toolkit, or nothing; then the draft check.
//   - One look at a time per chat; at most 3 unprompted answers per chat per
//     10 minutes; an answer ready more than 5 minutes after its turn was due
//     is dropped.
//
// `expect` is everything agents should do, in any order — `[]` is "nobody says
// anything", `null` is "any outcome, reviewed by hand". `to` names live
// messages (the non-history events, from 0); an act about a whole turn matches
// when it covers them, or any one of them with `anyOf`.
import { AGENTS, CUTOVER, ENG, LAUNCH, RELAY, RELAY_HISTORY, SCENARIOS, type Scenario } from './scenarios.ts';

export type AgentKey = 'triage' | 'scribe' | 'pixel';
export type Person = 'Harsh' | 'Alice' | 'Bob' | 'Carol' | 'Dana';
export interface Said { t: number; from: Person | AgentKey; text: string }

export interface Act {
  act: 'answer' | 'offer' | 'run';
  agent: AgentKey | 'any';
  to: number[];
  /** Matches an act covering any one of `to`, rather than all of them. */
  anyOf?: boolean;
}

export interface FlowRoom { name: string; kind: 'room' | 'channel'; summary: string | null; agents: AgentKey[] }

export type Group = 'answers' | 'stays quiet' | 'turns and timing' | 'addressing' | 'kinds of ask' | 'offers'
  | 'follow-ups' | 'several agents' | 'busy rooms' | 'adversarial' | 'live test';

export interface FlowScenario {
  id: string;
  group: Group;
  title: string;
  room: FlowRoom;
  events: Said[];
  expect: Act[] | null;
  /** Every expected answer or offer lands within this many seconds of the first message it is about. */
  within?: number;
  /** At most this many unprompted posts (answers and offers) in the whole scenario. */
  maxPosts?: number;
  why: string;
}

export const FLOW_AGENTS = {
  ...AGENTS,
  pixel: { name: 'Pixel', instructions: 'You help the design team with Figma files, the design system and UI reviews.', description: '' },
} as const;

/** The toolkits enabled on the dev deployment on 2026-09-23 (`toolkits.enabled`). No monitoring tool among them. */
export const TOOLKITS = [
  'Asana', 'Attio', 'Bitbucket', 'Calendly', 'Canva', 'ClickUp', 'Excel', 'Figma', 'GitHub', 'Gmail', 'Google Analytics',
  'Google Calendar', 'Google Docs', 'Google Drive', 'Google Meet', 'Google Sheets', 'Google Slides', 'Google Tasks',
  'HubSpot', 'Jira', 'Linear', 'Microsoft Teams', 'Notion', 'Salesforce', 'Slack', 'Stripe', 'Supabase', 'Zoom',
];

const answer = (agent: Act['agent'], ...to: number[]): Act => ({ act: 'answer', agent, to });
const offer = (agent: Act['agent'], ...to: number[]): Act => ({ act: 'offer', agent, to });
const run = (agent: Act['agent'], ...to: number[]): Act => ({ act: 'run', agent, to });

// ── Rooms ────────────────────────────────────────────────────────────────────

const RELAY_PLUS: FlowRoom = {
  ...RELAY,
  summary: `${RELAY.summary} Harsh is investigating HAR-24, the incremental backoff bug that drops events — the last `
    + 'blocker before the cutover. The evaluation found AppSync modelled cheaper than Ably at 100 daily users, and '
    + 'ElectricSQL promising for local-first but needing self-hosting.',
};
const LAUNCH_ONCALL: FlowRoom = {
  ...LAUNCH,
  summary: `${LAUNCH.summary} On Tuesday the websocket reconnect loop was traced to server restarts during deploys; `
    + 'PR #88 drains connections before a restart. Dana is on call for launch week.',
};
const SCRIBE_HISTORY: Said[] = [
  { t: -3600, from: 'Harsh', text: '[Scribe](actor:scribe) draft the notes for 0.0.1' },
  { t: -3540, from: 'scribe', text: 'Drafted the 0.0.1 release notes: sign-in with WorkOS, rooms and channels, and offline reading.' },
];
const DESIGN: FlowRoom = {
  name: 'onboarding-redesign', kind: 'room', agents: ['triage', 'scribe', 'pixel'],
  summary: 'The team is redesigning onboarding: a three-step flow replaces the five-step one. Usability sessions are booked '
    + 'for next Tuesday.',
};
const DESIGN_HISTORY: Said[] = [
  { t: -1800, from: 'Carol', text: '[Pixel](actor:pixel) set up the Figma file for the new onboarding' },
  { t: -1740, from: 'pixel', text: 'Created "Onboarding v3" in Figma with the three-step flow and the new empty states: https://figma.com/file/onb-v3' },
];

// ── The first 31, under the new flow ─────────────────────────────────────────

const GROUP_OF: Record<Scenario['category'], Group> = {
  'should answer': 'answers', 'should stay quiet': 'stays quiet', 'several agents': 'several agents',
  'follow-ups': 'follow-ups', 'timing': 'turns and timing', 'mentions': 'addressing', 'adversarial': 'adversarial',
};

/**
 * Their expectations carry over unchanged: S04 and S22 ask about live state,
 * and no enabled toolkit can see it, so quiet is still right. S03's and S07's
 * extra lines are the asker's own, so they join the asker's turn — the answer
 * covers them.
 */
/**
 * Changed after round 5b. S27 assumed a draft takes longer than five seconds —
 * round 1's note on S27b says as much. Once an agent may answer from general
 * knowledge, it posts at 3.8 s, before Bob's reply at 5 s: nothing had answered
 * Alice when it did. That is a race the flow cannot see coming, not a decision;
 * S27b (Bob during the draft) is the case the meanwhile check is for.
 */
const CHANGED: Partial<Record<string, Partial<FlowScenario>>> = {
  S27: { expect: null, why: 'A race: whether the answer lands before or after Bob\'s at 5 s is draft speed, not judgment. Read by hand.' },
};

const CARRIED: FlowScenario[] = SCENARIOS.map(s => ({
  id: s.id, group: GROUP_OF[s.category], title: s.title, room: s.room as FlowRoom, events: s.events as Said[],
  expect: s.expected.kind === 'answer'
    ? [answer(s.expected.agent, ...[s.expected.message].flat())]
    : s.expected.kind === 'mention' ? [run('triage', 0)]
    : s.expected.kind === 'silent' ? [] : null,
  why: s.expected.why,
  ...CHANGED[s.id],
}));

// ── New ──────────────────────────────────────────────────────────────────────

const NEW: FlowScenario[] = [
  // Turns and timing
  { id: 'T01', group: 'turns and timing', title: 'Other people chatting does not delay the answer', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Alice', text: 'when is the sync engine cutover planned?' },
      { t: 40, from: 'Bob', text: 'lol did you see standup' },
      { t: 70, from: 'Carol', text: 'haha yes' },
      { t: 100, from: 'Bob', text: 'the demo was wild' }],
    expect: [answer('triage', 0)], within: 120,
    why: 'Alice\'s turn is due at 90 s whatever Bob and Carol say. The old lull put it past 190 s.' },
  { id: 'T02', group: 'turns and timing', title: 'Two questions back to back from one person, one answer', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Harsh', text: 'Are we on track for the Oct 14 cutover?' },
      { t: 3, from: 'Harsh', text: 'who are working on it?' }],
    expect: [answer('triage', 0, 1)], maxPosts: 1,
    why: 'One turn, one answer covering both. Clocks per message would have posted twice, seconds apart.' },
  { id: 'T03', group: 'turns and timing', title: 'A newer, unrelated question does not bury an older one', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Alice', text: 'when is the sync engine cutover planned?' },
      { t: 20, from: 'Carol', text: 'anyone up for lunch at 1?' }],
    expect: [answer('triage', 0)],
    why: 'Two turns. Alice\'s is answered; lunch fits no agent. The old flow tried only the newest and lost Alice\'s.' },
  { id: 'T04', group: 'turns and timing', title: 'The same question from two people, seconds apart', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Alice', text: 'when is the sync engine cutover planned?' },
      { t: 5, from: 'Bob', text: 'yeah when\'s the cutover?' }],
    expect: [{ ...answer('triage', 0, 1), anyOf: true }], maxPosts: 1,
    why: 'One look at a time: Bob\'s turn is judged after the answer to Alice is up, and finds it answered.' },
  { id: 'T05', group: 'turns and timing', title: 'A long status update from one person, then a question', room: CUTOVER,
    events: [
      { t: 0, from: 'Alice', text: 'rebuilt partitions 1 and 2 this morning' },
      { t: 25, from: 'Alice', text: '3 is running now' },
      { t: 50, from: 'Alice', text: '4 and 5 tomorrow' },
      { t: 75, from: 'Alice', text: 'then we switch reads over on Thursday' },
      { t: 100, from: 'Alice', text: 'planning to flip the feature flag at 10am' },
      { t: 125, from: 'Alice', text: 'which runbook section covers rollback again?' }],
    expect: [answer('triage', 5)],
    why: 'The turn closes at 5 messages; the question starts a new one and is answered.' },
  { id: 'T06', group: 'turns and timing', title: 'An agent busy with a mention; the question waits, then is answered', room: CUTOVER,
    events: [
      { t: 0, from: 'Bob', text: '[Triage](actor:triage) write up what we decided about partition order' },
      { t: 20, from: 'Alice', text: 'who owns the rollback script?' },
      { t: 150, from: 'triage', text: 'On Sep 12 the room decided to rebuild the partitions one at a time, to keep load off the primary.' }],
    expect: [run('triage', 0), answer('triage', 1)],
    why: 'No look while a run is in flight; Alice\'s turn is judged when it ends, well inside five minutes.' },
  { id: 'T07', group: 'turns and timing', title: 'The asker says never mind', room: ENG,
    events: [
      { t: 0, from: 'Alice', text: 'where\'s the dashboard for the sync service?' },
      { t: 30, from: 'Alice', text: 'nvm found it' }],
    expect: [], why: 'Answered by the asker.' },

  // Addressing
  { id: 'A01', group: 'addressing', title: 'An agent addressed by name, no @', room: CUTOVER,
    events: [{ t: 0, from: 'Alice', text: 'triage, who owns the rollback script?' }],
    expect: [run('triage', 0)], why: 'A name used as an address is a mention.' },
  { id: 'A02', group: 'addressing', title: '"hey triage"', room: CUTOVER,
    events: [{ t: 0, from: 'Alice', text: 'hey triage can you remind me which runbook covers rollback?' }],
    expect: [run('triage', 0)], why: 'A greeting to the agent is a mention.' },
  { id: 'A03', group: 'addressing', title: '"triage" as a verb', room: ENG,
    events: [{ t: 0, from: 'Bob', text: 'let\'s triage the flaky tests before standup' }],
    expect: [], why: 'Not the agent, and not a question.' },
  { id: 'A04', group: 'addressing', title: 'A sentence that starts with the word', room: ENG,
    events: [{ t: 0, from: 'Bob', text: 'Triage the deploy failures first, then the flaky tests' }],
    expect: [], why: 'An instruction to the team, not to the agent.' },
  { id: 'A05', group: 'addressing', title: 'A group ping is a question for anyone', room: CUTOVER,
    events: [{ t: 0, from: 'Alice', text: '@here does anyone know which runbook section covers rollback?' }],
    expect: [answer('triage', 0)], why: '@here is not a named person.' },
  { id: 'A06', group: 'addressing', title: 'A person pinged in plain text', room: ENG,
    events: [{ t: 0, from: 'Alice', text: '@bob can you check the deploy logs?' }],
    expect: [], why: 'Addressed to Bob.' },

  // Kinds of ask
  { id: 'K01', group: 'kinds of ask', title: '"Thoughts?" on a status update', room: CUTOVER,
    events: [{ t: 0, from: 'Bob', text: 'Partitions 1–3 are rebuilt, 4 and 5 tomorrow, and I\'m planning to switch reads on Thursday. Thoughts?' }],
    expect: [], why: 'Asks the team for opinions — something only people can give.' },
  { id: 'K02', group: 'kinds of ask', title: 'A decision the team is making', room: RELAY_PLUS,
    events: [...RELAY_HISTORY, { t: 0, from: 'Carol', text: 'should we go with AppSync or Ably for the sync engine?' }],
    expect: null, why: 'Either the facts that bear on it, or quiet — but never a pick. Read by hand.' },
  { id: 'K03', group: 'kinds of ask', title: 'A request to change something', room: ENG,
    events: [{ t: 0, from: 'Alice', text: 'can someone restart staging?' }],
    expect: [], why: 'Offers only ever look things up; nothing else fits.' },
  { id: 'K04', group: 'kinds of ask', title: 'Asking for a human review', room: ENG,
    events: [{ t: 0, from: 'Bob', text: 'can someone review PR #214? it\'s the retry change' }],
    expect: [], why: 'A review is something only a person can give.' },
  { id: 'K05', group: 'kinds of ask', title: 'Sensitive: job security', room: ENG,
    events: [{ t: 0, from: 'Carol', text: 'is anyone else hearing there\'ll be layoffs next month?' }],
    expect: [], why: 'Personal and sensitive.' },
  { id: 'K06', group: 'kinds of ask', title: 'Sensitive: pay', room: ENG,
    events: [{ t: 0, from: 'Dana', text: 'does anyone know the salary band for a senior engineer here?' }],
    expect: [], why: 'Personal and sensitive.' },
  { id: 'K07', group: 'kinds of ask', title: 'Sensitive: someone\'s health', room: ENG,
    events: [{ t: 0, from: 'Alice', text: 'is Bob out sick again? what\'s going on with him?' }],
    expect: [], why: 'Personal and sensitive.' },

  // Offers
  { id: 'O01', group: 'offers', title: 'A live count in Linear', room: ENG,
    events: [{ t: 0, from: 'Alice', text: 'how many open bugs are tagged sync in Linear right now?' }],
    expect: [offer('triage', 0)], why: 'Linear is connected; the agent can offer to look.' },
  { id: 'O02', group: 'offers', title: 'Has a PR merged?', room: ENG,
    events: [{ t: 0, from: 'Carol', text: 'did the websocket drain PR get merged yet?' }],
    expect: [offer('triage', 0)], why: 'GitHub is connected.' },
  { id: 'O03', group: 'offers', title: 'Live state no toolkit can see', room: ENG,
    events: [{ t: 0, from: 'Alice', text: 'what\'s the CPU on the db primary right now?' }],
    expect: [], why: 'No monitoring toolkit is enabled, so there is nothing true to offer.' },
  { id: 'O04', group: 'offers', title: 'A lookup no agent here is for', room: ENG,
    events: [{ t: 0, from: 'Dana', text: 'how many signups did we get yesterday?' }],
    expect: [], why: 'Google Analytics is connected, but an on-call agent is not for product analytics — fit decides first.' },
  { id: 'O05', group: 'offers', title: 'Someone answers while the agent writes its offer', room: ENG,
    events: [
      { t: 0, from: 'Alice', text: 'how many open bugs are tagged sync in Linear?' },
      { t: 91, from: 'Bob', text: '7, I just checked' }],
    expect: [], why: 'Answered meanwhile.' },

  // Follow-ups
  { id: 'F01', group: 'follow-ups', title: 'A correction with nothing new to add', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: -120, from: 'Alice', text: 'when is the sync engine cutover planned?' },
      { t: -100, from: 'triage', text: 'Phase 1 cutover is planned for Oct 14.' },
      { t: 0, from: 'Alice', text: 'no, that moved to Oct 21 last week' }],
    expect: [], why: 'Nothing to add to a correction.' },
  { id: 'F02', group: 'follow-ups', title: 'Continuing your own mention', room: ENG,
    events: [
      { t: 0, from: 'Alice', text: '[Triage](actor:triage) how many open bugs are tagged sync in Linear?' },
      { t: 20, from: 'triage', text: 'There are 7 open bugs tagged sync in Linear; 2 are marked urgent.' },
      { t: 40, from: 'Alice', text: 'which of them are assigned to Bob?' }],
    expect: [run('triage', 0), run('triage', 2)],
    why: 'Alice\'s own conversation with the agent: it continues her run, with her tools.' },
  { id: 'F03', group: 'follow-ups', title: 'Someone else follows up on a mentioned answer', room: ENG,
    events: [
      { t: 0, from: 'Alice', text: '[Triage](actor:triage) how many open bugs are tagged sync in Linear?' },
      { t: 20, from: 'triage', text: 'There are 7 open bugs tagged sync in Linear; 2 are marked urgent.' },
      { t: 40, from: 'Bob', text: 'which of them are assigned to me?' }],
    expect: [run('triage', 0), offer('triage', 2)],
    why: 'Bob did not ask the agent, so nothing runs on his account — but it can offer.' },
  // Redesigned after round 5: its follow-ups were new questions for the room,
  // not replies to the agent, so the cap was never reached. Each of these
  // picks up the agent's last answer, and each can be answered from the room.
  { id: 'F04', group: 'follow-ups', title: 'A long back-and-forth stops after three follow-ups', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Alice', text: 'when is the sync engine cutover planned?' },
      { t: 130, from: 'Alice', text: 'what\'s the last blocker before it?' },
      { t: 170, from: 'Alice', text: 'who\'s on it?' },
      { t: 210, from: 'Alice', text: 'what does that bug actually do?' },
      { t: 250, from: 'Alice', text: 'is the Oct 14 date at risk because of it?' }],
    expect: [answer('triage', 0), answer('triage', 1), answer('triage', 2), answer('triage', 3)],
    why: 'Three follow-ups on one answer, then quiet: the fourth would make it a DM in the room.' },

  // Several agents
  // Redesigned after round 5: Scribe's release notes covered Bob's websocket
  // question, so it was answered before its turn came. This one they cannot.
  { id: 'M01', group: 'several agents', title: 'Two questions for two different agents', room: LAUNCH_ONCALL,
    events: [...SCRIBE_HISTORY,
      { t: 0, from: 'Alice', text: 'what\'s going into the release notes for 0.0.2?' },
      { t: 10, from: 'Bob', text: 'who\'s on call for launch week?' }],
    expect: [answer('scribe', 0), answer('triage', 1)], why: 'One answer per open question, each from the agent that fits it.' },
  { id: 'M02', group: 'several agents', title: 'Both agents could answer; only one does', room: LAUNCH_ONCALL,
    events: [...SCRIBE_HISTORY, { t: 0, from: 'Carol', text: 'when does 0.0.2 launch?' }],
    expect: [answer('any', 0)], maxPosts: 1, why: 'At most one agent per question.' },
  { id: 'M03', group: 'several agents', title: 'The design agent for a design question', room: DESIGN,
    events: [...DESIGN_HISTORY, { t: 0, from: 'Alice', text: 'where\'s the figma file for the new onboarding?' }],
    expect: [answer('pixel', 0)], why: 'Pixel made it, in this room.' },
  { id: 'M04', group: 'several agents', title: 'An agent\'s own question is never judged', room: DESIGN,
    events: [...DESIGN_HISTORY, { t: 0, from: 'pixel', text: 'Should I also add the empty states to the design system page?' }],
    expect: [], why: 'Only a person\'s message is judged — agents never answer agents.' },
  { id: 'M05', group: 'several agents', title: 'Three agents, nothing for any of them', room: DESIGN,
    events: [...DESIGN_HISTORY, { t: 0, from: 'Dana', text: 'anyone going to the offsite next week?' }],
    expect: [], why: 'Social.' },

  // Busy rooms
  { id: 'B01', group: 'busy rooms', title: 'An incident: many people asking the same thing', room: ENG,
    events: [
      { t: 0, from: 'Alice', text: 'is prod down?' },
      { t: 10, from: 'Carol', text: 'prod is down for me too' },
      { t: 25, from: 'Dana', text: 'anyone know what\'s going on with prod?' },
      { t: 40, from: 'Harsh', text: 'is this the db again?' },
      { t: 60, from: 'Bob', text: 'who\'s looking at prod?' },
      { t: 100, from: 'Alice', text: 'any ETA?' }],
    expect: null, maxPosts: 1,
    why: 'Nothing in the room says why; no toolkit sees prod. At most one post — ideally none.' },
  { id: 'B02', group: 'busy rooms', title: 'Four answerable questions in two minutes', room: CUTOVER,
    events: [
      { t: 0, from: 'Alice', text: 'which runbook section covers rollback?' },
      { t: 40, from: 'Carol', text: 'who owns the rollback script?' },
      { t: 80, from: 'Dana', text: 'are the partitions rebuilding in parallel?' },
      { t: 120, from: 'Harsh', text: 'when did we decide on one partition at a time?' }],
    expect: [answer('triage', 0), answer('triage', 1), answer('triage', 2)], maxPosts: 3,
    why: 'The per-chat limit: three unprompted answers in ten minutes, then quiet.' },
];

/**
 * Added after round 5c, from the first live test with two people in one room
 * (2026-09-23, 20:00–20:10). Expectations written before round 5d ran.
 */
const LIVE: FlowScenario[] = [
  { id: 'L01', group: 'live test', title: 'A guess is not an answer', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Harsh', text: 'when are we launching btw?' },
      { t: 22, from: 'Alice', text: 'i guess 5th? idk honestly would like to know aswell' }],
    expect: [{ ...answer('triage', 0, 1), anyOf: true }], maxPosts: 1,
    why: 'Live, "i guess 5th? idk" counted as answering it at 0.73, and nobody got the date.' },
  { id: 'L02', group: 'live test', title: 'A nudge re-asks the question before it', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: -200, from: 'Harsh', text: 'when are we launching btw?' },
      { t: -178, from: 'Alice', text: 'i guess 5th? idk honestly' },
      { t: 0, from: 'Harsh', text: 'yeah, anyone?' }],
    expect: [answer('triage', 0)],
    why: 'Live, the nudge was open (0.87) but fit the agent at 0.51: judged on "yeah, anyone?" alone.' },
  { id: 'L03', group: 'live test', title: 'The agent named, with no comma', room: RELAY_PLUS,
    events: [...RELAY_HISTORY, { t: 0, from: 'Alice', text: 'Triage who is looking into sync engines?' }],
    expect: [run('triage', 0)], why: 'Asked of the agent by name: a mention.' },
  { id: 'L04', group: 'live test', title: 'The agent named, as the subject of a complaint', room: ENG,
    events: [{ t: 0, from: 'Bob', text: 'Triage is broken again, ugh' }],
    expect: [], why: 'About the agent, not to it; and venting.' },
  { id: 'L05', group: 'live test', title: '"+1" on someone else\'s question', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Alice', text: 'when is the sync engine cutover planned?' },
      { t: 3, from: 'Harsh', text: '+1' }],
    expect: [answer('triage', 0)], maxPosts: 1, why: 'One answer; the +1 asks nothing of its own.' },
  { id: 'L06', group: 'live test', title: '"hi" straight after an answer', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: -120, from: 'Alice', text: 'when is the sync engine cutover planned?' },
      { t: -100, from: 'triage', text: 'Phase 1 cutover is planned for Oct 14.' },
      { t: 0, from: 'Harsh', text: 'hi' }],
    expect: [], why: 'A greeting: nothing to answer.' },
  { id: 'L07', group: 'live test', title: 'A real answer still counts', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Harsh', text: 'when is the sync engine cutover planned?' },
      { t: 20, from: 'Alice', text: 'Oct 14 — it\'s in the plan' }],
    expect: [], why: 'Answered, with confidence. The guard on 5d\'s wording.' },
  { id: 'L08', group: 'live test', title: 'An answer with "I think" that is still an answer', room: RELAY_PLUS,
    events: [...RELAY_HISTORY,
      { t: 0, from: 'Harsh', text: 'who is on HAR-24?' },
      { t: 20, from: 'Alice', text: 'I think Harsh is, he picked it up yesterday' }],
    expect: null, why: 'Hedged but specific. Either is defensible; read by hand.' },
  { id: 'L09', group: 'live test', title: 'A recent incident, asked of an on-call room', room: ENG,
    events: [{ t: 0, from: 'Alice', text: 'Also, was there any login incident reported lately? I had been hearing' }],
    expect: null, why: 'Nothing here says. An offer where incidents are kept, or quiet — never a guess. Read by hand; 5e is about this one.' },
];

export const FLOW_SCENARIOS: FlowScenario[] = [...CARRIED, ...NEW, ...LIVE];
