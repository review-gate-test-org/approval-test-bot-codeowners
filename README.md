# approval-test-bot-codeowners

Test repo: can a machine user (`approval-test-bot`) satisfy code-owner review for backend code only?

| Path | Code owners | Bot approval counts? |
|---|---|---|
| `/backend/` | `@review-gate-test-org/backend`, `@approval-test-bot` | Yes |
| `/frontend/` | `@review-gate-test-org/frontend` | No |
| everything else (`.github/`, `README.md`, ...) | `@JacobiCamunda` | No |

The `main` ruleset requires 1 approval, code-owner review, dismisses stale approvals on push, and requires the `backend` and `frontend` checks.

## Try it

1. Add this repo to the bot's fine-grained PAT (Pull requests: read/write, Contents: read).
2. Save it: `gh secret set APPROVER_TOKEN --repo review-gate-test-org/approval-test-bot-codeowners`
3. Open a PR, then run **Actions → Bot approve → Run workflow** with the PR number.

Expected:

- PR that changes only `backend/` → mergeable after the bot approves.
- PR that changes `frontend/` or `README.md` → still blocked after the bot approves.
