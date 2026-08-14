# Profile language statistics

The profile banner aggregates GitHub Linguist byte counts across every repository owned by `skorudzhiev` that the active GitHub token can read. It includes public and private repositories, but publishes only totals: repository names and per-repository data never enter the generated files.

## Generate locally

Authenticate the GitHub CLI with access to the repositories, then run:

```sh
node scripts/generate-language-stats.mjs
node --test tests/language-stats.test.mjs
```

The generator writes `assets/language-stats.svg` and `assets/language-stats.json`.

## Enable weekly refreshes

Add a repository secret named `PROFILE_STATS_TOKEN` to this profile repository. The token must be able to read repository metadata and language statistics for every private repository that should contribute to the aggregate. Give it no write permissions; the workflow uses the profile repository's own `GITHUB_TOKEN` to commit the generated files.

The workflow runs every Monday and can also be started manually from the Actions tab. If the secret is absent, it keeps the verified snapshot and emits a warning instead of silently replacing the complete aggregate with public-only data.

## Methodology

- Scope: repositories where the authenticated user is the owner.
- Measurement: GitHub Linguist bytes from each repository's default branch.
- Presentation: the eight largest languages plus an aggregate remainder in the bar.
- Caveat: byte share is not lines of code, time spent, proficiency, or contribution share.
