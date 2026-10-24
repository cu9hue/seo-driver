# seo-driver

`seo-driver run` opens one SEO guide PR for each of your sites that is due.

For each due site it:

1. pulls Search Console gaps (queries with 100+ impressions and a click rate of 1% or less over the last 28 days) and Keyword Planner ideas through [gum](https://github.com/ehmo/gum);
2. drops topics the site already covers (its live `sitemap.xml` and past guide PRs);
3. clones the site repo and has headless Claude Code pick one keyword, research it, write the guide with your `writing` skill, and link it in;
4. has a second Claude run check every claim against its source, check for slop, and check for overlap, with up to two fix rounds;
5. checks the site builds and the guide has a Sources section;
6. opens a PR labeled `seo-guide` that explains the keyword choice.

It never merges, never deploys, never writes to Google, and never schedules itself.

A site is due when its newest `seo-guide` PR is at least `intervalDays` calendar days old (UTC). A site with an open `seo-guide` PR is skipped until you merge or close it.

## Install

On the machine that runs it (macOS or Ubuntu, amd64 or arm64):

- Node 22 or later.
- [gum](https://github.com/ehmo/gum/releases) v2.3.1 or later: `curl -fsSL https://raw.githubusercontent.com/ehmo/gum/main/install.sh | bash`.
- [`gh`](https://cli.github.com/), logged in with push access to every site repo: `gh auth login`, then `gh auth setup-git` so `git push` uses the same login. On a headless box this step is easy to miss, and the push fails only after every Claude run.
- `git`, with `user.name` and `user.email` set.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), logged in.
- Your `writing` skill at `~/.claude/skills/writing`.

Then, in this folder:

```bash
npm ci
npm run build
```

## Google setup

1. Create a Google Cloud project. Enable the **Search Console API** and the **Google Ads API**.
2. Create an OAuth client of type **Desktop app**, and give it to gum:

   ```bash
   printf '%s' "$GOOGLE_OAUTH_CLIENT_SECRET" | gum auth use-oauth-client --client-id "$GOOGLE_OAUTH_CLIENT_ID" --secret-stdin
   gum login --service searchconsole
   gum login --service googleads
   ```

3. Apply for a Google Ads **developer token** from a manager account (Google Ads, Admin, API Center). Approval can take days. **The tool opens no PRs until Keyword Planner works**, so apply first. Then:

   ```bash
   printf '%s' "$GOOGLE_ADS_DEVELOPER_TOKEN" | gum auth use-ads-developer-token --stdin
   gum config set googleads.customer_id=<10-digit Ads account id>
   # only when you reach the account through a manager account:
   gum config set googleads.login_customer_id=<10-digit manager id>
   ```

   Check it with `gum read googleads.keywordPlanIdeas.generateKeywordHistoricalMetrics --args '{"keywords":["ableton"]}'`.

### Headless Ubuntu

gum keeps logins in the OS keyring. On a headless box the keyring is often locked, and gum fails with `AUTH_KEYCHAIN_UNAVAILABLE`. Either unlock the login keyring on that box, or use a service account:

```bash
gum auth use-service-account /path/to/key.json
```

Add the service account's email as a user on each Search Console property. Check Google's current rules for giving a service account access to Google Ads.

## Configure

```bash
cp seo-driver.config.example.json seo-driver.config.json
```

Each site entry:

| Field | Required | Meaning |
| --- | --- | --- |
| `domain` | yes | `mixingpal.com` |
| `repo` | yes | GitHub `owner/name` |
| `buildCommands` | yes | Commands that build the site, run without a shell, e.g. `["npm ci", "npm run build"]`. These are the only commands Claude is allowed to run. |
| `exampleGuide` or `instructionsFile` | one of them | Repo path of an existing guide for Claude to copy, or of a file explaining how to add one. A site with neither is skipped. |
| `searchConsoleProperty` | no | `sc-domain:mixingpal.com` for a domain property, `https://mixingpal.com/` for a URL-prefix property. |
| `seedKeywords` | no | Up to 20 Keyword Planner seeds. The site URL is always a seed. |
| `baseBranch` | no | Default `main`. |
| `intervalDays` | no | Default `2`. |

`keywordPlanner.geoTargetConstants` and `keywordPlanner.language` default to the US (`2840`) and English (`1000`). `workDir` (default `~/.cache/seo-driver`) holds the clones. A relative `workDir` is taken from the config file's folder.

## Run

Try one site without pushing anything:

```bash
node dist/cli.js run --site mixingpal.com --dry-run
```

The dry run stops before the push and prints where the clone is, so you can read the guide. Then run for real:

```bash
node dist/cli.js run
```

The command prints one line per site: `opened <url>`, `skipped (<reason>)`, `dry-run`, or `failed (<reason>)`. A failed site keeps its clone so you can look at it. The exit code is `1` when any site failed or the Google data could not be fetched, otherwise `0`.

Scheduling is yours. For example, a daily cron entry:

```cron
0 7 * * * cd /path/to/seo-driver && node dist/cli.js run >> run.log 2>&1
```

## What Claude can do

The script makes every gum, `git push`, and `gh` call itself. Claude runs headless with:

- `--permission-mode default`, which overrides a `defaultMode` in your settings;
- only your user settings, so `.claude/` settings inside a site repo are ignored;
- your hooks turned off, so a hook can't rewrite or approve its commands;
- this allowlist: read and edit files inside the clone, read the `writing` skill, search and fetch the web, and run the site's `buildCommands`.

`git`, `gh`, `gum`, and edits under `.git/` are denied outright. The reviewer can only read and research. A site fails, with no push, when Claude changes anything under `.github/`, a `package.json`, a lockfile, or `.npmrc`. The script's own commit and push skip git hooks.

**What this does not stop.** Claude has to edit the site's code (for Mixing Pal, `vite.config.ts`), and the build commands run that code as you, with your GitHub login on the machine. A web page Claude reads could try to trick it into planting code that runs during the build. The guards above close the obvious paths, not this one. To close it, run seo-driver as a separate user or in a container that holds only a GitHub token scoped to the site repos.

## Develop

```bash
npm test
npm run typecheck
```
