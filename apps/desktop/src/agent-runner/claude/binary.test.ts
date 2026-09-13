import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidates, claudeEnv, resolveClaude } from './binary.ts';

test('the installers\' homes are tried before PATH, which a Finder launch does not have', () => {
  const tried = candidates({ PATH: '/usr/bin:/bin' }, '/Users/me');
  assert.equal(tried[0], '/Users/me/.local/bin/claude');
  assert.ok(tried.indexOf('/opt/homebrew/bin/claude') < tried.indexOf('/usr/bin/claude'));
  assert.equal(new Set(tried).size, tried.length, 'no path is tried twice');
});

test('the first EXECUTABLE candidate wins; a file that cannot run is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relayed-claude-'));
  const notExecutable = join(dir, 'a', 'claude');
  const executable = join(dir, 'b', 'claude');
  for (const file of [notExecutable, executable]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '#!/bin/sh\n');
  }
  chmodSync(executable, 0o755);
  assert.equal(resolveClaude([join(dir, 'missing'), notExecutable, executable]).path, executable);
});

test('not installed says everywhere it looked', () => {
  const found = resolveClaude(['/nowhere/claude', '/nowhere-else/claude']);
  assert.equal(found.path, null);
  assert.deepEqual(found.searched, ['/nowhere/claude', '/nowhere-else/claude']);
});

test('the child\'s environment carries nothing of relayed\'s, and nothing that would sign it in as someone else', () => {
  const env = claudeEnv('/Users/me/.local/bin/claude', {
    HOME: '/Users/me', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-not-yours', ANTHROPIC_BASE_URL: 'https://proxy',
    CLAUDECODE: '1', WORKOS_CLIENT_ID: 'client_x', RELAYED_DATA: '/data', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x',
    CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
  });
  for (const leaked of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'WORKOS_CLIENT_ID', 'RELAYED_DATA', 'OTEL_EXPORTER_OTLP_ENDPOINT']) {
    assert.equal(env[leaked], undefined, leaked);
  }
  assert.equal(env['CLAUDE_CONFIG_DIR'], '/Users/me/.claude-work', 'a second account the person chose is kept');
  assert.equal(env['HOME'], '/Users/me', 'HOME is never rewritten: it moves the keychain');
  assert.match(env['PATH'] ?? '', /^\/Users\/me\/\.local\/bin:/);
  assert.equal(env['ENABLE_CLAUDEAI_MCP_SERVERS'], 'false');
});

test('USER is always set: without it the CLI cannot find its keychain login and says signed out', () => {
  // Measured under Electron's Node: the same probe, the same binary, reported
  // signed out with USER missing and Claude Max with it present.
  assert.equal(claudeEnv('/b/claude', { USER: 'me', HOME: '/Users/me' })['USER'], 'me');
  assert.ok((claudeEnv('/b/claude', { HOME: '/Users/me' })['USER'] ?? '').length > 0, 'derived when absent');
});
