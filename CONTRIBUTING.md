# Contributing to Obsidian VaultBridge MCP

Thank you for contributing. Keep each change reviewable, traceable to its tracking issue, and safe for temporary test vaults.

## Branch names

Prefer one logical task per branch:

- `feat/issue-123-short-description`
- `fix/issue-123-short-description`
- `docs/issue-123-short-description`
- `chore/short-description` (for standalone maintenance with no issue)

Open pull requests against `main` unless a maintainer explicitly instructs otherwise. Do not push, merge, tag, or publish releases without project-owner approval.

## Conventional Commits

Format:

```text
<type>(<scope>): <imperative summary>

[optional explanatory body]

Refs #123
```

Use lowercase `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `build`, or `ci`; use a focused scope where useful (for example, `search`, `metadata`, `security`, `release`). Keep the subject concise and specific.

Examples:

```text
fix(search): revalidate cached results after worker failure

Refs #123
```

```text
docs(release): document alpha artifact provenance

Refs #123
```

Put `Refs #123` in commit footers when the work is related to an issue. Prefer to reserve `Closes #123`, `Fixes #123`, and `Resolves #123` for the pull-request description, where reviewers can explicitly verify completion. GitHub can also process closing keywords in merged commit messages, which risks premature closure.

## PR-to-issue policy

Every PR must say what issue it is associated with (or why it needs no issue), what was verified, and what remains outstanding. Use the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md).

- **Partial implementation / one phase of a larger issue:** write `Refs #123` in the PR description. Mention the completed scope, remaining acceptance criteria, and follow-up owner. A plain reference **does not automatically close** the issue.
- **Final issue-resolving PR:** write `Closes #123` (or `Fixes #123` / `Resolves #123`) **only after every acceptance criterion is satisfied**. Merging that PR into the default branch `main` causes GitHub to close the issue automatically.
- **Multiple issues truly completed:** put each closing directive on its own line, with the correct issue number.
- **Cross-repository issue:** specify the full `owner/repo#123` reference with the closing keyword.
- **No tracking issue:** explain why in the PR's Issue relationship section rather than inventing a link.

For a partial PR, optionally link it using GitHub's Development sidebar so it is visible on the issue; ensure the link does not incorrectly mark the issue as resolved. GitHub's automatic closing keywords in PR descriptions are only interpreted for PRs targeting the default branch; merging into another base branch is not an auto-close guarantee. Merely mentioning an issue number is not a request to close it.

**Release issues are end-to-end:** if the issue explicitly requires npm publication, installed-artifact smoke tests, provenance, and post-release evidence, a PR that only prepares code/metadata must use `Refs`, even when CI is green. Only a final PR meeting *all* issue criteria may use `Closes`; otherwise the owner closes the issue manually after confirming the non-code release steps. Do not create a cosmetic PR solely to trigger closure.

In particular, [issue #5](https://github.com/thinhnq3009/obsidian-vaultbridge-mcp/issues/5) is a release workflow: merged code is not proof that a published alpha has been verified.

## Review and merge checklist

1. Explain what changed, why, relevant issue(s), and any known limitations.
2. State exact validation commands/results, supported Node/OS matrix, or why tests were not run.
3. Confirm no real/production Obsidian vault was modified; use temporary disposable vaults for tests.
4. List unresolved security findings, runtime restrictions, and release gates explicitly.
5. Use `Closes` only if the issue is entirely complete and the owner/reviewer agrees to closure.
6. Review the final PR description and squash/merge commit messages for unintended closing directives.
7. After merge, confirm GitHub issue state; update Obsidian task handoff and evidence separately. Do not claim a prerelease is published merely because its source has merged.

Reference: [GitHub Docs — Linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).
