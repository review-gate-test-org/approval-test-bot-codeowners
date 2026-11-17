# approval-test-bot-codeowners

Test repo: can a machine user (`approval-test-bot`) satisfy code-owner review for backend code only?

| Path | Code owners | Bot approval counts? |
|---|---|---|
| `/backend/` | `@review-gate-test-org/backend`, `@approval-test-bot` | Yes |
| `/frontend/` | `@review-gate-test-org/frontend` | No |
| everything else (`.github/`, `README.md`, ...) | `@JacobiCamunda` | No |

The `main` ruleset requires 1 approval, code-owner review, dismisses stale approvals on push, and requires the `backend` and `frontend` checks.

## Automatic bot approval

[`bot-approval.yml`](.github/workflows/bot-approval.yml) with [`reconcile.js`](.github/bot-approval/reconcile.js) keeps the bot's approval in sync with Copilot:

| Situation | Bot action |
|---|---|
| Copilot APPROVED the head commit, bot owns every changed file | Approves, with the commit, a link to Copilot's review and the file list |
| Copilot's review of the head was dismissed, or Copilot's latest review is not APPROVED | Dismisses its approval, with the reason |
| A file outside the bot's scope was added, or the PR became a draft | Dismisses its approval, with the reason |
| New push | GitHub dismisses the approval (stale rule). The bot comments and approves again after Copilot approves the new commit |

Triggers: push (waits up to 15 min for Copilot), a dismissed review (via `review-dismissed.yml` → `workflow_run`), every 15 min, and manual dispatch. No trigger on Copilot's review itself, because GitHub holds those runs for a manual click.

## Try it

1. Add this repo to the bot's fine-grained PAT (Pull requests: read/write, Contents: read).
2. Save it: `gh secret set APPROVER_TOKEN --repo review-gate-test-org/approval-test-bot-codeowners`
3. Open a PR, then run **Actions → Bot approve → Run workflow** with the PR number.

Expected:

- PR that changes only `backend/` → mergeable after the bot approves.
- PR that changes `frontend/` or `README.md` → still blocked after the bot approves.
