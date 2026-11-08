Problems were found in the draft SEO guide `{{guidePath}}`. The current directory is the site's repository.

The issues:

```json
{{issues}}
```

Fix every issue:

- For `unsourced-claim` and `wrong-claim`: find a primary source with WebSearch and WebFetch and correct the claim, or cut it. Never keep a claim you cannot source.
- For `slop`: rewrite the passage with the writing skill. Read `{{writingSkill}}/SKILL.md` and the reference files it points to first.
- For `overlap`: narrow the guide to the part the existing topic does not cover.
- For `build`: the site build failed. `detail` holds the end of its output. Fix the cause in the files you added or changed.

Keep the Sources section in step with the claims that remain. Keep the guide at `{{guidePath}}`.

You cannot run commands. When you finish, the site is built again with {{buildCommands}}, and any build errors come back to you.

Return the updated result as the structured output: the keyword, title, slug, the guide's repo-relative path, every source URL, the files that now link to the guide, and the reason for the topic.
