const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, approvalBody, COPILOT } = require('./reconcile.js');

const BOT = 'approval-test-bot';
const SHA = 'aaaaaaa1111';
const OLD = 'bbbbbbb2222';
const CODEOWNERS = `*  @human\n/backend/  @org/backend @${BOT}\n/frontend/ @org/frontend\n`;
const pr = (o = {}) => ({ number: 1, draft: false, user: { login: 'dev' }, head: { sha: SHA }, ...o });
const rev = (login, state, commit_id = SHA, id = Math.floor(Math.random() * 1e6)) => ({ id, user: { login }, state, commit_id });
const d = (o) => decide({ pr: pr(), files: ['backend/src/a.js'], reviews: [], codeowners: CODEOWNERS, bot: BOT, ...o });

test('approves when Copilot approved head and bot owns all files', () => {
  assert.equal(d({ reviews: [rev(COPILOT, 'APPROVED')] }).action, 'approve');
});

test('waits when Copilot has not reviewed head and bot has no approval', () => {
  assert.equal(d().action, 'wait');
});

test('dismisses when Copilot review of head was dismissed', () => {
  const r = d({ reviews: [rev(COPILOT, 'DISMISSED'), rev(BOT, 'APPROVED', SHA, 7)] });
  assert.equal(r.action, 'dismiss');
  assert.deepEqual(r.dismiss.map((x) => x.id), [7]);
  assert.match(r.reason, /was dismissed/);
});

test('dismisses when Copilot re-reviewed with a comment', () => {
  const r = d({ reviews: [rev(COPILOT, 'APPROVED'), rev(BOT, 'APPROVED', SHA, 7), rev(COPILOT, 'COMMENTED')] });
  assert.equal(r.action, 'dismiss');
  assert.match(r.reason, /COMMENTED/);
});

test('dismisses when a file outside the bot scope was added', () => {
  const r = d({ files: ['backend/a.js', 'frontend/b.js'], reviews: [rev(COPILOT, 'APPROVED'), rev(BOT, 'APPROVED', SHA, 7)] });
  assert.equal(r.action, 'dismiss');
  assert.match(r.reason, /frontend\/b\.js/);
});

test('does nothing for files outside scope when bot has no approval', () => {
  assert.equal(d({ files: ['frontend/b.js'], reviews: [rev(COPILOT, 'APPROVED')] }).action, 'none');
});

test('never approves deny-listed files even inside backend', () => {
  assert.equal(d({ files: ['backend/CLAUDE.md'], reviews: [rev(COPILOT, 'APPROVED')] }).action, 'none');
});

test('does not approve twice', () => {
  assert.equal(d({ reviews: [rev(COPILOT, 'APPROVED'), rev(BOT, 'APPROVED')] }).action, 'none');
});

test('approves again after a push once Copilot approved the new head', () => {
  const reviews = [rev(COPILOT, 'DISMISSED', OLD), rev(BOT, 'DISMISSED', OLD), rev(COPILOT, 'APPROVED')];
  assert.equal(d({ reviews }).action, 'approve');
});

test('dismisses on draft and skips bot-authored PRs', () => {
  assert.equal(d({ pr: pr({ draft: true }), reviews: [rev(BOT, 'APPROVED')] }).action, 'dismiss');
  assert.equal(d({ pr: pr({ user: { login: BOT } }), reviews: [rev(COPILOT, 'APPROVED')] }).action, 'none');
});

test('approval body names the commit, the Copilot review and the files', () => {
  const body = approvalBody({ bot: BOT, sha: SHA, copilot: { id: 42 }, files: ['backend/src/a.js'], prUrl: 'https://x/pull/1' });
  assert.match(body, /aaaaaaa/);
  assert.match(body, /pullrequestreview-42/);
  assert.match(body, /`backend\/src\/a\.js`/);
});
