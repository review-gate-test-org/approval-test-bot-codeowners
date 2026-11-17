// Keeps the bot's approval in sync with Copilot's verdict on the PR's head commit.
//
// approve  - Copilot APPROVED the head commit, the bot is a code owner of every changed file,
//            no changed file is on the deny list, the PR is not a draft and not authored by the bot.
// dismiss  - the bot has an active approval, but the conditions above no longer hold
//            (Copilot's approval was dismissed or replaced, files out of scope, PR became a draft).
// wait     - no Copilot review of the head commit yet (only a push-triggered run waits).
// none     - nothing to do.
//
// GitHub itself dismisses the bot's approval on a new push (ruleset: dismiss stale approvals).
// For that case the script only posts a comment that explains it.

const COPILOT = 'copilot-pull-request-reviewer[bot]';
const MARKER = '<!-- bot-approval -->';

// Paths the bot never approves, whatever CODEOWNERS says.
const HARD_DENY = [
  /^\.github\//,
  /^(docs\/)?CODEOWNERS$/,
  /(^|\/)(AGENTS|CLAUDE|GEMINI|REVIEW)\.md$/,
  /^README\.md$/,
  /(^|\/)\.claude\//,
];

// CODEOWNERS glob -> RegExp. Supports *, **, ?, leading / (anchor) and trailing / (directory).
const toRegex = (pattern) => {
  const anchored = pattern.replace(/\/$/, '').includes('/');
  let p = pattern.replace(/^\//, '');
  if (!anchored) p = '**/' + p;
  if (p.endsWith('/')) p += '**';
  const re = p
    .split(/(\*\*\/|\/\*\*|\*|\?)/)
    .map((t) =>
      t === '**/' ? '(?:.*/)?'
        : t === '/**' ? '/.*'
          : t === '*' ? '[^/]*'
            : t === '?' ? '[^/]'
              : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${re}(?:/.*)?$`);
};

const parseOwners = (text = '') =>
  text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { re: toRegex(pattern), owners };
    });

// Last matching line wins (CODEOWNERS semantics).
const ownersOf = (rules, file) => {
  let hit;
  for (const r of rules) if (r.re.test(file)) hit = r;
  return hit ? hit.owners : [];
};

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const short = (sha) => sha.slice(0, 7);

const botMayApprove = (rules, file, bot) =>
  !HARD_DENY.some((r) => r.test(file)) && ownersOf(rules, file).some((o) => same(o, '@' + bot));

/**
 * Pure decision.
 * @returns {{ action: 'approve'|'dismiss'|'wait'|'none', reason: string, copilot?: object, dismiss?: object[] }}
 */
const decide = ({ pr, files, reviews, codeowners, bot }) => {
  const sha = pr.head.sha;
  const botReviews = reviews.filter((r) => same(r.user.login, bot));
  const active = botReviews.filter((r) => r.state === 'APPROVED');
  const dismiss = (reason) =>
    active.length ? { action: 'dismiss', reason, dismiss: active } : { action: 'none', reason };

  if (pr.draft) return dismiss('the PR is a draft');
  if (same(pr.user.login, bot)) return { action: 'none', reason: 'the bot is the PR author' };

  const rules = parseOwners(codeowners);
  const blocked = files.filter((f) => !botMayApprove(rules, f, bot));
  if (blocked.length) {
    return dismiss(`@${bot} is not allowed to approve these files: ${blocked.map((f) => '`' + f + '`').join(', ')}`);
  }

  // GitHub moves commit_id of a review dismissed by a push to the new head, so a DISMISSED review
  // "of the head" may really be a stale review of an older commit. Only live reviews count.
  const ofHead = reviews.filter((r) => r.user.login === COPILOT && r.commit_id === sha);
  const copilot = ofHead.filter((r) => r.state !== 'DISMISSED').at(-1);
  if (!copilot) {
    const why = ofHead.length ? `Copilot's approval was dismissed` : `Copilot has not reviewed ${short(sha)}`;
    return active.length ? dismiss(why) : { action: 'wait', reason: `${why}; waiting for a Copilot review of ${short(sha)}` };
  }
  if (copilot.state !== 'APPROVED') return dismiss(`Copilot's latest review of ${short(sha)} is ${copilot.state}, not APPROVED`);

  if (active.some((r) => r.commit_id === sha)) return { action: 'none', reason: `already approved ${short(sha)}` };
  return { action: 'approve', reason: `Copilot approved ${short(sha)} and @${bot} owns every changed file`, copilot, files };
};

const approvalBody = ({ bot, sha, copilot, files, prUrl }) => [
  MARKER,
  `### ✅ Approved by @${bot}`,
  '',
  `Copilot code review [approved](${prUrl}#pullrequestreview-${copilot.id}) commit ${short(sha)}, and every changed file is in a path where @${bot} is a code owner:`,
  '',
  ...files.map((f) => `- \`${f}\``),
  '',
  `I will dismiss this approval if Copilot's approval goes away. A new push dismisses it automatically.`,
].join('\n');

const readCodeowners = async (github, repo, ref) => {
  for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    try {
      const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  return '';
};

const evaluate = async (github, repo, pr, ref, bot) => {
  const [changed, reviews, codeowners] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: pr.number, per_page: 100 }),
    readCodeowners(github, repo, ref),
  ]);
  const files = [...new Set(changed.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  return { result: decide({ pr, files, reviews, codeowners, bot }), reviews };
};

// On a push, GitHub has already dismissed the bot's approval of the old commit. Say so once per commit.
const commentOnPush = async ({ github, repo, pr, reviews, bot }) => {
  const sha = pr.head.sha;
  // Don't compare commit_id: GitHub moves it to the new head when a push dismisses the review.
  const mine = reviews.filter((r) => same(r.user.login, bot));
  const old = mine.at(-1);
  if (!old || old.state !== 'DISMISSED') return;
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: pr.number, per_page: 100 });
  const tag = `${MARKER}<!-- push=${sha} -->`;
  if (comments.some((c) => c.body?.includes(tag))) return;
  await github.rest.issues.createComment({
    ...repo,
    issue_number: pr.number,
    body: `${tag}\nℹ️ New commits were pushed after my approval, so GitHub dismissed it. I will approve ${short(sha)} again once Copilot approves it.`,
  });
};

const WAIT_MS = 15 * 60_000;
const POLL_MS = 30_000;
const REQUEST_AFTER_MS = 3 * 60_000;

/**
 * Entry point for actions/github-script.
 * @param github  octokit with the job's GITHUB_TOKEN (read, comments)
 * @param botApi  octokit authenticated as the bot (approve, dismiss)
 * @param prNumber PR to check; empty = all open PRs to the default branch
 * @param wait    true only for push-triggered runs: wait for Copilot's review of the new commit
 */
const run = async ({ github, botApi, context, core, prNumber, wait = false, isPush = false },
  { waitMs = WAIT_MS, pollMs = POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) => {
  const repo = context.repo;
  const { data: me } = await botApi.rest.users.getAuthenticated();
  const bot = me.login;
  const { data: meta } = await github.rest.repos.get(repo);
  const base = meta.default_branch;

  const prs = prNumber
    ? [(await github.rest.pulls.get({ ...repo, pull_number: Number(prNumber) })).data]
    : await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base, per_page: 100 });

  for (let pr of prs) {
    if (pr.state !== 'open' || pr.base.ref !== base) continue;
    const sha = pr.head.sha;
    const start = Date.now();
    let requested = false;

    // A push-triggered run keeps going until it approves, Copilot gives a non-approval, or the
    // deadline passes. A dismissal does not end it: Copilot's review of the new commit may follow.
    for (;;) {
      const { result, reviews } = await evaluate(github, repo, pr, base, bot);
      if (isPush) await commentOnPush({ github, repo, pr, reviews, bot });
      core.info(`#${pr.number} ${short(sha)} -> ${result.action}: ${result.reason}`);

      if (result.action === 'approve') {
        await botApi.rest.pulls.createReview({
          ...repo,
          pull_number: pr.number,
          commit_id: sha,
          event: 'APPROVE',
          body: approvalBody({ bot, sha, copilot: result.copilot, files: result.files, prUrl: pr.html_url }),
        });
        break;
      }
      if (result.action === 'dismiss') {
        for (const r of result.dismiss) {
          try {
            await botApi.rest.pulls.dismissReview({
              ...repo,
              pull_number: pr.number,
              review_id: r.id,
              message: `Approval removed: ${result.reason}. I will approve again once Copilot approves the head commit.`,
            });
          } catch (e) {
            // A push may have dismissed it a moment earlier.
            if (e.status !== 422) throw e;
            core.info(`review ${r.id} was already dismissed`);
          }
        }
        if (!/has not reviewed|was dismissed/.test(result.reason)) break; // Copilot said no, or out of scope
      }
      if (result.action === 'none') break;
      if (!wait || Date.now() - start >= waitMs) break;

      // Copilot does not always review a push on its own (seen for a merge from the base branch).
      if (!requested && Date.now() - start >= REQUEST_AFTER_MS) {
        requested = true;
        core.info(`#${pr.number}: no Copilot review yet; requesting one`);
        try {
          await github.rest.pulls.requestReviewers({ ...repo, pull_number: pr.number, reviewers: [COPILOT] });
        } catch (e) {
          core.warning(`could not request a Copilot review: ${e.message}`);
        }
      }

      await sleep(pollMs);
      const { data: fresh } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
      if (fresh.state !== 'open' || fresh.head.sha !== sha || fresh.base.ref !== base) {
        core.info(`#${pr.number}: head moved, base changed or PR closed; stopping`);
        break;
      }
      pr = fresh;
    }
  }
};

module.exports = { run, decide, approvalBody, parseOwners, ownersOf, botMayApprove, toRegex, COPILOT };
