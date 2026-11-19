# Surface: Slack

## Read
- Thread: `mcp__slack__slack_read_thread`.
- Find the thread of a ticket: `mcp__slack__slack_search_public_and_private` with the ticket id. The parent message is the Linear bot post ("... triage queue: CORE-XXXX ...").

## Post
- Reply in the thread. Use `mcp__slack__slack_send_message` with the thread timestamp.
- To save without posting, use `mcp__slack__slack_send_message_draft`.

## Format
- The Slack MCP takes standard markdown. Use `**bold**`, not `*bold*`.
- Before you post to a channel that the user did not name, read its topic with `mcp__slack__slack_search_channels`. If the topic says that this kind of message belongs elsewhere, tell the user and do not post.
