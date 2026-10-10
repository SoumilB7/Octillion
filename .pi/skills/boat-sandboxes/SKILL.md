---
name: boat-sandboxes
description: Safely manage Boat.dev sandboxes and agent prompts through Octillion MCP tools.
---

# Boat sandbox operations

Use the `boat_*` MCP tools exposed under `mcp__octillion`.

- Check account limits and list sandboxes before creating or changing one.
- Use `boat_prompt` to queue agent work, then inspect `boat_prompt_status` or `boat_events`.
- Do not stop a sandbox while an agent prompt is running unless the user explicitly requests it.
- Stopping snapshots/archives a sandbox so it can be resumed. Deleting is irreversible and requires explicit authorization and exact sandbox-ID confirmation.
- Treat API keys, sandbox secrets, and returned desktop URLs as sensitive.
