// The corpus for spike B, and the ground truth it is scored against.
//
// WHY NOT `pnpm mock`. Its message bodies are picked at random from a pool of
// one-liners ('shipping the fix now', 'standup in 5'), so no two adjacent
// messages relate. Granularity is a question ABOUT ADJACENCY, and a corpus with
// none would score every granularity the same and prove nothing — while looking
// like it had proved per-message is fine.
//
// WRITTEN TO BE FAIR, not to win. Roughly half the ground-truth facts are
// self-contained in one message, and half exist only across turns. A corpus of
// nothing but cross-turn facts would rig the result toward episodes, which is
// the thing this is meant to test rather than assume.
//
// Four exchanges with natural gaps between them: 09:02, 11:40, 14:05, 16:50.
// The last is mostly noise, so the gate has something to reject.

const PEOPLE = {
  priya: 'Priya Rao (@priya, act_01M2AAAA)',
  dev: 'Dev Anand (@dev, act_01M2BBBB)',
  mei: 'Mei Lin (@mei, act_01M2CCCC)',
  kiran: 'Kiran Shah (@kiran, act_01M2DDDD)',
  sam: 'Sam Oyelaran (@sam, act_01M2EEEE)',
};

const m = (t, who, text) => ({ t: `2026-09-15T${t}:00Z`, who: PEOPLE[who], text });

export const MESSAGES = [
  // ── Episode 1 — the cutover is blocked ────────────────────────────────────
  m('09:02', 'priya', 'cutover tonight is looking shaky, the index rebuild is still running'),
  m('09:03', 'dev', 'how far in?'),
  m('09:03', 'priya', 'about 40% after six hours'),
  m('09:04', 'dev', 'that will not finish before the window closes'),
  m('09:05', 'priya', 'agreed. so do we push the window or go without the rebuild?'),
  m('09:07', 'mei', 'going without it means the reporting queries stay slow for a week'),
  m('09:08', 'dev', 'a week of slow reports is survivable. a half-finished rebuild during cutover is not'),
  m('09:09', 'priya', 'ok. decision: we roll back the rebuild first, then retry the cutover'),
  m('09:10', 'mei', '+1'),
  m('09:10', 'kiran', 'works for me'),
  m('09:12', 'priya', 'someone needs to own the rollback script'),
  m('09:13', 'dev', 'I will take it, PR up within the hour'),
  m('09:14', 'priya', 'thanks. new window is Thursday 22:00 then'),
  m('09:19', 'kiran', 'I will let the support team know about Thursday'),

  // ── Episode 2 — the runbook ───────────────────────────────────────────────
  m('11:40', 'mei', 'where does the rollback procedure actually live? I could not find it'),
  m('11:41', 'kiran', 'QUARTZ runbook, section 4'),
  m('11:42', 'mei', 'that is very out of date, it still references the old replica names'),
  m('11:43', 'kiran', 'fair. I own it, I will bring it current before Thursday'),
  m('11:44', 'mei', 'appreciated'),
  m('11:47', 'dev', 'rollback PR is up — https://github.com/acme/platform/pull/4471'),
  m('11:48', 'priya', 'looking now'),
  m('11:52', 'priya', 'approved, one nit about the dry-run flag but nothing blocking'),

  // ── Episode 3 — root cause ────────────────────────────────────────────────
  m('14:05', 'dev', 'found why the rebuild is so slow'),
  m('14:06', 'dev', 'the statistics table has not been refreshed since June'),
  m('14:07', 'priya', 'since June?'),
  m('14:07', 'dev', 'the nightly job has been failing silently since the 12th'),
  m('14:08', 'mei', 'silently how? nothing alerted?'),
  m('14:09', 'dev', 'it exits 0 on a lock timeout. so the scheduler thinks it succeeded'),
  m('14:11', 'priya', 'that is a much bigger problem than tonight'),
  m('14:12', 'mei', 'do we have anything else running on that scheduler?'),
  m('14:13', 'kiran', 'the billing export and the search reindex'),
  m('14:14', 'priya', 'both of which would also fail silently'),
  m('14:16', 'dev', 'I can make it exit non-zero on a lock timeout, small change'),
  m('14:17', 'priya', 'do that today, separate from the cutover work'),
  m('14:18', 'dev', 'on it'),
  m('14:24', 'mei', 'I filed PLAT-2291 for the scheduler audit'),
  m('14:26', 'priya', 'good. that one is not urgent but it should not get lost'),
  m('14:31', 'sam', 'joining late — is Thursday confirmed for the cutover?'),

  // ── Episode 4 — mostly noise ──────────────────────────────────────────────
  m('16:50', 'kiran', 'anyone else getting logged out every twenty minutes'),
  m('16:51', 'mei', 'yes, constantly'),
  m('16:51', 'dev', 'lol same'),
  m('16:52', 'kiran', '🎉'),
  m('16:54', 'sam', 'thanks all'),
  m('16:55', 'mei', '+1'),
  m('16:58', 'priya', 'see you tomorrow'),
];

/**
 * What a careful person would write down after reading the room.
 *
 * `crossTurn: true` means the fact appears in NO SINGLE MESSAGE — it exists only
 * in the relation between two or more. That flag is the whole experiment: the
 * prediction is that per-message extraction loses these and keeps the others.
 *
 * Scored by term presence rather than by judgement, so the result is
 * reproducible and anyone can argue with the terms rather than with me.
 */
export const GROUND_TRUTH = [
  { id: 'decision-rollback', crossTurn: true,
    terms: [['roll back', 'rollback'], ['rebuild', 'index']],
    says: 'Decided to roll back the index rebuild before retrying the cutover' },
  { id: 'owner-rollback-script', crossTurn: true,
    terms: [['Dev'], ['rollback']],
    says: 'Dev Anand owns the rollback script' },
  { id: 'new-window', crossTurn: false,
    terms: [['Thursday'], ['22:00', '22', 'window']],
    says: 'The new cutover window is Thursday 22:00' },
  { id: 'rebuild-progress', crossTurn: false,
    terms: [['40'], ['rebuild', 'index']],
    says: 'The index rebuild was 40% done after six hours' },
  { id: 'cost-of-skipping', crossTurn: false,
    terms: [['reporting', 'report'], ['slow']],
    says: 'Skipping the rebuild leaves reporting queries slow for a week' },
  { id: 'runbook-location', crossTurn: true,
    terms: [['QUARTZ'], ['rollback', 'runbook']],
    says: 'The rollback procedure lives in the QUARTZ runbook' },
  { id: 'runbook-stale', crossTurn: false,
    terms: [['QUARTZ', 'runbook'], ['date', 'old', 'stale', 'current']],
    says: 'The QUARTZ runbook is out of date' },
  { id: 'owner-runbook', crossTurn: true,
    terms: [['Kiran'], ['runbook', 'QUARTZ']],
    says: 'Kiran Shah owns the QUARTZ runbook' },
  { id: 'pr-link', crossTurn: false,
    terms: [['4471']],
    says: 'The rollback PR is acme/platform#4471' },
  { id: 'root-cause', crossTurn: false,
    terms: [['statistic'], ['June', 'refresh']],
    says: 'The statistics table has not been refreshed since June' },
  { id: 'silent-failure', crossTurn: true,
    terms: [['exit', 'exits', 'zero', '0'], ['lock']],
    says: 'The nightly job exits 0 on a lock timeout, so failures are silent' },
  { id: 'blast-radius', crossTurn: true,
    terms: [['billing', 'search', 'reindex'], ['schedul']],
    says: 'The billing export and search reindex share that scheduler and would also fail silently' },
  { id: 'fix-assigned', crossTurn: true,
    terms: [['Dev'], ['non-zero', 'exit', 'lock']],
    says: 'Dev is fixing the exit code today, separately from the cutover' },
  { id: 'ticket', crossTurn: false,
    terms: [['PLAT-2291']],
    says: 'PLAT-2291 tracks the scheduler audit' },
];

/** Does any extracted fact express this ground-truth item? */
export function found(item, facts) {
  const haystack = facts.map((fact) => (fact.text ?? '').toLowerCase());
  return haystack.some((text) => item.terms.every((alternatives) =>
    alternatives.some((term) => text.includes(term.toLowerCase()))));
}

export const line = (message) => `${message.who} ${message.t}: ${message.text}`;
