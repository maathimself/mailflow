# Contributing to MailFlow

Thank you for your interest in MailFlow. Please read this before opening a pull request — it will save your time and mine.

## How MailFlow is built

MailFlow is a vision-led project. I hold the direction, because a single coherent hand keeps the product consistent and the codebase maintainable, and I write a lot of it. I am no longer trying to write all of it: the project has outgrown what I can review quickly, and a fix waiting a week on me helps nobody. I am open to trusted contributors taking on review and merge rights, earned through a track record of focused, well-judged changes. That shapes what contributions fit:

- **Bug reports and small, focused fixes are very welcome.** A real bug, a translation, a typo, a small correctness or quality fix — these are easy to review and usually merge quickly.
- **For anything larger — a new feature, a refactor, a new dependency, a change to core behaviour — open an issue to discuss it first, before writing any code.** You'll get an honest answer on whether it fits and whether we'd merge it.
- **Unsolicited large pull requests will usually be declined, regardless of quality.** Not because the work isn't good, but because large changes have to fit a direction I'm holding, and reviewing a big PR I didn't plan for is costly whether or not it lands. Please check first so your effort isn't wasted.
- A "no" is about scope and direction, not about you or your code. I appreciate every bit of interest in the project.

If you want to build something bigger, MailFlow's plugin system and its AGPL licence give you room to do that in a plugin or your own fork, without needing it merged here.

## Before You Start

- Search the [issue tracker](https://github.com/maathimself/mailflow/issues) — the problem or feature may already be discussed.
- For anything beyond a small fix, open an issue first to align on the approach (see above).
- All contributions require agreement to the [Contributor License Agreement](CLA.md).

## Workflow

1. Fork the repository and create a branch from `main`.
2. Name your branch descriptively: `fix/describe-the-fix` or `feat/describe-the-feature`.
3. Keep the scope focused — one fix or feature per PR.
4. Open a pull request against `main` and fill out the PR template completely.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
fix: short description of what was fixed
feat: short description of what was added
chore: dependency updates, config changes, etc.
```

- Use the imperative mood ("add support for" not "adds support for")
- Keep the subject line under 72 characters
- No trailing period

## Pull Request Requirements

- CI must pass (backend and frontend checks)
- At least one approving review from a maintainer before merge
- The PR template must be filled out, including the CLA checkbox
- Keep changes minimal and focused — no unrelated cleanup in the same PR
- Large PRs opened without a prior issue may be closed with a pointer back to this document

## Code Style

- Match the style of the surrounding code
- Default to no comments — only add one when the reason behind something would genuinely surprise a future reader
- No half-finished implementations or feature flags for hypothetical future use
- Backend: Node/Express with async/await; avoid adding new dependencies without discussion
- Frontend: React with hooks; styling is inline `style={{...}}` objects plus a few shared classes in `index.css` (Tailwind is configured but is not the prevailing convention); avoid unnecessary abstraction

## Reporting Bugs

Use the [bug report template](https://github.com/maathimself/mailflow/issues/new?template=bug_report.md). Include steps to reproduce, expected behaviour, and actual behaviour. Screenshots or logs help.

## Requesting Features

Use the [feature request template](https://github.com/maathimself/mailflow/issues/new?template=feature_request.md). Explain the problem you are trying to solve, not just the solution. This is also the right place to propose something before writing code.
