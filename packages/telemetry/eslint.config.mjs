// Rules that make the OBSERVABILITY.md §8 discipline enforceable rather than
// remembered. Applied repo-wide from the root config; this file documents why.
export const telemetryRules = {
  // Nothing outside @relayed/telemetry may reach for a backend SDK directly.
  'no-restricted-imports': ['error', {
    paths: [
      { name: 'pino', message: 'Import from @relayed/telemetry instead (OBSERVABILITY §8).' },
    ],
    patterns: [
      { group: ['@opentelemetry/*'], message: 'Import from @relayed/telemetry instead (OBSERVABILITY §8).' },
    ],
  }],
  // Structured logging only. This is the privacy control: a template literal is
  // where a message body ends up in Loki (OBSERVABILITY §6).
  'no-console': 'error',
  'no-restricted-syntax': ['error', {
    selector: "CallExpression[callee.object.name='log'] > TemplateLiteral",
    message: 'Structured fields only — no interpolated log messages (OBSERVABILITY §6).',
  }],
};
