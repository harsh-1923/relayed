// Shared rig for the Hindsight spikes (docs/MEMORY.md §15, stage 0).
//
// Through the OFFICIAL TS CLIENT rather than raw REST, unlike
// spikes/composio-discovery — the server will ship on this client, so the spike
// validates the thing we will actually depend on. A REST spike would prove the
// API works and leave the client untested, which is the half we do not control.
//
// NEVER PRINTS THE API KEY. results/ holds responses only.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { HindsightClient } from '@vectorize-io/hindsight-client';

const baseUrl = process.env.HINDSIGHT_BASE_URL;
const apiKey = process.env.HINDSIGHT_API_KEY;
export const tenant = process.env.HINDSIGHT_TENANT ?? 'default';

if (!baseUrl || !apiKey) {
  throw new Error('HINDSIGHT_BASE_URL and HINDSIGHT_API_KEY are not set (run with --env-file=../../.env)');
}

export const client = new HindsightClient({ baseUrl, apiKey });

/** A bank id nobody else will collide with, so a rerun never reads a stale bank. */
export const bankId = (name) => `spike-${name}-${Date.now().toString(36)}`;

export function save(name, value) {
  writeFileSync(new URL(`./results/${name}.json`, import.meta.url), JSON.stringify(value, null, 2) + '\n');
}

/** Time one call, so the README carries real numbers rather than the vendor's. */
export async function timed(label, run) {
  const started = performance.now();
  try {
    const value = await run();
    const ms = Math.round(performance.now() - started);
    console.log(`  ${label} — ${ms}ms`);
    return { value, ms };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    console.log(`  ${label} — FAILED after ${ms}ms: ${error?.message ?? error}`);
    throw error;
  }
}

// ─── Assertions ─────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

/** An assertion whose failure is a finding, not a crash — the run continues. */
export function check(description, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${description}`);
  } else {
    failures.push({ description, detail });
    console.log(`  ✗ ${description}${detail ? `\n      ${detail}` : ''}`);
  }
}

/**
 * Something observed and recorded rather than asserted.
 *
 * The `any` vs `any_strict` difference is the whole reason spike A exists: it
 * separates "the provider over-matches" from "xyne-spaces never closed the
 * fail-open default". Neither outcome is a failure of OUR design, so neither is
 * a failed assertion — but both change what stage 5 has to do.
 */
export function observe(description, value) {
  console.log(`  · ${description}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

export function report(name) {
  console.log(`\n${name}: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    save(`${name}-failures`, failures);
    process.exitCode = 1;
  }
}

/**
 * Wait for facts to appear for a document.
 *
 * `async: false` on retain bounds the WRITE, not extraction and consolidation,
 * which finish afterwards. Polling here rather than sleeping a fixed amount,
 * because a fixed sleep is either slow or flaky and eventually both.
 */
export async function waitForFacts(bank, documentId, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = await client.listMemories(bank, { documentId, limit: 100 });
    const items = listed?.items ?? listed?.results ?? [];
    if (items.length > 0) return items;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return [];
}

/**
 * A raw call, for endpoints the client may not surface yet.
 *
 * `observations/scopes` is the one this exists for: it is documented REST and
 * it is the only direct read of whether consolidation crossed a tag boundary.
 * Never logs the key.
 */
export async function rest(method, path) {
  const res = await fetch(`${baseUrl}/v1/${tenant}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}
