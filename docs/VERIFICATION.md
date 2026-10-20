# Verification record — GitHub Pages revision

Prepared October 19, 2026, with Node.js 24.19.0. This record applies to version 0.2.0, the GitHub Pages/GitHub Actions implementation.

## Completed checks

- Clean locked dependency installation with `npm ci --ignore-scripts` succeeded. The lockfile has the Pages build dependencies and no previous hosting runtime.
- The full suite passed **71 checks**: 44 form/PDF/Markdown checks (including nested cases), 10 browser-to-GitHub transport checks, 9 independent Actions/provisioning checks, and 8 CLI checks. All GitHub calls in these tests use deterministic fakes.
- `npm run check` passed syntax, neutral visible branding, browser-storage, configuration, bundle reference, and Pages deployment-layout checks.
- `npm run build` succeeded and produced the deployable static site in `dist/`. The minified JavaScript bundle is approximately **480 KiB** before transfer compression. Only `dist/` is uploaded by the Pages workflow.
- Static interface inspection found **120 unique IDs**, correct labels and ARIA references, resolvable literal JavaScript element references, and exactly two PDF inputs.
- The in-browser sample generator was exercised as JavaScript: it produced two valid, one-page PDFs. Their metadata round trip and three-file ZIP preserve the accepted PDF bytes.
- The actual uploader passed its `--dry-run`, verifying the complete source release without making any GitHub request. CLI tests cover access-code format, bad scopes/types, release path restrictions, symlinks, and dry-run behavior.
- The source release is packaged with an explicit upload file list. Private access-code files, dependencies, transient build folders, real submission data, and credentials are excluded.

The core tests exercise first submission, pending-PR edits, updates after merging, exact retry recovery, stale browser versions, non-forced concurrency handling, private-repository identity checks, PDF active-content checks, infrastructure-path rejection, symlink rejection, exact-head merging, and repository-rule/merge-readiness handling.

## Verification boundaries

No real GitHub repository or Pages settings were changed from this environment. No access token was generated, and no personal document was uploaded. The organization repository was not accessible through the available connection, so the supplied upload command deliberately uses the organizer's own authenticated GitHub CLI.

Browser rendering/interaction was not run in a supported browser environment. DOM checks and JavaScript fixtures are not browser end-to-end tests. A successful build is not evidence that an organization's Actions policy, fine-grained-token approval, private branch protection, or live API credentials are configured correctly.

After publishing, follow `docs/TESTING.md` with the fictional example PDFs. Verify one real private PR and its Action merge before inviting more testers. The page initially uses a clearly marked browser sample mode; actual private submissions require the separate per-tester repository and scoped access code.
