# Architecture and operating contract

## The layers

1. `dna/FOUNDATION.md`: reusable identity, judgment, curiosity, candor, hospitality, ambition, evidence and authority standards.
2. `roles/chief-of-events/` and `skills/chief-of-events/SKILL.md`: Mira's personality, remit, decision principles and professional workflow.
3. `src/events.mjs` and `src/runtime.mjs`: validated briefs, deterministic artifacts, optional model drafting and consultations.
4. `src/work.mjs`: accountable task graphs, event-local deadlines, decision proposals, sourced observations and advisory readiness.
5. `src/store.mjs`, `src/lock.mjs` and `src/policy.mjs`: durable work, revision checks, cooperative transactions and exact-payload handoffs.
6. `src/onboard.mjs`, `src/export.mjs` and `src/mcp.mjs`: local hire, portable host bundles and a real MCP work connection.
7. `src/evaluation.mjs` and `evals/`: fixed comparisons, retained model responses, limited machine checks and explicit human reviews.

The CLI runs bounded local commands. A configured provider can author drafts and answer consultations. An MCP-compatible host supplies its own reasoning loop and permissions, then calls the local work tools. Neither installation nor a personality prompt creates a background employee. Scheduling and external execution require a separate host integration.

## Storage and transactions

```text
.teammates/
  .gitignore                    Excludes workspace contents from Git
  state.json                    Version 2 work ledger and conversation history
  .write.lock                   Temporary cooperative transaction lock
  missions/<mission>/<run>/      Retained artifacts for each draft run
  role-<runtime>/                Editable exported role bundle
```

State contains organization context, missions, tasks, decisions, observations, memory, handoff requests, audit entries and conversations. Mission and record IDs are random UUIDs. Mutations queue within a store instance, acquire a single-host file lock, read the latest committed state, validate, and save through a same-directory temporary file and atomic rename. Snapshots also read committed state so independent CLI and MCP processes see recent work. Version 1 ledgers migrate without dropping history; legacy mission approvals require renewed review.

Lock recovery removes a lock only when its recorded process is observed dead. A separate recovery guard prevents competing processes from deleting a new writer's lock. If a process dies while holding that recovery guard, subsequent writes fail closed: an operator must establish that the recorded process is dead before removing the leftover guard. This is a cooperative single-host design, not a distributed database or protection against malicious processes editing the files.

New workspace directories and state files use restrictive creation modes. State and configuration reject symlinks and hard-linked files. Existing parent permissions are the operator's responsibility. Storage is local plaintext, with a 50 MB state read limit; it is not an encrypted vault. Historical documents, conversations and audit entries remain until the owner removes them. Audit records are lifecycle evidence, not tamper-resistant execution receipts.

## Brief, draft and task versions

A mission has a brief `revision`, a `draftRevision`, and a monotonically increasing `draftVersion`. Brief edits retain history, make the current pack stale, reopen accepted decisions, block tasks for review, preserve earlier completion evidence in task history, and supersede mission handoffs. Owners and deadlines require review against the new brief; they are not silently reassigned.

CLI, API and MCP brief edits require the expected current revision. Host draft saves require both expected brief revision and draft version. Model drafting captures both before its request and checks them before commit. A slower response cannot replace a newer pack or a revised brief. Artifact directories remain available when a response is rejected.

Task updates have their own expected revision. A completed task requires an accountable owner, substantive supplied evidence and accountable completion evidence for all transitive prerequisites. Graph validation rejects missing dependencies, cross-mission references and cycles. Evidence is a caller assertion that an owner must verify; length checks do not establish truth. Readiness is an advisory review of recorded pre-event work, with follow-through tracked separately. It cannot authorize a real event to proceed.

## Live drafting and memory

One Chat Completions request receives the shared DNA, persona, workflow, normalized mission, existing drafts and confirmed preferences. It must return exactly the expected Markdown files, substantive contents and a reflection. Unknown, duplicate or missing files are rejected. CSVs stay deterministic. This establishes document structure, not the truth or quality of recommendations.

Consultations retain prompt and reply locally and use up to six prior exchanges from the same mission revision. A revised brief is authoritative; old exchanges do not enter its current consultation context. A slow consultation response cannot be saved against a changed brief. Only confirmed memory enters provider context. Host memory suggestions remain proposed until owner confirmation. Deletion removes active memory; earlier artifacts and conversations retain their history.

The operator explicitly selects a provider and model. HTTPS providers receive private mission data; local HTTP is accepted only for localhost. Requests reject redirects, and errors do not echo provider response bodies or credentials. Actual provider schema compatibility remains unverified. Host MCP tools make no provider requests; host reasoning follows that host's billing and access.

## Local API

`open-teammates start` binds loopback. Only the corresponding `127.0.0.1:PORT` and `localhost:PORT` Host values are accepted; unexpected origins and browser cross-site requests are rejected. Obtain the per-process token from `GET /api/session`, then send `X-Teammates-Token` on other API requests. This is a trusted local owner interface, not a public multi-user service.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/state`, `/api/briefing` | Current ledger/capabilities or on-demand work briefing |
| POST | `/api/missions` | Validate a brief and seed suggested work |
| POST | `/api/missions/:id/revise` | `{patch, expectedRevision, reason}` |
| POST | `/api/missions/:id/run` | Template or explicitly enabled live drafting |
| GET | `/api/artifacts/:id/:name` | Current saved artifact |
| POST | `/api/tasks`, `/api/tasks/:id` | Create work or update `{patch, expectedRevision}` |
| POST | `/api/decisions`, `/api/outcomes` | Record planning judgment or a reported actual observation |
| POST | `/api/chat` | Live consultation when enabled at startup |
| POST / DELETE | `/api/memory`, `/api/memory/:id` | Owner preference creation or deletion |
| POST | `/api/memory/:id/confirm` | Owner confirms proposed memory |
| POST | `/api/actions`, `/api/approvals/:id` | Request an exact handoff or record the owner's decision |

## MCP and host authority

The SDK-backed stdio server exposes role resources, one role prompt, and twelve bounded local tools. It validates strict schemas, limits frame size and call rate, and keeps protocol output free of CLI logs. [Exact tool contract and verified scope](HOST-INTEGRATION.md).

The MCP connection can propose memory and decisions and request handoffs. It exposes no owner confirmation, approval, arbitrary filesystem, shell, browser or external dispatch tool. The local API and CLI are owner interfaces; granting a host unrestricted shell access also grants that host access to these interfaces. These tool boundaries cannot protect against an independently overprivileged host.

A handoff digest binds its kind, summary, payload, mission and mission revision. Changed, superseded or already decided requests cannot be replayed. Spend payloads require a positive safe integer `amountMinor` and an uppercase currency code. An approved request records `executed:false`; no package code sends, books, pays or publishes.

Role exports provide instructions rather than permission enforcement. The host must enforce its own account access, spend limits, recipient checks, idempotency and receipts. The MCP transport and local work calls are tested with a real SDK client and CLI subprocess. Adoption of the role inside Hermes or OpenClaw, and consequential external execution, still require separate observed integration tests.
