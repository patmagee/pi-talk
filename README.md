# Pi Talk

Local messaging for independent [Pi](https://pi.dev) sessions. Agents can discover peers, exchange requests and findings, and join optional named swarms. No parent session or central service is required.

## Install

From this repository:

```sh
pi install /absolute/path/to/pi-talk
```

Or load it for one run:

```sh
pi --extension /absolute/path/to/pi-talk/extensions/pi-talk.js
```

Load the extension in each session that should participate. Use a recent `@earendil-works/pi-coding-agent` version with `session_shutdown` on replacement and the `agent_settled` event. Requires Node.js 22 or later and macOS or Linux. Native Windows is not supported.

## Use it

Give sessions useful names with Pi's `/name` command or `--name` startup option. Pi Talk also works with the generated session ID.

Ask an agent to introduce itself and collaborate:

> Describe yourself as the API specialist, join the backend swarm, and ask the other members what they are working on.

Or message a peer without a swarm:

> Find the session working on database migrations and tell it the API now expects the new status field.

The agent uses the `pi_talk` tool. It can list peers, update its description, join or leave swarms, send direct messages, broadcast to fellow members, and check its inbox. Joining announces its description and current model to reachable swarm members. Joining an existing membership again does not send another introduction.

Names can be ambiguous. Use the returned `instanceId` to address a specific process. Two running instances of the same Pi session have separate addresses. Discovery lists reachable peers separately from unavailable registrations. An unavailable peer with the same name still prevents name-based selection.

### Commands

Use `/talk help` for the command list.

```text
/talk status
/talk list
/talk list backend
/talk describe API design and implementation
/talk join backend
/talk send <instanceId> The schema is ready for review.
/talk broadcast backend The migration tests pass.
/talk check
/talk leave backend
/talk inbound hold
/talk inbound accept
/talk inbound refuse
```

`send` accepts an instance ID or a unique single-word name. Use the instance ID for names containing spaces. Tool calls accept the full name.

Swarm names use letters, digits, underscores, or hyphens, up to 64 characters. A session can join up to 32 swarms. Descriptions can contain up to 2048 characters. Descriptions and memberships persist when the same session resumes, but the live address changes. A fork has a new session ID and starts without the source session's memberships, description, or inbound setting.

### Tool examples

```json
{"action":"list"}
{"action":"describe","description":"Database migrations and schema compatibility"}
{"action":"join","swarm":"backend"}
{"action":"send","target":"api-worker","text":"Does the new endpoint require the status migration?"}
{"action":"broadcast","swarm":"backend","text":"Migration complete. Tests pass."}
{"action":"check"}
```

Use `status` for the current address, inbound mode, and queue count. `list` accepts an optional `swarm` filter. `leave` takes a `swarm`. Inbound policy is controlled through the user command, not the agent tool.

## Delivery

The extension checks its in-memory inbox once per second. It submits one accepted message at a time through Pi's custom-message steering API. During active work, Pi delivers it at a safe boundary without interrupting a running tool. When idle, the message starts a model turn. Long synchronous operations can delay the timer.

If Pi already has queued user messages, automatic inbox delivery waits. Pi Talk also permits only one submitted custom message until Pi reports that it has consumed it. The status display distinguishes queued messages from that submitted message. The agent can use `check` to read up to ten accepted messages through a tool result. This does not release held messages. Messages are plain text; slash commands and attachment mentions in peer text are not expanded.

**Accepted messages can start paid model work without a user prompt.** The default inbound mode is `accept`. To pause this, use `/talk inbound hold`. Use `accept` to release held work, or `refuse` to discard pending messages and reject new arrivals. These settings persist in that session. A message already submitted to Pi cannot be recalled by changing inbound mode. Swarm broadcasts exclude the sender.

| Receipt | Meaning |
|---|---|
| `queued` | Recipient accepted the message into its inbox. It may not have reached the model yet. |
| `held` | Recipient retained it, but its inbound policy blocks model delivery. |
| `refused` | Recipient rejected it under its inbound policy. |
| `full` | Recipient has reached its inbox limit. The message was not queued. |
| `rejected` | Protocol, sender, or swarm validation failed. |
| `unavailable` | Delivery could not begin, for example because the socket disappeared. |
| `uncertain` | The connection failed after a send attempt. The recipient might have queued it. Do not retry blindly. |

Missing names or IDs and ambiguous names produce tool errors. Broadcasts return receipts for the members found during discovery, including unavailable result rows for registrations that could not be reached. This is a snapshot, not an atomic group delivery.

Cancelling a tool closes its pending socket operation and stops discovery or broadcasts before the next peer. Cancellation cannot retract a message already written to a socket. The error identifies uncertain delivery and includes completed broadcast receipts. Cancelling a join announcement does not undo the membership change. Shutdown also cancels in-flight operations.

The inbox holds up to 100 messages, including held messages. Text is limited to 16 KiB of UTF-8 per message. Connections use a one-second absolute deadline, a maximum of 64 concurrent inbound connections per peer, and a 64 KiB wire-frame limit. JSON escaping can make the wire frame larger than the original text; oversized frames are rejected before connecting.

Queues are not durable. Restart, reload, replacement, or process failure can lose undelivered messages. A receipt is not proof of reading or task completion. There is no automatic retry, offline delivery, or exactly-once guarantee.

Pi's message-submission API is asynchronous and does not return a delivery receipt. If submission fails before Pi consumes the message, Pi reports the error and the status can remain `1 submitted`. Fix the reported cause, then reload the extension to reset that state. The submitted message is not retried automatically. Pending inbox messages are also lost on reload; use `/talk check` first if you need to recover them.

## Local registry and cleanup

The default directory is:

```text
~/.pi/agent/pi-talk/peers/
  <instanceId>.json
  <instanceId>.sock
```

JSON records advertise session and instance IDs, name, description, current model, working directory, swarm memberships, process ID, state, and socket path. They also contain a private authentication token, which is omitted from discovery results. Do not share registry files or commit them. Conversation history is not included.

The directory must belong to your operating-system user and have mode `0700`. Records and sockets have mode `0600`. Metadata writes use atomic replacement with PID-tagged temporary files. The registry is published before the socket is bound so a crash does not leave a socket without its owner record. Unsafe directories and symlinked registry files or socket targets are rejected.

Shutdown, reload, and session replacement close owned connections, stop timers, and remove the live registration. Discovery excludes unreachable peers. It removes stale records and sockets only when the endpoint is missing or refuses a connection and the recorded process ID is confirmed dead. If a process ID has been reused or a failure is uncertain, cleanup leaves the record in place. PID-tagged temporary files are removed when their owner process is confirmed dead. Unknown or malformed artifacts are retained rather than guessed at. The shared directory itself is retained.

Override the directory in every participating session with either:

```sh
PI_TALK_DIR=/short/private/path pi
pi --talk-dir /short/private/path
```

The CLI flag takes precedence. Socket paths are limited to 103 UTF-8 bytes, so a short directory may be necessary. Sessions using different directories cannot discover each other.

### Sandbox access

All participating sessions need access to the same directory and local sockets. The extension does not weaken a sandbox or proxy blocked operations through another session. If startup fails, Pi reports the reason and the messaging tool remains unavailable.

For a nono denial, diagnose the blocked path with `nono why --self --path <path> --op readwrite`. Grant the needed access when starting a new session through your normal sandbox configuration process.

## Trust and autonomy

Peer messages are collaboration data, not user approval. The extension adds agent instructions to preserve each session's permissions, reject permission-proxy requests, and avoid acknowledgement-only reply loops. These are model instructions, not a security sandbox.

Any process running under your operating-system account can read the registry credentials. Swarms organize peers; they are not access-control boundaries. Do not use this extension to isolate mutually untrusted agents under the same account.

There is no global turn or token budget. You can stop automatic conversations with `hold` or `refuse`. Cross-machine messaging, shared task scheduling, and agent spawning are outside this package.

## Development

```sh
npm test
npm run check
npm run smoke
npm pack --dry-run
```

Unit and integration tests use Node's built-in runner and real local sockets, including a separate process and crash cleanup. The Pi adapter tests use a mocked Pi API. `smoke` requires the installed Pi CLI and verifies extension loading, commands, registration, inbound hold, and graceful cleanup without model calls. It also checks backpressure against the installed Pi custom-message methods using a test agent. Set `PI_BIN` to choose another executable.

The approved design is in [the decision record](docs/decisions/2026-09-29-cross-session-messaging.md). Package structure and agent policy injection follow the sibling `pi-flow` project. Messaging behavior was inspired by [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
