const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, gateOf, approvalBody, COPILOT } = require('./reconcile.js');

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

test('waits when a push moved a stale-dismissed Copilot review to the new head', () => {
  assert.equal(d({ reviews: [rev(COPILOT, 'DISMISSED')] }).action, 'wait');
});

test('dismiss reason says Copilot approval was dismissed', () => {
  const r = d({ reviews: [rev(COPILOT, 'DISMISSED'), rev(BOT, 'APPROVED', SHA, 7)] });
  assert.match(r.reason, /Copilot's approval was dismissed/);
});

// gateOf(): the copilot-gate check for the head SHA.
const g = (reviews, decision) => gateOf({ sha: SHA, reviews, bot: BOT, decision });

test('gate passes when the bot has no active approval (humans decide)', () => {
  assert.equal(g([]).conclusion, 'success');
  assert.equal(g([rev(BOT, 'DISMISSED', OLD), rev(COPILOT, 'COMMENTED')]).conclusion, 'success');
});

test('gate passes when bot and Copilot both approved the head SHA', () => {
  const r = g([rev(COPILOT, 'APPROVED'), rev(BOT, 'APPROVED')]);
  assert.equal(r.conclusion, 'success');
  assert.match(r.title, /Copilot approved aaaaaaa/);
});

test('gate fails when the bot approval is for an older commit (stale approvals not dismissed)', () => {
  const r = g([rev(COPILOT, 'APPROVED', OLD), rev(BOT, 'APPROVED', OLD)]);
  assert.equal(r.conclusion, 'failure');
  assert.match(r.summary, /bbbbbbb/);
});

test('gate fails when the bot approved the head but Copilot has no live approval of it', () => {
  assert.equal(g([rev(COPILOT, 'DISMISSED'), rev(BOT, 'APPROVED')]).conclusion, 'failure');
  assert.equal(g([rev(COPILOT, 'APPROVED'), rev(COPILOT, 'CHANGES_REQUESTED'), rev(BOT, 'APPROVED')]).conclusion, 'failure');
});

test('gate fails when decide still wants to dismiss an active approval (e.g. files out of scope)', () => {
  const r = g([rev(COPILOT, 'APPROVED'), rev(BOT, 'APPROVED')], { action: 'dismiss', reason: 'out of scope' });
  assert.equal(r.conclusion, 'failure');
  assert.match(r.summary, /out of scope/);
});

// run(): fake GitHub that serves reviews from a script of states, one per poll.
// Reviews the bot creates or dismisses are applied on top of the script.
const { run } = require('./reconcile.js');
const fakeRun = async (script, { failDismiss = false } = {}) => {
  let poll = 0;
  const calls = [];
  const gates = [];
  const created = [];
  const dismissed = new Set();
  const reviewsNow = () =>
    [...script[Math.min(poll, script.length - 1)], ...created].map((r) => (dismissed.has(r.id) ? { ...r, state: 'DISMISSED' } : r));
  const github = {
    paginate: async (fn, args) => fn(args),
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getContent: async () => ({ data: { content: Buffer.from(CODEOWNERS).toString('base64') } }),
      },
      pulls: {
        get: async () => ({ data: { ...pr(), state: 'open', base: { ref: 'main' }, html_url: 'u' } }),
        listFiles: async () => [{ filename: 'backend/src/a.js' }],
        listReviews: async () => reviewsNow(),
        requestReviewers: async () => calls.push('request'),
      },
      issues: { listComments: async () => [], createComment: async () => calls.push('comment') },
      checks: { create: async (a) => gates.push(`${a.head_sha.slice(0, 7)}:${a.conclusion ?? a.status}`) },
    },
  };
  const botApi = {
    rest: {
      users: { getAuthenticated: async () => ({ data: { login: BOT } }) },
      pulls: {
        createReview: async (a) => { calls.push('approve'); created.push(rev(BOT, 'APPROVED', a.commit_id, 999)); },
        dismissReview: async (a) => {
          if (failDismiss) throw Object.assign(new Error('Forbidden'), { status: 403 });
          calls.push('dismiss');
          dismissed.add(a.review_id);
        },
      },
    },
  };
  let error;
  await run(
    { github, botApi, context: { repo: { owner: 'o', repo: 'r' } }, core: { info() {}, warning() {} }, prNumber: 1, wait: true, isPush: true },
    { waitMs: 10_000, pollMs: 1000, sleep: async () => { poll++; } },
  ).catch((e) => { error = e; });
  return { calls, gates, error };
};

test('push run: dismisses the not-yet-dismissed approval, then keeps waiting and approves', async () => {
  const { calls, gates } = await fakeRun([
    [rev(BOT, 'APPROVED', SHA, 7)],
    [rev(BOT, 'APPROVED', SHA, 7)],
    [rev(BOT, 'APPROVED', SHA, 7), rev(COPILOT, 'APPROVED')],
  ]);
  assert.deepEqual(calls.filter((c) => c !== 'comment'), ['dismiss', 'approve']);
  assert.deepEqual(gates, ['aaaaaaa:in_progress', 'aaaaaaa:success']);
});

test('push run: stops without approval when Copilot comments; gate passes (no bot approval)', async () => {
  const { calls, gates } = await fakeRun([[rev(COPILOT, 'COMMENTED')]]);
  assert.deepEqual(calls, []);
  assert.deepEqual(gates, ['aaaaaaa:in_progress', 'aaaaaaa:success']);
});

test('push after approval without stale dismissal: bot dismisses the old approval, gate passes only after that', async () => {
  // The ruleset does not dismiss stale approvals: the bot's approval of OLD is still APPROVED.
  const { calls, gates } = await fakeRun([[rev(COPILOT, 'APPROVED', OLD), rev(BOT, 'APPROVED', OLD, 5)]]);
  assert.ok(calls.includes('dismiss'));
  assert.deepEqual(gates, ['aaaaaaa:in_progress', 'aaaaaaa:success']);
});

test('push after approval: if the bot cannot dismiss, the gate fails closed', async () => {
  const { gates, error } = await fakeRun([[rev(COPILOT, 'APPROVED', OLD), rev(BOT, 'APPROVED', OLD, 5)]], { failDismiss: true });
  assert.ok(error);
  assert.deepEqual(gates, ['aaaaaaa:in_progress', 'aaaaaaa:failure']);
});
