# snapgit web

A static site (no build step, no server of ours) for reviewing snapgit PRs in a browser. It talks straight to the GitHub
API, using the same refs the CLI uses (`refs/snapgit/pr|receipt|reject/<id>`), so a PR sent from the CLI can be opened and
rejected here, and the sender's `snapgit sweep` honors it.

## Host it yourself

**GitHub Pages (no Vercel needed):** fork the repository, Settings, Pages, Source: *GitHub Actions*, then Actions, *Deploy web to GitHub Pages*, Run workflow (`.github/workflows/pages.yml` publishes `web/`). The pages carry their own content security policy in a meta tag, so they stay locked down on hosts that cannot send headers.

**Tokens:** see [setup.html](setup.html) for creating a fine-grained token (Contents: Read and write to open or reject; read-only Contents and Pull requests for the dashboard).

## Sign in with GitHub

`api/auth/{status,login,callback}.js` (shared code in `api/_auth.js`) implement a GitHub App web flow with no database: `login` sets a random state in an HttpOnly cookie and redirects to GitHub, `callback` checks the state, exchanges the code using `GITHUB_CLIENT_SECRET`, and redirects back with the token in the URL fragment (`#gh_token=`), which `lib/auth.js` moves into the token field and scrubs from the address bar. Return paths are a closed list, so it is not an open redirect. One public App serves every user of the site; see [setup.html](setup.html#signin).

## Deploy on Vercel

1. Push this repo to GitHub (done).
2. Vercel dashboard, **Add New, Project**, import `Tiobold/snapgit`.
3. Set **Root Directory** to `web`. Framework preset **Other**. Leave the build command and output directory empty.
4. Deploy. Every push to `master` redeploys. Add a custom domain under Settings, Domains.

Or from a terminal: `cd web && npx vercel` (preview) then `npx vercel --prod`.

`vercel.json` turns on clean URLs and sends a strict Content-Security-Policy (scripts and styles from the site only, network
only to `api.github.com`), which the browser test also runs under.

## How it works

- **Open** claims `refs/snapgit/receipt/<id>` by creating it. GitHub refuses to create a ref that exists, so only the first
  opener wins, same as the CLI's create-only push. That receipt's timestamp starts the size-proportional fuse.
- **Reject** creates `refs/snapgit/reject/<id>`. Anyone with write access can, opened or not.
- The page only *shows* the changes to whoever holds the receipt, and polls so a rejection from anywhere shows up.
- The merge itself is done by the sender's machine (`snapgit sweep --remote origin` or `snapgit watch`), not by the web page.
  The page can only tell you the fuse ran out.
- Reading needs no token for public repos. Opening and rejecting need a token that can write to the repo (fine-grained,
  Contents: read and write). It lives in the tab's memory and is only sent to `api.github.com`.

Honest limits: the PR's patch sits readable in the repo's ref, so "hidden until opened" is a UI rule, not encryption. Clocks
come from each machine, so a badly skewed clock shifts the fuse.

## Metrics page

`metrics.html` reads `outcomes.json` from the `snapgit-metrics` branch plus recent closed PRs (as the baseline) straight from the GitHub API in the browser; `?demo` shows labelled synthetic data and `?repo=owner/name` (and `?demo` opens the review demo, `/metrics?demo` the dashboard demo) prefills the form.

## Test

Unit tests for the page logic run with `npm test`. The browser test (`npm run test:e2e`, needs Playwright and
Chromium) mocks GitHub and uses a PR made by the real CLI, including a browser rejection honored by the CLI.
