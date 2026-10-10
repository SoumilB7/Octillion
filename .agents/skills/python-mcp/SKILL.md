---
name: python-mcp
description: Configure or use a Python MCP server routed through Octillion.
---

# Python MCP upstream

Use this skill when configuring or using an upstream Python MCP server through Octillion.

- Enable the bridge with `PYTHON_MCP_ENABLED=true`.
- Prefer `PYTHON_MCP_URL` to connect to a separately hosted Streamable HTTP MCP server and offload Python execution from the Octillion host. Use `PYTHON_MCP_AUTH_TOKEN` for bearer auth over HTTPS. For local development, set `PYTHON_MCP_COMMAND` and `PYTHON_MCP_ARGS`.
- Upstream tools are exposed by Octillion with a `python_` prefix.
- The subprocess receives only standard runtime environment variables by default. Pass any additional variables explicitly through `PYTHON_MCP_ENV` as a JSON object.
- Do not pass Boat API keys or other secrets unless the Python server needs them; do not print or commit secrets.
- Prefer a project virtual environment and trusted packages. Keep Python server stdout reserved for MCP protocol messages.

Select this skill from `/skills` or invoke `$python-mcp`.
