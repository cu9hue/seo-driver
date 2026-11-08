# seo-driver

`seo-driver run` opens one SEO guide PR for each of your sites that is due.

For each due site it:

1. pulls Search Console gaps (queries from your target country with 100+ impressions and a click rate of 1% or less over the last 28 days) and Keyword Planner ideas from the Google APIs;
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
2. Set up the OAuth consent screen with user type **External**, then **publish** it (status "In production"). Google expires the logins of apps left in "Testing" after 7 days, so a scheduled run would stop a week after you log in. For your own use you don't need Google's verification: the sign-in page warns that the app is unverified, and you continue past it.
3. Create an OAuth client of type **Desktop app** and download its JSON file.
4. Log in with the Google account that has your Search Console properties and your Google Ads account:

   ```bash
   node dist/cli.js login --client ~/Downloads/client_secret_XXXX.json
   ```

   It prints a sign-in URL. Open it in a browser on the same machine. The login lands in `~/.config/seo-driver/google.json`, readable only by you. The file holds a refresh token, so treat it like a password.

   On a headless server, log in on your laptop instead and copy the file over. The login isn't tied to the machine. Copy it to a temporary name and rename it, so a run never reads half a file:

   ```bash
   ssh server 'mkdir -p -m 700 ~/.config/seo-driver'
   scp ~/.config/seo-driver/google.json server:.config/seo-driver/google.json.new
   ssh server 'chmod 600 ~/.config/seo-driver/google.json.new && mv ~/.config/seo-driver/google.json.new ~/.config/seo-driver/google.json'
   ```

   A run refuses a login file that other users can read. If a run ever says the login expired or was revoked, log in again and copy the new file.

5. Get Keyword Planner access for the Cloud project. **The tool opens no PRs until Keyword Planner works**, and approval takes a while, so apply early. Since September 9, 2026, Google ties Ads API access to the Cloud project, not to a developer token:

   - Enabling the Google Ads API gives the project **Test** access, which only reaches test accounts.
   - In the Cloud Console, open the Google Ads API **Overview** page and apply for access there. Applications made from a manager account's API Center are not processed any more.
   - **Explorer** access is the first level, but it does not cover Keyword Planner (`KeywordPlanIdeaService`).
   - **Basic** access covers it. It needs brand verification of the Cloud project first.

   Put your 10-digit Ads account id in the config as `keywordPlanner.customerId`. A Keyword Planner `PERMISSION_DENIED` in the run log usually means the project doesn't have Basic access yet.

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
| `keywordPlanner.customerId` | required | Your 10-digit Google Ads account id, such as `123-456-7890`. |
| `keywordPlanner.loginCustomerId` | none | The manager account id, only when you reach the Ads account through a manager account. |
| `keywordPlanner.geoTargetConstants` | `["2840"]` (US) | Keyword Planner locations. |
| `keywordPlanner.language` | `"1000"` (English) | Keyword Planner language. |
| `searchConsole.country` | `"usa"` | Search Console queries from this country only, as a lowercase 3-letter code. Match it to `geoTargetConstants`. `"all"` turns the filter off. |
| `claudeMaxBudgetUsd` | `10` | Spend cap for each Claude run (writer, reviewer, fixer). A run that hits it fails its site. |
| `googleCredentials` | `~/.config/seo-driver/google.json` | The login file that `login` writes. |
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

The script makes every Google, `git`, `gh`, and build call itself. Search text and the pages Claude reads can carry instructions planted by anyone, so Claude runs headless with:

- `--restricted`: no settings files (yours or the site repo's), no MCP servers, no shell or other command tools, and file tools confined to the clone and the `writing` skill folder, so Claude can't read your Google login;
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

## License

MIT. See [LICENSE](LICENSE).
