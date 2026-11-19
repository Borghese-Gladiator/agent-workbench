# Source: Linear

## Read
1. Ticket: `mcp__linear-server__get_issue`. Comments: `mcp__linear-server__list_comments`.
2. Find the Slack thread of the ticket: search the triage channel for the ticket id. Read the thread. A reply there can already answer the ticket.
3. Find the code the ticket names. Read it in the local repo.

## Verdict
- `fix`: the ticket describes a fault, and the code shows it.
- `answer`: the code or a permission shows that the behavior is correct. Quote the file and line.
- `request`: the ticket asks for new behavior.
- `route`: another team owns the code. Cite the CODEOWNERS line (`<repo>/.github/CODEOWNERS:<line>`).
- `skip`: duplicate, or already fixed. Link the other ticket or the commit.

## Owner and severity
- Owner: the team in the ticket, then the CODEOWNERS line for the code.
- Severity: the ticket priority. Do not invent a number.
