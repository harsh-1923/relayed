// Spike A — can a tag carry a boundary inside one bank? (docs/MEMORY.md §5.3)
//
// WHY THIS DECIDES SOMETHING. Our bank map puts every PUBLIC space in one
// `ws:<workspace>` bank, separated only by a `space:<id>` tag, and enforces
// public-versus-private with a live tag list at recall (§8.2). That is a
// permission boundary carried by tags — the exact configuration that
// over-matched for xyne-spaces on 2026-05-25, returning a whole bank
// regardless of the tag passed.
//
// Their recall never passed `tags_match`, so the fail-open default (`any`,
// which INCLUDES untagged memories) applied. This separates the two causes.
//
// The single most important assertion is not about filtering at all: it is
// that every returned fact CARRIES ITS TAGS. If it does, we can re-filter in
// JavaScript and the bank map survives whatever the provider's filter does. If
// it does not, public spaces cannot share a bank and §5.2 needs rewriting.
//
// OBSERVATIONS ARE ON HERE, DELIBERATELY, though §6.4 turns them off in
// production. Consolidation is the mechanism that could merge facts across two
// scopes, so a spike with it disabled would prove nothing about the risk.
import { client, bankId, save, timed, check, observe, report, waitForFacts, rest } from './lib.mjs';

const bank = bankId('scopes');
const SPACE_A = 'space:spc_aaa';
const SPACE_B = 'space:spc_bbb';

// One shared entity across both scopes — "Northwind" — so consolidation has
// every reason to try to merge them. Scope B carries a phrase that appears
// nowhere in scope A, so a recall scoped to A that returns it has leaked, which
// makes the result detectable rather than arguable.
const B_MARKER = 'QUARTZ runbook';

const documents = [
  { id: 'a-1', tags: [SPACE_A], content:
    'Priya Rao (@priya) 2026-09-01T10:00:00Z: the Northwind migration is blocked on the vault rotation\n' +
    'Dev Anand (@dev) 2026-09-01T10:04:00Z: I will take the vault rotation, done by Thursday' },
  { id: 'a-2', tags: [SPACE_A], content:
    'Dev Anand (@dev) 2026-09-02T09:10:00Z: vault rotation is finished, Northwind is unblocked\n' +
    'Priya Rao (@priya) 2026-09-02T09:12:00Z: great, starting the Northwind cutover tomorrow' },
  { id: 'b-1', tags: [SPACE_B], content:
    'Kiran Shah (@kiran) 2026-09-01T11:00:00Z: the Northwind rollback plan lives in the QUARTZ runbook\n' +
    'Mei Lin (@mei) 2026-09-01T11:06:00Z: I own the QUARTZ runbook, I will keep it current' },
  { id: 'b-2', tags: [SPACE_B], content:
    'Mei Lin (@mei) 2026-09-03T14:00:00Z: updated the QUARTZ runbook with the Northwind rollback steps\n' +
    'Kiran Shah (@kiran) 2026-09-03T14:02:00Z: thanks, that is the Northwind recovery path now' },
  { id: 'u-1', tags: [], content:
    'Sam Oyelaran (@sam) 2026-09-04T08:00:00Z: Northwind has no owner on the weekend rota yet' },
];

console.log(`\nBank ${bank}`);
await timed('createBank', () => client.createBank(bank));
await timed('updateBankConfig', () => client.updateBankConfig(bank, { enableObservations: true }));

console.log('\nRetain');
for (const document of documents) {
  await timed(`retain ${document.id} [${document.tags.join(',') || 'untagged'}]`, () =>
    client.retain(bank, document.content, {
      context: 'A conversation between people in a workspace. None of them owns this memory bank.',
      documentId: document.id,
      // A deliberately PAST timestamp. If Hindsight stores ingest time instead,
      // every validity range in a temporal design is wrong — xyne-spaces flagged
      // this as an assumption their whole temporal design rested on, unverified.
      timestamp: '2026-09-01T10:00:00Z',
      tags: document.tags,
      metadata: { spike: 'scopes' },
      // `observationScopes` is left at its DEFAULT deliberately. It takes
      // 'per_tag' | 'combined' | 'all_combinations' | 'shared', and per_tag is
      // the remedy if consolidation turns out to cross a tag boundary — but the
      // default is what would bite someone who never read this far.
      async: false,
    }));
}

console.log('\nWaiting for extraction');
for (const document of documents) {
  const facts = await waitForFacts(bank, document.id);
  check(`${document.id} produced at least one fact`, facts.length > 0,
        'extraction returned nothing — the content or the config is wrong, and every assertion below is meaningless');
}
// Consolidation runs AFTER extraction, in the background. Give it room, or the
// scope question is asked before the thing that could break it has happened.
await new Promise((resolve) => setTimeout(resolve, 30_000));

// ─── The assertions that decide the bank map ────────────────────────────────

console.log('\nStrict recall, scoped to A');
const strict = (await timed('recall any_strict [A]', () => client.recall(bank, 'Northwind', {
  tags: [SPACE_A], tagsMatch: 'any_strict', budget: 'mid', maxTokens: 4096,
}))).value;
const strictResults = strict?.results ?? [];
save('recall-strict-a', strict);

check('strict recall returns something at all', strictResults.length > 0);

check('EVERY returned fact carries its tags', // ← the one that decides §5.2
      strictResults.length > 0 && strictResults.every((fact) => Array.isArray(fact.tags) && fact.tags.length > 0),
      'a fact with no tags cannot be re-filtered in JavaScript. If this fails, public spaces ' +
      'CANNOT share a bank and the bank map in §5.2 has to split them.');

// Raw facts carry their source document; OBSERVATIONS DO NOT, because a
// consolidated observation has several sources and no single one. So citations
// (§7.2) are buildable exactly as long as observations stay off — which §6.4
// already decided for a different reason (they ~2x-duplicate world facts).
// That makes `enable_observations: false` load-bearing twice over.
const rawFacts = strictResults.filter((fact) => fact.type !== 'observation');
const observations = strictResults.filter((fact) => fact.type === 'observation');
observe('raw facts / observations returned', `${rawFacts.length} / ${observations.length}`);

check('every RAW fact carries its document_id and our metadata',
      rawFacts.length > 0 && rawFacts.every((fact) =>
        typeof fact.document_id === 'string' && fact.document_id.length > 0 &&
        fact.metadata?.spike === 'scopes'),
      'without them a recalled fact cannot be traced to its messages, and §7.2 citations are unbuildable');

check('an OBSERVATION carries no document_id — recorded, not a defect',
      observations.every((fact) => !fact.document_id),
      'if an observation DOES carry one it is one of several sources, and citing it would be a lie');

check('stored fact text carries Hindsight\'s own annotation',
      rawFacts.some((fact) => /\| (When|Involving):/.test(fact.text ?? '')),
      'the annotation xyne-spaces warned compounds on a round trip — if absent, re-check the invariant');

check('no fact from scope B leaked into a scope-A recall',
      !strictResults.some((fact) => (fact.text ?? '').includes(B_MARKER)),
      `a result mentioned "${B_MARKER}", which appears only in scope B`);

check('no returned fact is tagged with scope B',
      !strictResults.some((fact) => (fact.tags ?? []).includes(SPACE_B)),
      'consolidation merged across a tag boundary — the union behaviour, and the leak');

// ─── The diagnostic: which of the two causes was the 2026-05-25 incident? ───

console.log('\nThe any / any_strict difference');
const loose = (await timed('recall any [A]', () => client.recall(bank, 'Northwind', {
  tags: [SPACE_A], tagsMatch: 'any', budget: 'mid', maxTokens: 4096,
}))).value;
const looseResults = loose?.results ?? [];
save('recall-any-a', loose);

observe('strict returned', strictResults.length);
observe('any returned', looseResults.length);
observe('any included untagged facts', looseResults.some((fact) => (fact.tags ?? []).length === 0));
observe('any included scope-B facts', looseResults.some((fact) => (fact.tags ?? []).includes(SPACE_B)));
observe('any leaked the B marker', looseResults.some((fact) => (fact.text ?? '').includes(B_MARKER)));

// ─── Did consolidation cross the boundary? ──────────────────────────────────

console.log('\nObservation scopes');
const scopes = await rest('GET', `/banks/${bank}/observations/scopes`);
save('observation-scopes', scopes);
if (scopes.status === 200 && Array.isArray(scopes.body?.scopes)) {
  const crossed = scopes.body.scopes.filter((scope) =>
    (scope.tags ?? []).includes(SPACE_A) && (scope.tags ?? []).includes(SPACE_B));
  observe('scopes found', scopes.body.scopes.length);
  check('no observation scope contains BOTH space tags', crossed.length === 0,
        `${crossed.length} scope(s) span both — consolidation unioned tags across the boundary`);
} else {
  observe('observations/scopes unavailable', scopes.status);
}

// ─── Forgetting, by the id we chose ─────────────────────────────────────────

console.log('\nDelete by our own documentId');
const beforeDelete = (await client.listMemories(bank, { documentId: 'a-1', limit: 100 }))?.items ?? [];
let deleteFailed = null;
await timed('deleteDocument a-1', () => client.deleteDocument(bank, 'a-1')).catch((error) => {
  deleteFailed = error?.message ?? String(error);
});
check('a client-supplied documentId is addressable by deleteDocument', deleteFailed === null,
      deleteFailed ?? '');

const afterDelete = (await client.listMemories(bank, { documentId: 'a-1', limit: 100 }))?.items ?? [];
save('delete-a-1', { factsBefore: beforeDelete.length, factsAfter: afterDelete.length });
check('the delete cascaded to every fact extracted from that document',
      beforeDelete.length > 0 && afterDelete.length === 0,
      `${beforeDelete.length} facts before, ${afterDelete.length} after — if they survive, ` +
      'the forget path in §8.1 has to be rebuilt around delete-by-tag');

// ─── Is `timestamp` the event's time, or ingest time? ───────────────────────

console.log('\nTimestamp fidelity');
const sample = (await client.listMemories(bank, { documentId: 'b-1', limit: 10 }))?.items?.[0];
save('timestamp-sample', sample ?? { error: 'no fact to sample' });
const occurred = sample?.occurredStart ?? sample?.occurred_start ?? sample?.date;
observe('occurredStart on a fact retained with timestamp 2026-09-01', occurred ?? 'absent');
check('the stored time is the event time we sent, not the ingest time',
      typeof occurred === 'string' && occurred.startsWith('2026-09-01'),
      'if this is today, every time shown on a timeline entry would be the ingest time (§14.3)');

console.log(`\nBank ${bank} left in place. Delete with client.deleteBank('${bank}').`);
report('1-scopes');
