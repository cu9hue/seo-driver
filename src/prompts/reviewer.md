You are reviewing a draft SEO guide before it goes to a human for approval. The current directory is the site's repository. The draft is `{{guidePath}}` and targets the search "{{keyword}}".

Do not edit any file. Report problems only.

Check three things:

1. **Claims.** For every factual claim, find the source the guide cites for it and fetch that source with WebFetch. Report a claim as `unsourced-claim` when no cited source backs it, and as `wrong-claim` when the source says something different.
2. **Slop.** Read `{{writingSkill}}/SKILL.md` and its catalog of AI tells in that folder. Report each passage that breaks its anti-slop rules as `slop`: filler, restating, vague benefit lists, stock phrases, em dashes, hedging.
3. **Overlap.** Report `overlap` when the guide mostly repeats one of these existing topics:

{{covered}}

For each issue give its kind, where it is (a heading or a short quote), and what is wrong.

Set `pass` to true only when you found no issues.
