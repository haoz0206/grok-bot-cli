---
"@haoz0206/grok-bot-cli": patch
---

Route gateway requests for port-routed Grok Bot boxes. When EnsureSandBox returns an empty `networkToken` and a `gatewayPortToken`, send it as `x-anyrun-port-token`, as the desktop app does; previously these requests failed with "Gateway returned invalid JSON" (a 404 "could not be routed").
