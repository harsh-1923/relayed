// Plain REST, as apps/server/src/agents/composio.ts does — no SDK.
// Never prints the API key; results/ holds responses only.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export const BASE = 'https://backend.composio.dev/api/v3.1';
const key = process.env.COMPOSIO_API_KEY;
if (!key) throw new Error('COMPOSIO_API_KEY is not set (run with --env-file=../../.env)');

export async function api(method, path, body) {
  const started = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ms = Math.round(performance.now() - started);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ms, body: json };
}

export function save(name, value) {
  writeFileSync(new URL(`./results/${name}.json`, import.meta.url), JSON.stringify(value, null, 2) + '\n');
}

export const ALICE_NOT_CONNECTED = 'act_01M234E35YT76C26NGX42D9SAZ';
export const TOOLKITS = ['github', 'notion'];
