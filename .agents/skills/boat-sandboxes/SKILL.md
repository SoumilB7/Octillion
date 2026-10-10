---
name: boat-sandboxes
description: Operate Boat cloud sandboxes from the Octillion MCP router, including agent prompts, commands, events, files, snapshots, and lifecycle. Use when working with boat.dev sandboxes.
---

# Boat sandbox operations

Use the `boat_*` MCP tools exposed by Octillion. They call the official Boat TypeScript SDK and the Boat Public API.

## Authentication and setup

- The Boat tools require `BOAT_MCP_ENABLED=true` and `BOAT_API_KEY` in the process environment. `BOAT_BASE_URL` defaults to `https://boat.dev/api/v1`.
- Create a key in the Boat dashboard or with `boat api-key create`. Never request, print, log, or commit the key.
- Provider credentials for sandbox agents must be configured in Boat. A local Boat API key does not replace provider credentials.

## Workflow

1. Check account limits and list sandboxes before creating or changing a sandbox.
2. Confirm the target sandbox ID before resuming, stopping, prompting, writing files, or running commands.
3. Use `boat_prompt` to queue work, retain the returned conversation and prompt IDs, then inspect `boat_prompt_status` or `boat_events` for progress.
4. Do not stop a sandbox while an agent run is still executing unless the user specifically asks. Stop snapshots and archives the sandbox; it can be resumed later.
5. Do not use `boat_delete_sandbox` without explicit user authorization and exact sandbox-ID confirmation. Deletion is irreversible.
6. Treat Boat secrets and desktop URLs as sensitive; do not repeat them in responses.

Use `/skills` to select this skill in Codex or invoke it directly with `$boat-sandboxes`.
