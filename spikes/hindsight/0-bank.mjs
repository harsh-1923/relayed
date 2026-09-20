// Spike 0 — does a bank hold the configuration we give it?
//
// Two questions, and the second one cost somebody months:
//
// 1. WHAT IS THE CLIENT'S ACTUAL SURFACE? Written against the documented
//    method names. If any of them is wrong the other spikes fail opaquely, so
//    this prints what the client really exposes BEFORE using it.
//
// 2. THE PERSISTENCE TRAP (docs/MEMORY.md §6.4). Hindsight materialises the
//    bank row lazily on FIRST RETAIN. A config write before that returns 200
//    and persists nothing — which is how xyne-spaces ran production banks on
//    defaults for months without a single error. So: write, VERIFY BY READING
//    BACK, and when it did not stick, force materialisation with a warmup
//    retain and write again.
import { client, bankId, save, timed, check, observe, report } from './lib.mjs';

const bank = bankId('bank');
const MISSION = 'Extract decisions, ownership, blockers and root causes. Ignore greetings and scheduling.';

console.log('\nClient surface');
const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
  .filter((name) => name !== 'constructor')
  .sort();
observe('methods', surface);
save('client-surface', surface);
for (const required of ['retain', 'recall', 'listMemories', 'listDocuments', 'deleteDocument', 'createBank', 'updateBankConfig']) {
  check(`client exposes ${required}()`, surface.includes(required),
        `not found — the other spikes assume it. Real surface saved to results/client-surface.json`);
}

console.log(`\nBank ${bank}`);
await timed('createBank', () => client.createBank(bank));

// Write the config BEFORE any retain — i.e. exactly the situation the trap
// describes. If it sticks here, the warmup below is unnecessary and §6.4's
// ensureBank can be simpler than planned.
await timed('updateBankConfig (before any retain)', () => client.updateBankConfig(bank, {
  retainExtractionMode: 'custom',
  retainCustomInstructions: MISSION,
  enableObservations: false,
}));

const before = await timed('getBankConfig (before any retain)', () => client.getBankConfig(bank))
  .then((r) => r.value).catch(() => null);
save('config-before-retain', before ?? { error: 'getBankConfig unavailable' });

const stuckBefore = JSON.stringify(before ?? {}).includes('greetings and scheduling');
observe('config persisted before first retain', stuckBefore);
check('a config write before the first retain is not silently lost, OR the warmup repairs it',
      true, 'recorded either way — the assertion is the warmup path below');

if (!stuckBefore) {
  console.log('\nConfig did not stick. Forcing materialisation, as §6.4 describes.');
  await timed('warmup retain', () => client.retain(bank, {
    content: 'Bank tuning warmup. Not a real conversation.',
    documentId: 'warmup-tuning',
    tags: ['warmup-tuning'],   // tagged so a retention sweep can reap it later
  }, { async: false }));

  await timed('updateBankConfig (after warmup)', () => client.updateBankConfig(bank, {
    retainExtractionMode: 'custom',
    retainCustomInstructions: MISSION,
    enableObservations: false,
  }));

  const after = await timed('getBankConfig (after warmup)', () => client.getBankConfig(bank))
    .then((r) => r.value).catch(() => null);
  save('config-after-warmup', after ?? { error: 'getBankConfig unavailable' });
  check('the PATCH → verify → warmup → PATCH loop makes the config stick',
        JSON.stringify(after ?? {}).includes('greetings and scheduling'),
        'neither path persisted the config. ensureBank cannot be built as specified — see results/');
}

console.log(`\nLeaving bank ${bank} in place for inspection. Delete it with client.deleteBank('${bank}').`);
save('bank-id', { bank });
report('0-bank');
