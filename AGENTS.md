# Working on this prototype

Read README.md and docs/ARCHITECTURE.md before making changes.

- The public title is `Temporary for now`. Keep visible text neutral; no organization, course, or event branding. Configuration and administrator documentation may name the deployment repository.
- Host the form on the organization's GitHub Pages site. Do not add a hosted API or another hosting provider without a user request.
- Browser demo mode never writes to GitHub. Live mode requires a credential limited to exactly one preprovisioned private submission repository.
- Never embed an organization token, CLI credential, access code, or personal submission in public assets, source control, logs, or downloadable example packages.
- Keep browser credentials in memory only. Consume and remove an optional access fragment immediately, before other requests. Never use query parameters for credentials.
- Use one private repository per tester. The only submission paths are `cv.pdf`, `sample.pdf`, and `submission.md`.
- Private validation workflows execute code from an immutable commit of the public website repository. Never execute code, workflows, dependencies, or scripts from a submission PR or the participant-writable repository tree.
- Keep private-repository checks, allowlisted full-tree comparisons, PDF validation, SHA-bound merging, non-forced branch updates, and retry checks.
- The participant credential must not have Workflows or Administration permissions. On a plan without private branch protection, disclose that the credential can directly edit its own repository outside the form.
- Preserve the existing form/metadata schema or document a migration. The old editKeyHash field is now SHA256(submission id) for format compatibility; GitHub authorization controls access.
- Run relevant existing tests and build/check commands. Mock tests do not establish that live GitHub credentials or policies work.
- Automatic merging is a validation step, not an independent human approval. Never bypass repository protections.
