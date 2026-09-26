// The pure half of company domains (docs/ORG-DOMAINS.md §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalRefusal, domainOf, normaliseDomain, isPublicDomain } from './domains.ts';

test('domainOf lower-cases, trims, and takes what follows the last @', () => {
  assert.equal(domainOf(' Ravi@ACME.com '), 'acme.com');
  assert.equal(domainOf('no-at-sign'), '');
});

test('normaliseDomain accepts bare domains only', () => {
  assert.equal(normaliseDomain(' @Acme.COM. '), 'acme.com');
  assert.equal(normaliseDomain('mail.acme.co.uk'), 'mail.acme.co.uk');
  for (const bad of ['', 'acme', 'ravi@acme.com', 'acme..com', '-acme.com', 'acme.com/x', 'ac me.com']) {
    assert.equal(normaliseDomain(bad), null, bad);
  }
});

test('an admin may approve their own verified domain, and nothing else', () => {
  assert.equal(approvalRefusal('asha@acme.com', true, 'acme.com'), null);
  assert.equal(approvalRefusal('Asha@ACME.com', true, 'ACME.com'), null);
  assert.equal(approvalRefusal('meera@gmail.com', true, 'acme.com'), 'not_your_domain',
    'the attack: a gmail account approving somebody else\'s company');
  assert.equal(approvalRefusal('asha@acme.com', true, 'mail.acme.com'), 'not_your_domain',
    'subdomains are approved by someone on them');
  assert.equal(approvalRefusal('asha@acme.com', false, 'acme.com'), 'email_unverified');
  assert.equal(approvalRefusal('meera@gmail.com', true, 'gmail.com'), 'public_domain');
  assert.equal(approvalRefusal('asha@acme.com', true, 'not a domain'), 'invalid_domain');
});

test('the public list covers the obvious providers', () => {
  for (const d of ['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'proton.me', 'hotmail.com']) {
    assert.ok(isPublicDomain(d), d);
  }
  assert.equal(isPublicDomain('acme.com'), false);
});
