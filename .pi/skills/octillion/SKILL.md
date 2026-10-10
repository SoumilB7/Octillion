---
name: octillion
description: Query Octillion product analytics, user accounts, developer segments, and agent traces efficiently through MCP.
---

# Octillion MCP workflows

Use the `mcp__octillion` namespace. Pi exposes its tools through codemode by default, allowing scripts to combine calls and return concise results.

- For product questions, start with `get_product_overview`.
- For account questions, use `get_user_account` and request only the target account when possible.
- For usage or reliability trends, call `list_trace_runs` with the narrowest appropriate filters, then `get_agent_session` for relevant details.
- For developer composition, use `get_developer_population` with a specific dimension when one is requested.
- Keep output focused on the requested account, time window, and workflow. Include relevant failure counts, latency, and cost.
