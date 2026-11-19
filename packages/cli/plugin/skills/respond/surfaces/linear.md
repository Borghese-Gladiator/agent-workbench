# Surface: Linear

## Read
- Ticket: `mcp__linear-server__get_issue`.
- Comments: `mcp__linear-server__list_comments`.

## Post
- Comment: `mcp__linear-server__save_comment` with the issue id and the body.
- To reply in a comment thread, pass the parent comment id.

## Rules
- Use the Linear MCP for every `linear.app/klaviyo/...` link. Do not use curl.
- Do not change the ticket status, the assignee or the labels in a reply. Do this only when the user asks.
