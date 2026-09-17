import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { applyRightsStatusChange, initializeRightsForm, rightsDatesForVerification, RIGHTS_DEFAULT_EXPIRES_AT, RIGHTS_DEFAULT_REFERENCE, RIGHTS_DEFAULT_REVIEWER } from '../lib/admin/rights-dates.ts';

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
  assert.equal(expiresAt, RIGHTS_DEFAULT_EXPIRES_AT);
});

void test('existing pending movie with blank dates receives form defaults without changing status or source data', () => {
  const source = {
    rightsStatus: 'pending', rightsVerifiedAt: null, rightsExpiresAt: null,
    publicationStatus: 'draft', revision: 7,
  };
  const form = initializeRightsForm(source, now);
  assert.equal(form.rightsStatus, 'pending');
  assert.equal(form.publicationStatus, 'draft');
  assert.notEqual(form.rightsVerifiedAt, null);
  assert.notEqual(form.rightsExpiresAt, null);
  assert.ok(Date.parse(form.rightsVerifiedAt) <= now);
  assert.equal(form.rightsExpiresAt, RIGHTS_DEFAULT_EXPIRES_AT);
  assert.ok(Date.parse(form.rightsExpiresAt) > Date.parse(form.rightsVerifiedAt));
  assert.deepEqual(source, {
    rightsStatus: 'pending', rightsVerifiedAt: null, rightsExpiresAt: null,
    publicationStatus: 'draft', revision: 7,
  });
});

void test('blank form rights metadata receives the shared defaults without verification or publication changes', () => {
  const form = initializeRightsForm({
    rightsStatus: 'pending', rightsReviewer: null, rightsReference: '   ', publicationStatus: 'draft',
  }, now);
  assert.equal(form.rightsReviewer, RIGHTS_DEFAULT_REVIEWER);
  assert.equal(form.rightsReference, RIGHTS_DEFAULT_REFERENCE);
  assert.equal(form.rightsStatus, 'pending');
  assert.equal(form.publicationStatus, 'draft');
});

void test('existing custom rights metadata is preserved exactly', () => {
  const form = initializeRightsForm({
    rightsReviewer: 'Legal Team', rightsReference: 'Agreement-42',
  }, now);
  assert.equal(form.rightsReviewer, 'Legal Team');
  assert.equal(form.rightsReference, 'Agreement-42');
});
void test('existing verification time is preserved while every expiry uses the fixed catalogue default', () => {
  const stored = {
    rightsStatus: 'pending',
    rightsVerifiedAt: '2026-09-16T04:05:06.007Z',
    rightsExpiresAt: '2028-02-03T10:11:12.013Z',
  };
  const form = initializeRightsForm(stored, now);
  assert.equal(form.rightsVerifiedAt, stored.rightsVerifiedAt);
  assert.equal(form.rightsExpiresAt, RIGHTS_DEFAULT_EXPIRES_AT);
  assert.equal(form.rightsStatus, 'pending');
});

void test('Studio uses initialized form drafts for both initial and selected movies', () => {
  const source = readFileSync(new URL('../components/admin/movie-studio.tsx', import.meta.url), 'utf8');
  assert.match(source, /useState<DraftMovie>\(\(\) => draftFor\(selected\)\)/);
  assert.match(source, /setDraft\(draftFor\(source\)\)/);
  assert.match(source, /initializeRightsForm\(source\)/);
});
void test('generated ISO values satisfy the server validation time contract', () => {
  const dates = rightsDatesForVerification({}, now);
  assert.ok(Date.parse(dates.rightsVerifiedAt) <= now);
  assert.ok(Date.parse(dates.rightsExpiresAt) > now);
  assert.ok(Date.parse(dates.rightsExpiresAt) > Date.parse(dates.rightsVerifiedAt));
});

void test('valid verification time is preserved while supplied expiry is normalized', () => {
  const manual = {
    rightsVerifiedAt: '2026-09-16T04:05:06.007Z',
    rightsExpiresAt: '2028-02-03T10:11:12.013Z',
  };
  assert.deepEqual(rightsDatesForVerification(manual, now), {
    rightsVerifiedAt: manual.rightsVerifiedAt,
    rightsExpiresAt: RIGHTS_DEFAULT_EXPIRES_AT,
  });
});

void test('rights date defaults require an explicit Verified status change', () => {
  const pending = applyRightsStatusChange({
    rightsStatus: 'pending', rightsVerifiedAt: undefined, rightsExpiresAt: undefined,
  }, 'pending', now);
  assert.deepEqual(pending, {
    rightsStatus: 'pending', rightsVerifiedAt: undefined, rightsExpiresAt: undefined,
  });
});