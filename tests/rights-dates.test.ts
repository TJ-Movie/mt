import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRightsStatusChange, rightsDatesForVerification, RIGHTS_EXPIRY_WINDOW_DAYS } from '../lib/admin/rights-dates.ts';

const now = Date.parse('2026-09-17T12:34:56.789Z');


void test('blank verified selection receives current UTC verification and future expiry defaults', () => {
  const draft = applyRightsStatusChange({
    rightsStatus: 'pending', rightsVerifiedAt: undefined, rightsExpiresAt: undefined,
    publicationStatus: 'draft',
  }, 'verified', now);
  assert.equal(draft.rightsStatus, 'verified');
  assert.notEqual(draft.rightsVerifiedAt, undefined);
  assert.notEqual(draft.rightsExpiresAt, undefined);
  const verifiedAt = String(draft.rightsVerifiedAt);
  const expiresAt = String(draft.rightsExpiresAt);
  assert.match(verifiedAt, /^2026-09-17T12:34:55\.789Z$/);
  assert.match(expiresAt, /Z$/);
  assert.ok(Date.parse(verifiedAt) <= now);
  assert.ok(Date.parse(expiresAt) > now);
  assert.ok(Date.parse(expiresAt) > Date.parse(verifiedAt));
  assert.equal(draft.publicationStatus, 'draft');
  assert.equal(Date.parse(expiresAt) - now, RIGHTS_EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
});

void test('generated ISO values satisfy the server validation time contract', () => {
  const dates = rightsDatesForVerification({}, now);
  assert.ok(Date.parse(dates.rightsVerifiedAt) <= now);
  assert.ok(Date.parse(dates.rightsExpiresAt) > now);
  assert.ok(Date.parse(dates.rightsExpiresAt) > Date.parse(dates.rightsVerifiedAt));
});

void test('valid manually supplied timestamps are preserved exactly', () => {
  const manual = {
    rightsVerifiedAt: '2026-09-16T04:05:06.007Z',
    rightsExpiresAt: '2028-02-03T10:11:12.013Z',
  };
  assert.deepEqual(rightsDatesForVerification(manual, now), manual);
});

void test('rights date defaults require an explicit Verified status change', () => {
  const pending = applyRightsStatusChange({
    rightsStatus: 'pending', rightsVerifiedAt: undefined, rightsExpiresAt: undefined,
  }, 'pending', now);
  assert.deepEqual(pending, {
    rightsStatus: 'pending', rightsVerifiedAt: undefined, rightsExpiresAt: undefined,
  });
});