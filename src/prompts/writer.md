You are adding one new SEO guide to the website {{domain}}. The current directory is a fresh clone of the site's repository.

## Pick the topic

These are the candidate searches, from Google Search Console and Google Ads Keyword Planner, best first:

```json
{{shortlist}}
```

Pick the one keyword that best fits what this product does and who it serves. Read the homepage and existing guides to learn the product. Prefer Search Console entries: the site already appears for them but gets no clicks. Copy the keyword exactly into `keyword` and explain the choice in `reason`.

The site already covers these topics. Do not repeat them:

{{covered}}

## Write the guide

- Answer one narrow question, phrased the way people search it. Not a broad topic.
- Put the answer first. Readers should get it in the opening lines.
- Be concrete and specific to this product's domain: real menu names, real setting names, real numbers.
- Research with WebSearch and WebFetch. Back every factual claim with a source. Prefer primary sources: official manuals, vendor documentation, standards. Cut any claim you cannot source.
- Write the prose with the `writing` skill. Load it with the Skill tool before you write.
- Match the structure, voice, and closing pitch of the existing guide `{{exampleGuide}}`. Mention the product lightly and keep the closing call to action. No sales copy in the middle of the guide.
- End the guide with a section headed "Sources" that lists every source you cited.

## Add it to the site

Add the guide the same way the existing guide was added: the page itself, plus any build configuration, sitemap entry, and navigation or footer links that list guides. Link to the new guide from the homepage and from related guides.

Site-specific instructions (may be empty):

{{instructions}}

When you are done, check the site still builds by running: {{buildCommands}}. Fix anything you broke.

Do not run git, gh, or any command other than the build commands. Do not commit.

Return the result as the structured output: the keyword, title, slug, the guide's repo-relative path, every source URL, the files that now link to the guide, and your reason.
