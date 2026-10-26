# Project Case Study — Warehouse Preview Agent

I planned and delivered a working AI prototype for a logistics hiring assignment: a client describes their goods, an AI agent plans where they would go, and a 3D warehouse shows the result. It shipped on time, passed 22 of 22 acceptance tests, and is live for anyone to try.

## At a glance

| | |
| --- | --- |
| Context | Hiring assignment from a global logistics company: "build a 3D visual of a warehouse that a client can see before sending their goods, using agentic AI" |
| My role | Project lead: requirements, plan, quality standards, risk responses, delivery and stakeholder materials |
| Timeframe | 2 days (October 2026) |
| Deliverables | Live web app, source code with tests, 2-minute demo video, 9-slide presentation, demo script, technical README |
| Results | 22/22 acceptance tests passed; 0 invented numbers; public link works without any account |
| Links | [Live demo](https://warehouse-preview-agent.onrender.com) · [Code, video and documentation](README.md) |

## Objective and scope

The objective was to answer a prospective client's real questions before they sign — will my goods fit, is it the right environment, how will they flow — in minutes and in a browser, instead of through PDFs and site visits.

| In scope | Out of scope (stated up front) |
| --- | --- |
| A realistic sample warehouse: 10,144 pallet positions, 4 zones, 12 docks, storage rules | Real company data (not available to a candidate) |
| An AI agent that plans space using tools, never guessing numbers | Live connection to a warehouse management system |
| A 3D view generated from the data | Pricing and contracts |
| Proof of quality: automated tests and a scored test bench | Production security (single sign-on, audit logs) |
| Materials for each audience: demo, video, slides, code | |

Writing down what was out of scope early kept the work focused and let me describe those items honestly as next steps.

## Plan

I started with research and a written plan, then reviewed the plan against the question "what would make this excellent, not just working?" That review added a quality phase and a documentation phase before any building began. Each phase had a deliverable and a check that had to pass before moving on.

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 0. Research and plan | Research document, 7-phase plan | Plan reviewed and approved |
| 1. Data | Sample warehouse with rules, in a standard CSV format | 14 automated checks pass (no double-booking, rules enforced, totals add up) |
| 2. 3D view | Warehouse generated from the data | Works on laptop and phone, light and dark mode |
| 3. AI agent | Agent with tools, visible steps, client report | End-to-end test passes with a simulated AI |
| 4. Test bench | Scored client requests + scripted backup demo | A perfect scripted agent scores full marks; typical mistakes fail |
| 5. Delivery | Live link + full code project | Opens for a reviewer with no account |
| 6. Communication | README, 9 slides, demo script, video | Each audience has what it needs |
| 7. Final review | Strict review and fixes | All checks green |

## Managing a scope change

After the core product worked, I decided the experience needed to be immersive: a client should feel inside the warehouse, not look at a diagram. Rather than adding features ad hoc, I treated it as a formal change.

1. **Defined the options.** Four candidate features (walk inside, follow a pallet, realistic look, narrated tour with sound) plus VR.
2. **Decided with trade-offs.** Accepted all four; rejected VR because it could not be tested reliably and added risk to a live demo.
3. **Protected what already worked.** Every existing test was re-run after the change, and the test bench grew from 20 to 22 cases to cover the new agent abilities.
4. **Updated every deliverable.** Slides, demo script, README and screenshots were revised in the same cycle, so no document described an older version.

Result: the new features shipped with all prior tests still passing.

## Risk register

The biggest risk was trust: one wrong number from an AI would undermine the whole demo in front of a logistics company.

| Risk | Impact | Response | Outcome |
| --- | --- | --- | --- |
| AI invents capacity or distances | High: loses credibility | Rules and calculations moved into code; the AI only chooses tools. Every answer's numbers are checked automatically against the data | 0 invented numbers in 22 test answers |
| AI unavailable during the demo | High | Scripted demo mode that runs the same tools, clearly labelled | Demo can never show a broken screen |
| Reviewers cannot use the AI without an account | Medium | Hosted a public version on a free AI provider, plus a recorded video | Anyone with the link can use it |
| A public link uses up the free AI quota | Medium | Limits per visitor and per day; key kept on the server | Quota protected; visitors see a polite message |
| Overclaiming (sample data shown as real) | High: honesty | Every page labels the site as fictional; the agent is tested on "Is this real?" | Passes the honesty test case |
| Slow on older laptops | Low | Animations run on real time; quality lowers automatically | Same experience length on any machine |

## Quality

I defined "done" as measurable acceptance criteria before building, then measured against them.

| Check | What it tests | Result |
| --- | --- | --- |
| Test bench (live AI) | 22 realistic client requests: correct zone, quantity, tool use, refusals, honesty, no invented numbers | **22/22 passed**, average 4.2 s per request |
| Number check | Every number in every answer traced to the data | **22/22** answers clean |
| Tool tests | Warehouse rules and calculations, with no AI involved | **14/14** passed |
| Fairness of the test itself | A scripted perfect agent must score full marks, and common mistakes must fail | **22/22**; all mistakes caught |
| Browser tests | Full user journeys, phone layout, both AI providers, immersive features | All passing |

Testing the test was deliberate: a high score only means something if a wrong answer would have been caught.

## Stakeholders and communication

Different people needed different things from the same project, so I built one deliverable per audience instead of one document for everyone.

| Stakeholder | What they care about | What I gave them |
| --- | --- | --- |
| Hiring reviewers | Is it impressive, does it work, can this person explain it? | Live link, 2-minute video, 9-slide deck |
| The end client (imagined user) | Will my goods fit, safely, and how do they arrive? | Plain-language chat, 3D view, walk-through, pallet journey, one-page client report |
| Technical reviewers | Is it real, tested and well built? | Public code, README, automated tests, scored test bench |
| Me as presenter | A demo that cannot fail live | Minute-by-minute demo script, backup scripted mode, likely questions with answers |

## Issues log

Not everything went to plan. Each issue was diagnosed from evidence, fixed, and verified.

| Issue | Cause | Fix | Verified by |
| --- | --- | --- | --- |
| Reviewers without an AI account could not chat with the agent | The first version used the viewer's own AI account | Added support for a free AI provider and hosted a public version | Opened the link signed out |
| Live site answered "invalid API key" | Key not entered correctly in the hosting settings | Generated a new key and replaced it | Live question answered correctly |
| Folders missing after upload to the code repository | Upload method skipped folders | Re-uploaded through the correct page | File list checked against the project |
| Demo video rejected (110 MB, limit 10 MB) | Screen recording at full resolution | Compressed to 9.5 MB, kept the text readable | Video plays on the project page |
| Demo pallet lifted only 0.2 m, which looked unconvincing | Nearest free slot was on the floor level | Journey now picks a higher shelf near the dock | Lift to 5.3 m shown in the animation |

## How AI was used, and my role

I led this project and used an AI assistant (Claude) as my build team. The assistant wrote the code, tests and first drafts of the materials. My job was the one a project manager has with any delivery team:

- Set the goal, scope and the standard to aim for ("excellent, not just working")
- Approved the plan and made the key decisions, such as the immersive scope change and the switch to a free AI provider so anyone could use it
- Reviewed each phase before the next one started, and ran the live acceptance test myself
- Handled deployment, accounts and the problems in the issues log
- Decided how the work is presented and stayed honest about what is sample data

The lesson for me: managing AI tools well needs the same discipline as managing people — clear requirements, checkpoints and measurable quality.

## Lessons learned

1. **Define "done" before building.** Writing the 22 test cases early turned "is it good?" into a number.
2. **Plan for the audience you cannot see.** I first assumed reviewers would have the same tools as me; they did not. Checking access from a stranger's point of view should happen earlier.
3. **Treat scope changes formally, even small ones.** Re-running every test and updating every document kept the project consistent.
4. **Put the risky logic where it can be tested.** Moving the rules out of the AI and into code made the product safer and the testing simpler.
5. **Next time:** gather feedback from a real user, such as a warehouse sales manager, before the final version.
