import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOtlpHeaders } from './otlp.ts';

test('the spec\'s key=value,key2=value2 form parses', () => {
  assert.deepEqual(
    parseOtlpHeaders('authorization=Basic abc123,x-scope-orgid=42'),
    { authorization: 'Basic abc123', 'x-scope-orgid': '42' },
  );
});

test('a value containing = survives — Basic credentials are padded with it', () => {
  // Base64 pads with "=", so splitting on every "=" would truncate the token
  // and every export would 401 while the sink swallowed the error.
  assert.deepEqual(
    parseOtlpHeaders('authorization=Basic MTIzNDU2OmdsY19ley==='),
    { authorization: 'Basic MTIzNDU2OmdsY19ley===' },
  );
});

test('surrounding whitespace is trimmed, because people paste with spaces', () => {
  assert.deepEqual(parseOtlpHeaders(' a = 1 , b = 2 '), { a: '1', b: '2' });
});

test('unset, empty and malformed all mean no headers, never a throw', () => {
  // Telemetry configuration must not be able to fail a boot.
  assert.deepEqual(parseOtlpHeaders(undefined), {});
  assert.deepEqual(parseOtlpHeaders(''), {});
  assert.deepEqual(parseOtlpHeaders('novalue'), {});
  assert.deepEqual(parseOtlpHeaders('=novalue'), {});
});

test('a percent sign is left alone, not url-decoded', () => {
  // The spec permits percent-encoding; nobody hand-writing a Basic header
  // expects it, and decoding would corrupt a token containing a literal %.
  assert.deepEqual(parseOtlpHeaders('authorization=Basic a%2Bb'), { authorization: 'Basic a%2Bb' });
});
