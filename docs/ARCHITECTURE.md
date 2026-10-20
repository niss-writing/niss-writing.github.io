# GitHub Pages architecture

## Deployment boundary

GitHub Pages publishes `dist/`, a bundle of HTML, CSS, JavaScript, and public configuration. The page talks directly to `https://api.github.com` using a tester-specific fine-grained token. No same-origin `/api` endpoint exists or is expected. The GitHub REST API supports cross-origin browser calls.

Each tester's private repository contains an identity manifest, a seeded validation workflow, and the submission files. An organizer provisions it using their own local GitHub CLI. They create a separate fine-grained token limited to that repository with Contents and Pull requests write permissions; it must not have Workflows or Administration permissions. The browser cannot audit every actual permission granted to a token, so correct token creation is an organizer requirement.

## Credentials and privacy

The access code is base64url-encoded JSON: `{v:1, owner, repo, id, token}`. Encoding does not encrypt it. The browser validates its structure and configured destination, consumes/removes an optional fragment immediately, and holds the resulting credential in memory only. Only GitHub API requests receive its Authorization header; redirects are refused.

The code authorizes one repository and survives page reloads only if the tester keeps a private external copy. There are no invitation-code server checks or secret HMAC key. Existing `editKeyHash` metadata is SHA256(id) only for schema compatibility. Access is enforced by GitHub, not by that public hash.

Demo mode stores data solely in the current browser context. It never makes submission writes to GitHub. The page clearly distinguishes sample mode from a connected live repository.

## File and revision model

The exact three submission files are `cv.pdf`, `sample.pdf`, and `submission.md`. The shared validator checks strict form fields, known dropdown options, strings and lengths, consent, PDF structure and active objects, page count, and canonical metadata. Accepted PDF bytes are preserved.

The persistent `submission` branch provides a shared update point. Non-forced reference updates avoid overwriting a concurrent branch head. Request IDs identify retries; a reused ID with different bytes/data is rejected. The browser loads pending revisions as well as merged records. A pending PR can be updated and a new PR is created after an earlier revision merges.

## Independent automatic merge gate

The private `pull_request_target` workflow is seeded by the organizer, and the tester token must lack permission to edit workflow files. The workflow checks out only the public website source repository at an immutable commit and installs only its locked dependencies. It never executes files from the private repository or the PR.

Pinned workflow values bind the expected private repository ID, owner, name, and submission UUID. Validation checks those identities, privacy, the fixed branch and base, complete base/head trees, the three-file change allowlist, regular-file modes, PDF bytes, canonical metadata, and matching IDs. It rechecks the current PR/repository and passes the exact inspected head SHA to GitHub's merge endpoint. Changed code, unexpected paths, malicious PDFs, and a moving head do not receive a merge from this job.

The Actions credential is scoped to the private repository. No organizer token is saved in Actions secrets. GitHub branch policies remain authoritative; the job leaves blocked PRs pending.

## Enforced boundaries and pilot assumptions

The public website/validator repository is outside the tester token's scope. The automatic merge job executes immutable trusted code, even when private repository contents are edited. On plans supporting private branch protection, the provisioner also requests PR-only main updates with administrator enforcement. If unavailable, a tester credential can directly edit its own private repository, bypassing the form and PR gate. This is reported as a trusted-user pilot limitation, not a hidden security guarantee.

Private Actions consume the organization's Actions allowance. Expired tokens, organization policies, workflow restrictions, unavailable branch protection, and disabled Actions can affect live operation; a fictional live submission is needed after setup to verify the actual account configuration.
