# Evaluate the teammate before claiming quality

Mira's reputation should come from retained outputs and independent review. This pack implements the eight fictional judgment cases in [QUALITY.md](QUALITY.md). It can plan a comparison without spending money, run an explicit case against a configured model, and summarize human reviews. It does not provide an automated creative, strategic, or factual grade. No live benchmark result is claimed by the repository.

## Inspect the fixed cases offline

From the package directory:

```sh
node bin/open-teammates.mjs eval list
node bin/open-teammates.mjs eval plan --out ./evaluation-plan
```

An offline plan writes all eight cases and two variants. It makes **zero provider requests**, including when provider credentials are configured. It does not create model responses or scores. Use a fresh output directory for each run; an existing manifest cannot be overwritten.

The fixed scenarios are global portfolio prioritization, a product-readiness deadline change, a 30% budget cut, VIP privacy, accessibility, a live streaming incident, executive pushback, and causal outcome interpretation. Their numerical facts and expected review evidence live in [the versioned JSON fixture](../evals/chief-of-events.json). The portfolio task selects whole candidate programs at the stated planning costs. The budget-cut task proposes allocations because no itemized quotes are supplied. All scenarios are fictional and describe no actual OpenAI event.

For each case, the plan creates `baseline/` and `mira/` directories containing:

- `request.json`: the provider payload, excluding authentication headers.
- `prompt.txt`: the common assignment, facts, and response contract.
- `system.txt`: the instructions used for that variant.
- `review-template.json`: empty human-score fields; null means unreviewed.

The run root contains `manifest.json` and a separate `grader-notes.json`. Grader notes, failure definitions, rubric anchors, and expected evidence are excluded from the model request. Facts and the required output schema are shared with the model; they are part of the assignment.

## Run one explicit live comparison

Configure the normal `OPEN_TEAMMATES_MODEL`, `OPEN_TEAMMATES_API_KEY`, and optional `OPEN_TEAMMATES_BASE_URL` environment variables. A localhost provider may omit the key. Then choose a case and a fresh output directory:

```sh
node bin/open-teammates.mjs eval run \
  --out ./evaluation-global-portfolio \
  --case global-portfolio \
  --live
```

A live run requires an explicit case and makes **two provider-request attempts**: one baseline and one Mira. There are no retries or automatic whole-suite paid runs. Each request permits up to 8,000 completion tokens. Run all eight cases separately only after inspecting the requests and choosing to incur the cost. This is 16 attempts for one complete comparative suite; repeat runs incur additional requests.

The baseline is a competent general assistant with minimal instructions to use facts, state assumptions, and explain a useful recommendation. Mira uses her loaded foundation, soul, operating instructions, and role skill. Both receive the same no-external-tools contract, identical user payload, empty owner preferences, model, provider, and completion settings. The environment and Mira's instructions are captured once before either request. There is no host integration or external event execution during this comparison.

The manifest records the package version, Node version, timestamps, fixture hash, system-prompt hashes, model, provider, exact request settings, attempts, and successes. Successful variants also save the exact `output.txt` and `result.json`, including token usage if supplied, duration, machine checks, and an explicitly unreviewed human assessment. Provider failures are saved as failures, without response bodies or credentials. Malformed model content is retained for review and fails structural checks; receiving text does not mean the case passed. Interrupted runs retain their partial manifest and require a fresh directory to retry.

Sampling uses provider defaults: no temperature or seed is set. Identical inputs do not guarantee identical outputs. Token counts are recorded when available; monetary cost remains null because neither current pricing nor actual billed cost is supplied. Compare a changed model, provider, package, prompt, or memory configuration as a changed system. A single sample per case is a pilot, not a statistically established ranking.

## What machines can check

The machine checks validate JSON types and, for the two budget cases, explicit structured arithmetic. They check nonnegative numerical amounts in the fixture currency, at most two decimal places, line sums, declared totals, and the cap. A cap exceeded by either line sum or declared total is a critical failure. The portfolio check also validates candidate names, whole quantities, fixed planning costs, and total quantities across repeated lines.

These checks do not interpret narrative recommendations, detect contradictory prose, verify quotes, confirm accessibility, judge strategy, recognize privacy violations, or establish causal outcomes. An invalid structured budget leaves its cap unassessed and requires a human to inspect the prose. A structurally valid response can still be irrelevant or unsafe. There is no keyword scoring: writing a reassuring phrase cannot earn a semantic grade.

## Independent human review

Choose the release gate before viewing outputs. The saved default comparative gate requires all eight cases and both variants, at least two independent human reviewers per saved output, complete 0–3 scores on every dimension, a mean of at least 2.5 for each case and variant, zero critical failures, and zero failed machine checks. This conservative gate qualifies the comparison as a whole; it is not evidence that Mira outperforms the baseline. Set any different threshold before running and retain the rationale. Do not lower it after seeing a failure.

Review the output and separate grader notes. Copy each `review-template.json` into an independently named review file and enter a reviewer identity, scores, critical failures if any, and notes explaining corrections or disagreements. The dimensions are:

| Dimension | Review question |
| --- | --- |
| `roleJudgment` | Is this the decision a strong events leader should propose under these facts? |
| `factualHonesty` | Are facts, assumptions, uncertainty, and claims of action represented accurately? |
| `operationalFeasibility` | Could accountable owners act on the proposed decisions and dependencies? |
| `attendeeExperience` | Does the plan meaningfully serve the audience, including stated access needs? |
| `outcomeReasoning` | Does it connect investment and design to defensible observations or hypotheses? |

Use the fixture's anchors: 0 is absent or dangerous, 1 is incomplete, 2 is useful with identifiable corrections, and 3 is ready for a qualified owner's review with assumptions explicit. Reviewers need relevant events, production, measurement, or privacy judgment. Different names in JSON do not establish independence; the evaluation owner must verify it. Where possible, score outputs with variant labels hidden and disclose the blind-review method.

The API turns a completed review into a record and recalculates the machine checks from the retained output. From the package directory:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { loadCases, evaluateResponse, summarizeReviews } from './src/evaluation.mjs';

const caseId = 'global-portfolio';
const variant = 'mira';
const directory = `./evaluation-global-portfolio/${caseId}/${variant}`;
const output = await readFile(`${directory}/output.txt`, 'utf8');
const review = JSON.parse(await readFile(`${directory}/review-alex.json`, 'utf8'));
const evaluationCase = (await loadCases()).find(item => item.id === caseId);
const record = evaluateResponse(evaluationCase, output, {
  variant,
  reviewer: review.reviewer,
  scores: review.scores,
  criticalFailures: review.criticalFailures,
  notes: review.notes,
});
await writeFile(`${directory}/review-alex.record.json`, JSON.stringify(record, null, 2));

// Collect both reviewers' records for both variants and all eight cases.
// For a case-only pilot, pass { expectedCaseIds: [caseId] } and label its scope.
const records = [record]; // Replace with the complete collected record set.
console.log(JSON.stringify(summarizeReviews(records), null, 2));
```

`evaluateResponse` never derives subjective scores from model prose. Missing scores, including fields left null, produce an incomplete review and no mean. A human review must name its reviewer and use valid dimensions, 0–3 integer scores or null while unreviewed, and case-specific failure identifiers. `summarizeReviews` rejects duplicate reviewers and groups scored against different outputs, publishes dimension-level disagreements, and leaves absent cases incomplete. Critical failures override even a perfect average. Preserve dissenting judgments rather than deleting them to obtain a passing score. Human-entered records are evidence of review, not cryptographic proof of reviewer identity or expertise.

Publish the fixtures, requests, package or commit, model and provider, retained outputs, complete review records, disagreements, failures, threshold, and scope together. Report factual findings such as “two reviewers rated these fictional outputs” with the actual record; do not translate a passed fictional suite into “autonomous world-class employee.” Supervised real event pilots, permissioned integrations, verified live facts, and observed delivery outcomes remain separate evidence requirements.

## Development verification

```sh
node --test test/evaluation.test.mjs
```

Tests use fictional, mocked providers without network requests or paid model calls. They verify fixed facts, grader isolation, exact baseline matching, explicit opt-in, request limits, arithmetic checks, failure retention, absent scores, reviewer completeness, and critical-failure precedence. A test pass proves evaluation plumbing; it provides no measurement of real model judgment.
