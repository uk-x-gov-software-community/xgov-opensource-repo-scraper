I learnt this week that the very first commit to a side project of mine was made at twenty to one in the morning on a Saturday in October 2018. I have no real recollection of what prompted that particular late-night coding session (the git log, as ever, is more reliable than my memory), but I do know the context. I was a tech lead in the office of the CTO at the Home Office, and I was looking for some hard numbers to support a case I kept having to make: that open source in UK public sector was not only happening, but thriving.

The tool I built that night was a [scraper](https://github.com/uk-x-gov-software-community/xgov-opensource-repo-scraper). It pulled the official list of UK government organisations from GitHub, fetched all their public repositories, and rendered the results in a simple table — the [X-UK-Gov Public Repository Leaderboard](https://uk-x-gov-software-community.github.io/xgov-opensource-repo-scraper/). AngularJS 1.5, Bootstrap 3, a bit of inline CSS. It worked. And — rather remarkably — it continued to work for the best part of eight years with almost no maintenance.

I think that fact alone tells you something about the nature of side projects built in the small hours.

**From Hundreds to Twenty-Six Thousand**

When I first assembled that leaderboard, the number of public repositories across UK government organisations was perhaps in the low thousands. It seemed to me at the time that this was already a success story worth telling, particularly given the resistance I often encountered when encouraging departments to code in the open. Today, that number stands at over 24,500 repositories across 186 organisations. The growth has been extraordinary, and I think it reflects a genuine shift in culture across UK public sector technology.

I should be honest: I have been an enthusiastic (perhaps occasionally tiresome) advocate for open source throughout my career in and around government. I have walked into departments and personally evangelised the benefits of coding in the open, sometimes to receptive audiences and sometimes to rooms full of politely sceptical faces. The typical objections tend to follow familiar patterns: that the work is somehow exempt from the Service Standard; that what they're building is so unique and specialised that sharing it would be meaningless; or — the most persistent myth — that publishing source code creates unacceptable security risks.

Fortunately, there are people considerably smarter than I who have written at length about why these objections don't hold up. The government's own [security considerations guidance](https://www.gov.uk/government/publications/open-source-guidance/security-considerations-when-coding-in-the-open) is unequivocal: open code can be "just as secure or more secure than closed code," and security through obscurity "is considered insufficient by security experts." The [guidance on when code should be open or closed](https://www.gov.uk/government/publications/open-source-guidance/when-code-should-be-open-or-closed) limits the exceptions to three narrow categories: keys and credentials, fraud detection algorithms, and unreleased policy. Everything else should be open. They use a rather good padlock analogy: everyone knows how a padlock works, but it's still secure because you cannot open it without the key.

And when my own arguments have fallen short, friends at the National Cyber Security Centre have always been generous in supporting the case. The NCSC's guidance on [protecting code repositories](https://www.ncsc.gov.uk/collection/developers-collection/principles/protect-your-code-repository) takes a pragmatic approach — acknowledging that coding in the open requires good security practices (automated testing, peer reviews), while their position on [secure by default](https://www.ncsc.gov.uk/information/secure-default) design explicitly states that security through obscurity should be avoided. At a [cross-government open source security meetup](https://technology.blog.gov.uk/2017/10/10/open-source-security-meetup-7-things-we-learned-from-the-cross-government-event/) back in 2017, an NCSC panel agreed that "open code is not more or less secure than closed code" — what matters is writing clean code, employing peer reviews, and developing a team culture that thinks like an attacker.

**Opening First Repositories**

Perhaps the thing I'm most proud of in this space is that several organisations opened their very first public GitHub repositories during my tenure working with them. The [Bank of England](https://github.com/bank-of-england) (which now has 11 public repositories) and the [Crown Prosecution Service](https://github.com/CPS-Innovation) (with 52 public repositories and counting) are amongst those that took what can feel like a significant step. The conversation that leads to that first commit is always interesting — there is genuine nervousness, a sense that publishing code is somehow irreversible and dangerous. But once that first repository is public, something shifts. Teams realise that the sky has not fallen in, and the benefits (accountability, collaboration, reduced duplication) start to become visible.

**Coding in the Open vs Truly Open Sourcing**

I do think it's important to acknowledge a distinction that often gets lost in these conversations. There is a meaningful difference between coding in the open — making your source code publicly visible — and truly open sourcing, which means actively accepting contributions from outside your organisation.

And yet.

Truly open sourcing remains inherently challenging in UK public sector. In my experience, external contributions to government repositories are vanishingly rare. I have only received outside pull requests on a couple of occasions across all the public sector repos I've been involved with. So the risk that departments worry about — being overwhelmed by external contributions, or having to manage a community — is largely theoretical.

However, I believe that coding in the open is an enormous step in the right direction regardless. As Anna Shipman wrote in her excellent GDS blog post on [the benefits of coding in the open](https://gds.blog.gov.uk/2017/09/04/the-benefits-of-coding-in-the-open/), the Skills Funding Agency once built a tool in a week instead of two months by reusing GDS code they found on GitHub. That kind of serendipitous reuse only happens when code is visible. It sets organisations up for the possibility of genuine collaboration when the time is right. It makes reuse possible even when active contribution isn't happening. And it creates a culture of transparency that has knock-on effects throughout a team's way of working. (James Stewart's [original 2012 GDS post on coding in the open](https://gds.blog.gov.uk/2012/10/12/coding-in-the-open/) remains a remarkably good articulation of why this matters, and I find myself returning to it regularly.)

**What GDS Assessments Taught Me**

As a GDS Service Standard assessor, I have sat through a good number of service assessments, and I have noticed a consistent pattern: teams that meet [point 12 of the Service Standard](https://www.gov.uk/service-manual/service-standard/point-12-make-new-source-code-open) — "make new source code open" — tend to be teams that are getting other things right as well. Point 12 requires teams to make all new source code open and reusable, published under appropriate licences. The [detailed guidance on making source code open and reusable](https://www.gov.uk/service-manual/technology/making-source-code-open-and-reusable) goes further, recommending that teams start open from day one rather than trying to retroactively open existing code. The [Technology Code of Practice](https://www.gov.uk/guidance/be-open-and-use-open-source) reinforces this at point 3: "be open and use open source."

It's not just about the code itself — it's a cultural signal. These teams are typically aligned to the Service Standard more broadly. They tend to be progressive and forward-thinking, working with an appropriate understanding of security and privacy rather than imagining that they are somehow uniquely risk-averse.

It seems to me that openness in code reflects an openness in mindset, and that correlation is strong enough that I've come to view it as a reliable leading indicator during assessments.

**The Upgrade: From AngularJS to Something That Actually Scales**

Which brings me to the reason for writing this piece. After nearly eight years of that original AngularJS 1.5 frontend faithfully rendering its table (a testament, perhaps, to the durability of simple things), I have finally given the leaderboard a significant upgrade.

The original version was written entirely without AI coding assistance — in what now feels like a distant era, though it was really only 2018. The irony is that it's precisely because of AI coding assistance that I've been able to make these improvements as a sideline activity alongside my day job on the [National Digital Exchange](https://aws.try.ndx.digital.cabinet-office.gov.uk) (NDX). NDX is currently providing free cloud sandboxes to local government and other departments with interesting use cases they're willing to share openly — essentially saying "here's an AWS environment, go experiment" with zero procurement overhead. Over 50 organisations are currently evaluating cloud services through the platform, working on everything from council chatbots to planning application AI to FOI redaction tools. It's the sort of practical, unglamorous infrastructure that I think genuinely accelerates digital transformation.

But I digress (a privilege of the side project blog post).

The old interface looked like this:

![The original AngularJS interface — Bootstrap 3, a simple sorted table, no filtering or dashboard](blog-old-ui.png)

And the new one looks like this:

![The new interface — dashboard with stats, charts, and visualisations, plus a modern virtual-scrolling table](blog-new-ui.png)

The new frontend streams 24,500 repositories through a custom JSON parser, renders them in a virtual-scrolling table (so the browser doesn't choke trying to create 24,500 DOM nodes, which is essentially what the old Angular version did), and includes a collapsible dashboard with live statistics: repository counts, star distributions, language breakdowns, top organisations, license analysis, and activity trends over time. No frameworks, no dependencies — just vanilla JavaScript, CSS, and inline SVG.

**The Real Change: Software Bills of Materials**

However, the more significant addition is not the user interface. We are now collecting Software Bills of Materials (SBOMs) for every repository in the dataset.

For those unfamiliar with the concept, an SBOM is essentially an ingredients list for software. Just as food packaging tells you what's in your sandwich, an SBOM tells you what dependencies a piece of software relies upon — every library, every framework, every transitive dependency, with version numbers and licence information. The concept has gained considerable traction in recent years (particularly following various high-profile supply chain incidents), and GitHub now generates them automatically for any public repository through their dependency graph API.

We are collecting these SBOMs incrementally (it takes some time to process over 24,500 repositories at a pace that respects GitHub's API rate limits) and publishing them alongside the existing repository data. Individual SBOMs are available as compressed SPDX JSON files at predictable URLs — for example, GCHQ's CyberChef SBOM lives at [`/sbom/gchq/CyberChef.json.gz`](https://uk-x-gov-software-community.github.io/xgov-opensource-repo-scraper/sbom/gchq/CyberChef.json.gz). If you want the whole lot in one go, there is a consolidated CycloneDX SBOM covering every catalogued repository available at [`/sbom.json.gz`](https://uk-x-gov-software-community.github.io/xgov-opensource-repo-scraper/sbom.json.gz). And the underlying repository data itself remains available as [`/repos.json`](https://uk-x-gov-software-community.github.io/xgov-opensource-repo-scraper/repos.json), which now includes SBOM paths for each repository where one is available.

I think this is where things get genuinely interesting. With SBOMs for thousands of public sector repositories, we can start to explore some real questions about commonality and reuse across UK government technology. Which libraries are most widely shared? Where are there clusters of organisations solving the same problems independently? What does the dependency landscape actually look like at scale? And yes — there are security implications too, in terms of understanding exposure to specific vulnerable dependencies across the estate.

I should note that I am not revealing anything that a motivated adversary couldn't discover independently. Everything here is based on publicly available information, and GitHub's own dependency graph is accessible to anyone. I'm simply aggregating what's already in the open. (The breadth of my ignorance about what might constitute a genuine security concern expands every day, but I'm reasonably confident on this point. The NCSC has [written specifically about SBOMs and the importance of inventory](https://www.ncsc.gov.uk/blog-post/sboms-and-the-importance-of-inventory), advocating for exactly this kind of transparency in software supply chains.)

**What the Numbers Tell Us**

The dashboard tells some interesting stories even at a glance. JavaScript, Python, and HTML dominate the language landscape. The Ministry of Justice leads with over 2,400 public repositories, followed by HMCTS, HMRC, and DEFRA. Nearly 46% of repositories use the MIT licence, but a concerning 32% have no licence at all — which technically means they're published but not actually open source in any meaningful legal sense. (Perhaps we should do something about that.) Around 38% of repositories show recent activity, while roughly 35% are archived. GCHQ's CyberChef remains the standout star with over 34,000 GitHub stars, which I think is a wonderful example of a government-produced tool that has found genuine utility far beyond its original context.

The growth curve is telling too. Repository creation accelerated sharply from around 2014, peaked in 2018-2019, and has maintained a steady pace since. Push activity, interestingly, continues to climb — 2025 and 2026 are showing the highest activity levels yet, suggesting that the sector is not just creating repositories but actively maintaining them.

**Grace Hopper Would Approve**

[Grace Hopper](https://en.wikipedia.org/wiki/Grace_Hopper) — who gave us the term "debugging" after removing an actual moth from a relay in the [Mark II](https://en.wikipedia.org/wiki/Harvard_Mark_II) computer — was a fierce advocate for sharing and reuse long before the term "open source" existed. She famously said that the most dangerous phrase in the language was "we've always done it this way." I think she would have appreciated the quiet revolution happening across UK public sector: thousands of teams, in departments from the Home Office to the Bank of England, choosing transparency over secrecy, collaboration over duplication.

We haven't solved open source in government. We probably never will, entirely — it's an ongoing negotiation between openness and pragmatism, between the ideal and the achievable. But 24,500 public repositories is not nothing. It's a foundation. And with SBOMs now providing a window into what those repositories actually contain, we have an opportunity to move beyond simply counting repositories and start understanding what UK public sector technology really looks like at scale.

Perhaps that's worth a late-night coding session or two.

**Links**

- [X-UK-Gov Public Repository Leaderboard](https://uk-x-gov-software-community.github.io/xgov-opensource-repo-scraper/) — the live dashboard
- [Source code on GitHub](https://github.com/uk-x-gov-software-community/xgov-opensource-repo-scraper) — pull requests welcome
- [repos.json](https://uk-x-gov-software-community.github.io/xgov-opensource-repo-scraper/repos.json) — the raw repository data (prefer linking over downloading)
- [sbom.json.gz](https://uk-x-gov-software-community.github.io/xgov-opensource-repo-scraper/sbom.json.gz) — consolidated CycloneDX SBOM for all catalogued repositories
- Individual SBOMs at `/sbom/{owner}/{repo}.json.gz` — e.g. [`/sbom/gchq/CyberChef.json.gz`](https://uk-x-gov-software-community.github.io/xgov-opensource-repo-scraper/sbom/gchq/CyberChef.json.gz)

_(Views in this article are my own.)_
