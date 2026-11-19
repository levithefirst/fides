# Fides demo script

Public YouTube video, **strictly under 5 minutes**, English narration or captions. Fluid records and uploads. Nothing here is published by an agent.

Target length: about 4:15. Use a fresh demo site from `forge site provision` with Rovo Chat enabled. Never show a token, the developer console API token page, or any personal email address.

## 0:00 to 0:30. Who, problem, how

1. **Who** (on screen: the Fides logo over Jira). "Fides is for legal, procurement, finance and ops teams who run vendor and SaaS agreements in Jira and Confluence."
2. **Problem.** "Agreements auto-renew because a notice period slipped by. World Commerce & Contracting names missed notice periods and auto-renewals as a value-leakage bucket, and Flexera found only 43% of SAM teams tracked SaaS auto-renewal clauses."
3. **How.** "Fides is a Forge app with a Rovo agent that acts through actions. It connects what an agreement promises to what is actually blocking it, and escalates before the notice window closes."

## 0:30 to 1:15. Zero-setup install (judge mode)

4. Show the install (Sharing link or `forge install --demo-site`), then open **Apps > Fides**. Do not click anything else.
5. The board appears with four agreements and the amber **Threatened milestones escalated** message. Say: "No setup. On install Fides seeded sample agreements on this site, found an open blocker on Helios Payroll, and escalated it straight away, not on tomorrow's schedule."
6. Mention: "Judges can repeat exactly this on their own site after installing."

## 1:15 to 2:00. The notice board

7. Point at the three statuses: **Due** (diamond), **Upcoming** (half square), **On track** (ring). "Every status has a shape and a word, never colour alone."
8. Switch the grouping to **30 / 60 / 90 day window**.
9. Show the last-scan line and **Run scan now**: "A daily scheduled trigger runs the same scan as the app (`api.asApp()`), not as the signed-in user. Errors are caught and shown here."

## 2:00 to 2:40. Jira and Confluence

10. Open the escalation issue. Read the hedged line: "This open blocker may put the notice date of DD MMM at risk." Show the links to the agreement, the blocker and the Confluence contract page.
11. Open the agreement issue and the **Fides notice status** issue panel.
12. Open the contract page in Confluence for a second.

## 2:40 to 4:00. Rovo agent with actions

13. Back on the board, point at the spotlight line: "A date reminder can't see that this blocker is still open." Click **Is Helios at risk, and what should I do?** Rovo Chat opens with the Fides agent.
14. Let it run without typing. Narrate the action cards as they appear: it lists notices, finds the open blocker, calls escalate threatened milestones (and reports the existing escalation instead of creating a duplicate), then drafts the brief from the Confluence page.
15. Read the answer: the risk with the notice-by date, the blocker, the escalation key, renew / cancel / renegotiate options, what a missed notice could mean, and "Fides tracks dates and obligations; it is not legal advice."
16. Ask "Create a review issue for Northwind Analytics." The agent confirms the Northwind key, creates a real Jira issue on this site assigned to the owner (or the agreement's assignee), and returns its key. Open it and point at the assignee.
16a. (20 s) In Confluence, open any contract page and say "Track this contract". Show the proposal quoting the notice clause, confirm, and show the new agreement on the board. Then click **Import agreements**, paste two spreadsheet rows, preview, import.

## 4:00 to 4:15. Close

17. "Forge, Jira, Confluence and a Rovo agent with actions, in the tools your team already uses. Fides: escalate before the notice window closes."

## Checklist before upload

- Under 5:00. English audio or captions. Public visibility.
- No secrets, tokens or personal email addresses on screen.
- The escalation is shown appearing without manual setup.
- The chained ask shows list, escalate and brief action cards; the create-review step shows the fourth action.
