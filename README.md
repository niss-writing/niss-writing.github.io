# Temporary for now — GitHub Pages prototype

This version publishes the neutral **Temporary for now** form at **https://niss-writing.github.io/** from **niss-writing/niss-writing.github.io**. The interface has the same contact fields, dropdowns, two PDF selectors, and Submit button. All live data goes to a separate **private repository for each tester**, through a pull request.

The public page uses **GitHub Pages**, and the private validation/merge job uses **GitHub Actions**. There is no separately hosted API, hosting account, or server secret to configure.

## Publish in one line

Download the revised archive, open a terminal in its download directory, and run:

```bash
unzip -q temporary-for-now-github-pages.zip && node temporary-for-now-github-pages/scripts/publish.mjs niss-writing/niss-writing.github.io
```

You need **Node.js 22.14 or newer**, **Git**, and the **GitHub CLI (`gh`)**. Node 24 is recommended. The helper uses your local GitHub login; if you are not signed in, it starts `gh auth login`. Your account must be able to push workflows and manage Pages on the destination repository. A CLI OAuth login needs the `repo` and `workflow` scopes. If GitHub reports an existing OAuth credential without `workflow`, the helper starts `gh auth refresh` to add it. Fine-grained credentials do not report this OAuth scope header, so the helper does not trigger an unnecessary refresh for them.

The helper clones the existing destination into a fresh temporary checkout, copies only the release's listed source files, creates a normal commit on its current default branch, pushes, enables Pages with GitHub Actions as its source, and requests the deployment workflow. It preserves repository history and unrelated files and never force-pushes. Existing files at this prototype's paths are replaced. It will not make an inaccessible repository public or create a substitute repository after a 404.

The website source repository must be public: each private validation workflow fetches its trusted validator from an exact commit of this repository. The submissions themselves remain private. This is a code-only website repository; never put tester files or access codes into it.

The helper prints a deployment link. Wait for **Publish GitHub Pages** to complete successfully before using the URL. Uploading the archive here does not publish the website. If organization policy requires a PR, limits Actions, or prevents changing Pages settings, the helper reports the specific remaining step and leaves the prepared checkout available.

To inspect the upload without making any network request or change:

```bash
node scripts/publish.mjs niss-writing/niss-writing.github.io --dry-run
```

## What works immediately

The public page initially opens in **sample mode**. You can fill in the fields, select PDFs, submit, edit the result, and download the package. Sample submissions stay in the current browser page and disappear when it is refreshed. They are never uploaded to GitHub.

Use the fictional `examples/example-cv.pdf` and `examples/example-sample.pdf`. Accepted PDFs remain separate and unchanged:

| File | Contents |
| --- | --- |
| `cv.pdf` | The CV PDF. |
| `sample.pdf` | The sample PDF. |
| `submission.md` | Every form answer, document details, dates, and structured metadata. |

Both PDFs are required for the first submission. Updates can retain either existing PDF. The pilot limit is **2 MiB and 100 pages per PDF**. Files must be actual unencrypted PDFs; active content and attachments are rejected. Word-to-PDF conversion is not included.

## Enable real submissions for a tester

GitHub Pages serves static files. It cannot hold an organization token or authenticate anonymous uploads to private repositories. This GitHub-only pilot therefore gives each tester a **separate repository and a separate, narrowly scoped access code**. Testers do not need a GitHub account. An organizer prepares their access once; afterwards they use the ordinary form.

### 1. Create their private repository

From the extracted project folder, using an organization owner's GitHub CLI login:

```bash
node scripts/provision.mjs niss-writing
```

The helper creates a randomly named repository such as `temporary-entry-<UUID>`, seeds its identity file and validation workflow, and prints the next steps. It reads the latest default-branch source commit from `niss-writing/niss-writing.github.io` and pins executable validation code to that exact SHA. It does not check whether that commit's Pages deployment succeeded. No personal details are used in the repository name. Do this only after publishing the website source and checking its successful deployment.

The organizer's CLI credential is used locally for provisioning. It must be able to create private repositories, write their initial workflow, and configure their Actions settings. Do not give that credential to a tester or paste it into the website.

### 2. Make a token for only that repository

Use the token-creation link printed by the helper. In GitHub's fine-grained token screen:

- Resource owner: **niss-writing**.
- Repository access: **Only select repositories**; select **only the new tester repository**.
- Contents: **Read and write**.
- Pull requests: **Read and write**.
- Metadata: **Read** (included automatically).
- Expiration: a short testing period, such as 30 days.
- Leave **Workflows**, **Administration**, and other permissions unselected.

An organization owner creates this token and privately delegates this one repository's access through the code. It is not an outside collaborator's token. GitHub currently does not support fine-grained tokens for outside collaborators on organization repositories. Do not substitute a broad classic `repo` token.

The application verifies the token can access the intended private repository, but GitHub does not expose a full self-inspection endpoint for the token's selected repositories and permissions. The organizer must select this scope correctly. Never use **All repositories** for a tester token.

GitHub limits each account to **50 fine-grained personal access tokens**, including tokens used for other work. This manual, one-token-per-tester arrangement is intended for a small pilot; a larger rollout needs a different credential-issuance design. Organization approval and token-expiration policies still apply. [GitHub token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

### 3. Package the private access code

Run the command printed by the provisioner, with that tester's actual repository name:

```bash
node scripts/access-code.mjs niss-writing/temporary-entry-UUID
```

Paste the new fine-grained token at its hidden terminal prompt. The helper checks the private repository and identity, then writes an access code to `.private/<UUID>.private.txt` with restrictive file permissions. That folder is ignored by Git and excluded from the uploader and release archive. The token is not placed in command arguments or printed in the terminal.

Give the tester the public page URL and the contents of this code file privately. They choose **Enter access code**, paste it, and submit through the form. Reentering the same code lets them update the same repository; they do not need to upload unchanged PDFs again. The code works until its underlying token expires or is revoked.

The browser keeps the credential only in memory, sends it only to GitHub's API, and removes an optional access-code URL fragment before other requests. It never writes the credential to localStorage, sessionStorage, downloadable submission packages, or source code. Reloading the page requires reconnecting. Keep a private copy of the code; it grants access to that tester's information and files.

For renewal, create another token scoped to the same repository, remove or securely archive the old local code file, rerun the access-code helper, and share the replacement privately. Revoke the old token in GitHub. The helper refuses to overwrite an existing code file silently.

## What Submit does in live mode

1. Validate the form and both PDFs in the browser.
2. Verify the credential's target is the exact prepared private repository.
3. Write `cv.pdf`, `sample.pdf`, and `submission.md` in a single commit on the `submission` branch, then create or update its PR against `main`.
4. Return a received/pending receipt. The private repository's GitHub Action then independently checks the complete change set, actual PDF contents, metadata, repository identity, branch, and file modes.
5. If eligible, merge the exact inspected commit. Extra paths, executable files, workflow changes, invalid metadata, and invalid PDFs are rejected by the automatic merge gate.
6. Subsequent updates reuse the same repository. A pending PR can receive a new revision; after merging, the next revision creates a new PR. A stale browser revision is rejected rather than silently replacing someone else's update.

Use the receipt's status check to refresh whether the PR has merged. The organizer can inspect private PRs and Actions directly. Organization rules or required reviews may keep a valid submission pending; the workflow does not bypass them or approve its own PR as if it were an independent reviewer.

All validation code and its lockfile come from the pinned public source commit. The job never checks out or executes participant-controlled scripts, dependencies, or PR code. Its `GITHUB_TOKEN` only has access to that one private data repository. No organization-wide secret is stored in a participant repository or workflow.

## Branch protection and pilot limits

The provisioner attempts to require pull requests on `main`, including for administrators, with no forced pushes or deletions. GitHub's private-repository branch protection requires a supporting plan, such as GitHub Team for an organization. If the plan or policy does not allow that setting, the helper reports it and still prepares the trusted-user pilot.

Without that protection, the repository-scoped credential can edit its own repository directly through GitHub's API, outside this form. The automatic merge gate still rejects non-submission PR changes, and its executable validator stays pinned outside the participant repository, but it cannot turn an unprotected Git repository into a form-only database. Use branch protection when enforcing PR-only updates matters.

Git history retains earlier revisions. Organization owners and others with repository access can read submissions. No emails are sent, identities are not email-verified, and there is no reviewer dashboard or automatic token renewal. PDF checks are structural validation, not a malware-scanning guarantee. Private Actions use the organization's available Actions allowance and policies.

## Local development

```bash
npm ci
npm run dev
```

Open http://127.0.0.1:8787. It serves the same static page as Pages and begins in sample mode. An entered live access code enables actual GitHub operations even on the local page.

```bash
npm test
npm run check
npm run build
```

`npm run build` produces `dist/`. The Pages workflow installs the locked dependencies, runs tests and checks, builds, and publishes **only** `dist/`. It never publishes the project root, private files, or workflow templates as website assets.

| Change | Location |
| --- | --- |
| Visible text and form | `public/index.html` |
| Visual design | `public/styles.css` |
| Form behavior and browser sample mode | `public/app.js` |
| Expected owner and file limit | `public/config.json` |
| GitHub API, PRs, retry/concurrency checks | `src/pages-github.js` |
| Shared form, PDF, and Markdown validation | `src/validation.js` |
| Independent private PR validation/merge | `scripts/validate-and-merge.mjs` |
| Website deployment | `.github/workflows/pages.yml` |
| Per-tester setup | `scripts/provision.mjs`, `scripts/access-code.mjs` |

This revision replaces the earlier server-based prototype; existing server return links and repositories need migration rather than direct reuse. The old metadata field `editKeyHash` remains for file-format compatibility and contains SHA256(submission ID). It is not a password or an authentication check in this version; the individual GitHub credential supplies authorization.

See [architecture](docs/ARCHITECTURE.md), [testing](docs/TESTING.md), and [verification](docs/VERIFICATION.md). Existing private workflows stay pinned when the public website is updated; update their pinned SHA with an organizer credential when deliberately upgrading validation, and keep existing saved records compatible.

### Platform references

Verified against GitHub's current primary documentation:

- [GitHub Pages is static hosting; organization sites use OWNER/OWNER.github.io](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
- [Custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
- [Personal access token scopes, organization policy, and outside-collaborator limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
- [Cross-origin GitHub API calls](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests).
- [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- [Secure use of pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).
