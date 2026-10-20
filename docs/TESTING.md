# Testing the GitHub Pages pilot

## Before live testing

1. Run `npm test`, `npm run check`, and `npm run build`.
2. Publish the code with the one-line README command. Wait for the Pages workflow to succeed.
3. Open the Pages URL and confirm the title is Temporary for now and the page identifies sample mode.
4. Fill every field, select the two fictional example PDFs, submit, inspect/download the three-file package, edit information, and replace just one PDF. Confirm refresh clears the sample.
5. Use the organizer CLI to provision a private repository. Make a fine-grained token scoped only to it; Contents and Pull requests write, no Workflows or Administration.
6. Create its private access code and connect through Enter access code. Confirm a bad code, expired token, wrong organization, or public/unprepared repository fails without a write.

## Real submission/update path

1. Submit fictional details plus both example PDFs.
2. Confirm the new PR contains only `cv.pdf`, `sample.pdf`, and `submission.md`, in the correct private repository.
3. Confirm the private workflow checks out the public validator at its pinned SHA, validates, and merges. No name, email, document, access code, or token should appear in public issues, logs, or the public repository.
4. Use the page's status check. Reconnect with the same code; inspect all saved fields and both PDFs.
5. Update text and replace one PDF. Confirm a new PR/revision, unchanged bytes for the retained PDF, and a successful merge.
6. Try two tabs at the same loaded revision. After submitting a change in one tab, the other should receive a conflict until reloaded.
7. Interrupt a submission's network response and retry. Confirm the same intended revision is recovered and duplicate records/PRs are not created.
8. A PR with a fourth file, changed workflow, symlink, deleted file, malformed metadata, or invalid PDF must fail the automatic merge check. Do not run untrusted code to test this.
9. Confirm the supplied tester token cannot edit workflow files or any other private repository. If main protection is available, confirm direct pushes are rejected too; otherwise retain the documented trusted-pilot limitation.
10. Revoke the tester token and confirm that code stops working. Generate a new token for the same repository and confirm existing records remain available.

## Data/file checks

- Missing required fields and consent, unknown dropdown values, too-long text, fake PDF extensions, encrypted files, more than 100 pages, and PDFs above 2 MiB should fail.
- The ZIP should contain exactly the two accepted original PDFs and Markdown. It must not contain an access code or token.
- Browser storage should not contain credentials or uploaded PDF bytes. The optional `#access=` fragment is removed immediately.
- A failed independent merge or repository policy should display a received/pending state, not a false claim of merging.

These checks must be performed against the actual GitHub account before inviting a wider group. Automated mocked-API tests cannot verify organization plan features, Actions policies, real browser CORS, or installed token permissions.
