# Contributing

Start with a real colleague's task, an inspectable artifact and a way to tell whether the result helped. Improvements to Mira's judgment, workflows and evaluation cases are as useful as code changes.

Run `npm ci --ignore-scripts`, `npm run check` and `npm test` before submitting. Tests must be deterministic and must not need credentials or paid services. Keep new runtime adapters conservative: cite a current primary-source interface, export to a new directory, preserve host rules and explain what has not been tested. For distribution changes, pack and run the clean package smoke described in [the release guide](docs/RELEASE.md).

Do not include attendee data, client information, credentials, private prompts or outputs without permission. Use fictional examples and label them. Role instructions must distinguish proposals from verified facts and completed actions. Add no unsupported performance scores, affiliations or invented human credentials.

Changes to external actions require code-enforced host authority, concrete review payloads, receipt handling, idempotency and failure tests. Prompt rules alone do not meet that requirement. New roles must satisfy [the role admission contract](docs/SERIES.md).

This independent project is MIT licensed. Retain applicable upstream notices if code is reused and disclose external service requirements. Open a focused [issue](https://github.com/rudycelekli/open-teammates/issues) or [pull request](https://github.com/rudycelekli/open-teammates/pulls).
