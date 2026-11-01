# 402Mob local wallet MCP

A local stdio companion to `402mob-agent-wallet@0.1.2`. Requires Node.js 22.13+
on Linux/macOS and a persistent private absolute wallet directory. The MCP host
launches the executable; an agent can then enroll through one tool call.

Tools:

- `wallet_readiness`: checks platform, storage location and service health without key creation. It does not validate an external vault or signer.
- `wallet_status`: public local snapshot; requires saved state. It does not authenticate the saved credential remotely.
- `wallet_bootstrap({name})`: generates/reopens an EOA, validates/signs the enrollment challenge and retains the merchant key. Repeat with the same directory after interruptions.

The host fixes directory, service origin and optional trusted adapter at startup.
Tool arguments cannot select another wallet directory, load code or export keys.
Only bootstrap creates an identity. No funding, publication, discovery, payment or
arbitrary signing tools are exposed. Losing a completion response can lead to
credential rotation; this invalidates the previous merchant key for the same wallet.

Local files are private (0700/0600) but unencrypted. Use an encrypted disk or the
Node wallet's secretStore/signer adapter via startup `--adapter`. Keep Node/Python
wallet directories separate. Missing bound secrets require restoration, not deletion.

This server is local to the agent runtime. `https://evidence.contact/mcp` is the
separate hosted service MCP and cannot generate or hold the agent's private key.
MCP configuration examples and release status: https://evidence.contact/wallet-mcp.md.
