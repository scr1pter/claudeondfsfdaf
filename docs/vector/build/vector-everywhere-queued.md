# Vector everywhere (queued 2026-10-27, after Codium)

Owner approved queuing this plan. Not designed or built yet.

Idea: a Vector bot on GitHub, Slack, Linear and Jira that is cloud-autonomous yet local-first.
- Trigger: @Vector in Slack, an assigned Linear/Jira issue, a GitHub mention.
- Route: if the user's laptop is online, run there through the Vector Remote relay (Brain, local models, files stay local); otherwise run in the user's own GitHub Actions with the approved knowledge snapshot. Vector's servers only relay messages, never hold code.
- Order: GitHub App (coded, needs registering) -> Slack -> Linear (agent assignment API) -> Jira (Atlassian review, enterprise).
- Must include: user mapping between platforms and Vector accounts, who may trigger spend, prompt-injection defence for ticket/message text, per-platform app review steps for the owner.
- Depends on: the Codium cloud-agents work, Vector Remote relay, the GitHub App registration.
