# seo-driver

`seo-driver run` opens one SEO guide PR for each of your sites that is due.

For each due site it:

1. pulls Search Console gaps (queries from your target country with 100+ impressions and a click rate of 1% or less over the last 28 days) and Keyword Planner ideas through [gum](https://github.com/ehmo/gum);
2. drops topics the site already covers (its live sitemap, the pages in its repo, and past guide PRs);
3. clones the site repo and has headless Claude Code pick one keyword, research it, write the guide with your `writing` skill, and link it in;
4. has a second Claude run check every claim against its source, check for slop, and check for overlap, with up to two fix rounds;
5. checks the site builds and the guide has a Sources section;
6. opens a PR labeled `seo-guide` that explains the keyword choice.

It never merges, never deploys, never writes to Google, and never schedules itself.

A site is due when its newest `seo-guide` PR is at least `intervalDays` calendar days old (UTC). A site with an open `seo-guide` PR is skipped until you merge or close it. A site whose last run failed also waits `intervalDays`, so a broken site doesn't repeat its Claude runs every day.

## Install

On the machine that runs it (macOS or Ubuntu, amd64 or arm64):

- Node 22 or later.
- [gum](https://github.com/ehmo/gum/releases) v2.3.1 or later: `curl -fsSL https://raw.githubusercontent.com/ehmo/gum/main/install.sh | bash`.
- [`gh`](https://cli.github.com/), logged in with push access to every site repo: `gh auth login`, then `gh auth setup-git` so `git push` uses the same login. On a headless box this step is easy to miss, and the push fails only after every Claude run.
- `git`, with `user.name` and `user.email` set.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), logged in, recent enough to have `--restricted` (2.1.319 has it).
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

3. Get Keyword Planner access for the Cloud project. **The tool opens no PRs until Keyword Planner works**, so start here. Since September 9, 2026, Google ties Ads API access to the Cloud project, not to a developer token:

   - Enabling the Google Ads API gives the project **Test** access, which only reaches test accounts.
   - In the Cloud Console, open the Google Ads API **Overview** page and apply for access there. Applications made from a manager account's API Center are not processed any more.
   - **Explorer** access is the first level, but it does not cover Keyword Planner (`KeywordPlanIdeaService`).
   - **Basic** access covers it. It needs brand verification of the Cloud project first.

   Google now ignores developer tokens, but gum 2.3.1 still refuses to call Google Ads without one, so give it any value, such as the token you already have:

   ```bash
   printf '%s' "$GOOGLE_ADS_DEVELOPER_TOKEN" | gum auth use-ads-developer-token --stdin
   gum config set googleads.customer_id=<10-digit Ads account id>
   # only when you reach the account through a manager account:
   gum config set googleads.login_customer_id=<10-digit manager id>
   ```

   Check it with `gum read googleads.keywordPlanIdeas.generateKeywordHistoricalMetrics --args '{"keywords":["ableton"]}'`. A `PERMISSION_DENIED` here usually means the project doesn't have Basic access yet.

### Headless Ubuntu

gum keeps OAuth logins and the developer token in the OS keyring. Search Console and Google Ads only work with your own OAuth login, so a service account is no way around this. Under cron the keyring is usually locked or missing, and gum fails with `AUTH_KEYCHAIN_UNAVAILABLE`.

The fix is to start an unlocked keyring for each run. Install `gnome-keyring` and `libsecret-1-0`, keep the keyring password in a file only you can read (`chmod 600 ~/.config/seo-driver/keyring-pass`), and do both the `gum login` steps and the runs inside that session:

```bash
dbus-run-session -- sh -c 'gnome-keyring-daemon --unlock --components=secrets < ~/.config/seo-driver/keyring-pass >/dev/null; node dist/cli.js run'
```

I couldn't test this on Ubuntu here, so try the dry run below this way before you schedule it. Set the developer token placeholder with `GUM_GOOGLE_ADS_DEVELOPER_TOKEN=<any value>` on the same line if you'd rather keep it out of the keyring.

## Configure

```bash
cp seo-driver.config.example.json seo-driver.config.json
```

Each site entry:

| Field | Required | Meaning |
| --- | --- | --- |
| `domain` | yes | `mixingpal.com` |
| `repo` | yes | GitHub `owner/name` |
| `buildCommands` | yes | Commands that build the site, one per entry, e.g. `["npm ci", "npm run build"]`. They run without a shell, so `&&`, pipes, quotes, `*` and `VAR=value` are rejected. The script runs them after each Claude edit; Claude never runs them. |
| `exampleGuide` or `instructionsFile` | one of them | Repo path of an existing guide for Claude to copy, or of a file explaining how to add one. A site with neither is skipped. |
| `searchConsoleProperty` | no | `sc-domain:mixingpal.com` for a domain property, `https://mixingpal.com/` for a URL-prefix property. |
| `seedKeywords` | no | Up to 20 Keyword Planner seeds. The site URL is always a seed. |
| `baseBranch` | no | Default `main`. |
| `intervalDays` | no | Whole days, default `2`. |

Settings for all sites:

| Field | Default | Meaning |
| --- | --- | --- |
| `keywordPlanner.geoTargetConstants` | `["2840"]` (US) | Keyword Planner locations. |
| `keywordPlanner.language` | `"1000"` (English) | Keyword Planner language. |
| `searchConsole.country` | `"usa"` | Search Console queries from this country only, as a lowercase 3-letter code. Match it to `geoTargetConstants`. `"all"` turns the filter off. |
| `claudeMaxBudgetUsd` | `10` | Spend cap for each Claude run (writer, reviewer, fixer). A run that hits it fails its site. |
| `workDir` | `~/.cache/seo-driver` | Holds the clones, the run lock, and `failures.json`. A relative path is taken from the config file's folder. |

## Run

Try one site without pushing anything:

```bash
node dist/cli.js run --site mixingpal.com --dry-run
```

The dry run stops before the push and prints where the clone is, so you can read the guide. Then run for real:

```bash
node dist/cli.js run
```

The command prints timestamped lines: progress, each Claude session's id and cost (resume one with `claude -r <id>` to see what it did), then one line per site: `opened <url>`, `skipped (<reason>)`, `dry-run`, or `failed (<reason>)`. The exit code is `1` when any site failed, Keyword Planner failed, or another run was still going, otherwise `0`.

- A failed site keeps its clone so you can look at it, until that site's next run replaces it.
- A site that fails after cloning waits `intervalDays` before its next try, since a retry would repeat the Claude runs. To retry sooner, delete its line from `workDir/failures.json`. A failed dry run records nothing. A failure before cloning (GitHub, Search Console, Keyword Planner) costs nothing and is retried on the next run.
- A Search Console failure fails only its site. A Keyword Planner failure stops the whole run, since it is almost always a credential problem.
- Only one run works at a time. A second run exits at once while the first holds `workDir/seo-driver.lock`. The run refreshes the lock before each site. A lock left by a crash is taken over once its process is gone, or 12 hours after its last refresh. If a run says another run is taking over the stale lock and none is, delete the `seo-driver.lock*` files in `workDir`.
- Every command has a time limit: 45 minutes for each Claude run, 15 for each build command, 10 for the rest.

Scheduling is yours. For example, a daily cron entry:

```cron
0 7 * * * cd /path/to/seo-driver && node dist/cli.js run >> run.log 2>&1
```

## What Claude can do

The script makes every gum, `git`, `gh`, and build call itself. Search text and the pages Claude reads can carry instructions planted by anyone, so Claude runs headless with:

- `--restricted`: no settings files (yours or the site repo's), no MCP servers, no shell or other command tools, and file tools confined to the clone and the `writing` skill folder;
- these tools only: read, edit, and search files, plus web search and fetch. The reviewer cannot edit;
- `--permission-mode manual`, the `claudeMaxBudgetUsd` spend cap, and hooks turned off.

Edits under `.git/` are denied. After each Claude session, and before each build, the script checks the changed files. A site fails, with no push, when Claude or the build changes anything under `.github/`, a `package.json`, a lockfile, or `.npmrc`, or when the guide overwrites an existing page. The script's own git calls run with no hooks.

**What this does not stop.**

- Claude has to edit the site's code (for Mixing Pal, `vite.config.ts`), and the build runs that code as you, with your GitHub login on the machine. A web page Claude reads could try to trick it into planting code that runs during the build. To close this, run seo-driver as a separate user or in a container that holds only a GitHub token scoped to the site repos.
- The pushed branch runs in CI before you review it. Workflows triggered by pull requests, and preview deploys (Vercel, Netlify), build the same Claude-edited code with their own secrets. If you turn those on, require approval before they run on PRs from this tool, or keep secrets out of PR builds.

## Develop

```bash
npm test
npm run typecheck
```
