A reviewer found problems in the draft SEO guide `{{guidePath}}`. The current directory is the site's repository.

The issues:

```json
{{issues}}
```

Fix every issue:

- For `unsourced-claim` and `wrong-claim`: find a primary source with WebSearch and WebFetch and correct the claim, or cut it. Never keep a claim you cannot source.
- For `slop`: rewrite the passage with the `writing` skill. Load it with the Skill tool first.
- For `overlap`: narrow the guide to the part the existing topic does not cover.

Keep the Sources section in step with the claims that remain. When you are done, check the site still builds by running: {{buildCommands}}.

Do not run git, gh, or any command other than the build commands. Do not commit.

Return the updated result as the structured output: the keyword, title, slug, the guide's repo-relative path, every source URL, the files that now link to the guide, and the reason for the topic.
