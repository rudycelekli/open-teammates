import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCases, listEvaluationCases, buildEvaluationRequest, evaluateResponse,
  summarizeReviews, runEvaluation, EVALUATION_CASE_IDS, EVALUATION_DIMENSIONS,
} from '../src/evaluation.mjs';

// Every provider request here is mocked; the suite incurs no model spend.
const localEnv = Object.freeze({ OPEN_TEAMMATES_BASE_URL: 'http://localhost:12345/v1', OPEN_TEAMMATES_MODEL: 'fictional-eval-model' });
const completeScores = score => Object.fromEntries(EVALUATION_DIMENSIONS.map(dimension => [dimension, score]));
const response = overrides => JSON.stringify({
  recommendation: 'Fictional proposal for qualified owner review.',
  tradeoffs: ['A decision requires more verified evidence.'],
  assumptions: ['This is a proposed plan.'],
  owners: [{ role: 'Events lead', decision: 'Review and choose a next step.' }],
  artifactsToRevise: ['Decision brief'],
  nextDecisiveStep: 'The events lead verifies the missing input before a commitment.',
  ...overrides,
});
const providerResponse = (content, { status = 200, finishReason = 'stop' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 30 } }),
});
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'open-teammates-eval-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('fixed evaluation suite has eight distinct judgment scenarios and anchored rubric', async () => {
  const cases = await loadCases();
  assert.deepEqual(cases.map(item => item.id), EVALUATION_CASE_IDS);
  assert.equal(new Set(cases.map(item => item.category)).size, 8);
  assert.equal(cases[0].facts.annualBudgetCap, 2400000);
  assert.equal(cases.find(item => item.id === 'budget-cut').facts.revisedCap, 336000);
  assert.equal(cases.find(item => item.id === 'causal-outcomes').facts.productActivationsWithin14Days, 35);
  for (const item of cases) {
    assert.deepEqual(item.rubric.dimensions, EVALUATION_DIMENSIONS);
    assert.deepEqual(Object.keys(item.rubric.scale), ['0', '1', '2', '3']);
    assert.ok(item.graderNotes.expectedEvidence.length >= 5);
    assert.ok(item.criticalFailures.length >= 3);
  }
  assert.deepEqual(await listEvaluationCases(), cases.map(({ id, title, category }) => ({ id, title, category })));
  cases[0].facts.annualBudgetCap = 1;
  assert.equal((await loadCases())[0].facts.annualBudgetCap, 2400000);
});

test('baseline and Mira receive identical facts and prompts with no grading leakage', async () => {
  for (const original of await loadCases()) {
    const item = structuredClone(original);
    item.graderNotes = { expectedEvidence: ['SECRET-GRADER-NOTE'], scoringNotes: 'SECRET-SCORING-NOTE' };
    item.rubric = { dimensions: ['SECRET-DIMENSION'] };
    item.criticalFailures = [{ id: 'SECRET-FAILURE-ID', description: 'SECRET-FAILURE-DESCRIPTION' }];
    const baseline = buildEvaluationRequest(item, { variant: 'baseline' });
    const mira = buildEvaluationRequest(item, { variant: 'mira' });
    assert.equal(baseline.prompt, mira.prompt);
    assert.deepEqual(baseline.mission, mira.mission);
    assert.equal(baseline.metadata.promptSha256, mira.metadata.promptSha256);
    assert.equal(JSON.stringify(mira).includes('SECRET-'), false);
    assert.deepEqual(JSON.parse(mira.prompt).facts, item.facts);
  }
  assert.throws(() => buildEvaluationRequest(({}), { variant: 'invented' }), /mira or baseline/);
});

test('output recording does not invent human scores or semantic grades', async () => {
  const item = (await loadCases()).find(item => item.id === 'accessibility');
  const assessed = evaluateResponse(item, response());
  assert.equal(assessed.humanReview.status, 'unreviewed');
  assert.equal(assessed.humanReview.scores, null);
  assert.equal(assessed.humanReview.meanScore, null);
  assert.ok(assessed.machineChecks.checks.every(check => check.status === 'pass'));
  // Valid types pass even when prose is irrelevant; relevance is a human judgment.
  const irrelevant = evaluateResponse(item, response({ recommendation: 'Purple clocks.', nextDecisiveStep: 'Blue moon.' }));
  assert.ok(irrelevant.machineChecks.checks.every(check => check.status === 'pass'));
  assert.equal(irrelevant.humanReview.meanScore, null);
  assert.match(irrelevant.machineChecks.scope, /no semantic judgment/);
});

test('invalid JSON and missing fields are structural failures, with no inferred semantic critical failure', async () => {
  const item = (await loadCases()).find(item => item.id === 'budget-cut');
  const invalid = evaluateResponse(item, 'Not JSON');
  assert.equal(invalid.machineChecks.checks[0].status, 'fail');
  assert.equal(invalid.machineChecks.checks.find(check => check.id === 'budget-arithmetic').status, 'not_checked');
  assert.deepEqual(invalid.machineChecks.criticalFailures, []);
  const missing = evaluateResponse(item, '{}');
  assert.equal(missing.machineChecks.checks.find(check => check.id === 'response-contract').status, 'fail');
  assert.equal(missing.machineChecks.checks.find(check => check.id === 'budget-cap').status, 'not_checked');
});

test('explicit budget arithmetic checks sums, cap, currency, numeric amounts, and precision', async t => {
  const item = (await loadCases()).find(item => item.id === 'budget-cut');
  const within = { currency: 'USD', lines: [{ name: 'Proposed production', amount: 300000 }, { name: 'Reserve', amount: 36000 }], total: 336000 };
  assert.ok(evaluateResponse(item, response({ budget: within })).machineChecks.checks.every(check => check.status === 'pass'));
  for (const [name, budget] of Object.entries({
    'over cap': { ...within, total: 337000, lines: [{ name: 'Production', amount: 337000 }] },
    'line sum over cap with false total': { ...within, lines: [{ name: 'Production', amount: 337000 }] },
    'wrong sum': { ...within, total: 320000 },
    'wrong currency': { ...within, currency: 'EUR' },
    'amount string': { ...within, lines: [{ name: 'Production', amount: '336000' }] },
    'negative amount': { ...within, lines: [{ name: 'Production', amount: -1 }] },
    'sub-cent amount': { ...within, lines: [{ name: 'Production', amount: 335999.999 }], total: 335999.999 },
  })) {
    await t.test(name, () => {
      const evaluated = evaluateResponse(item, response({ budget }));
      assert.ok(evaluated.machineChecks.checks.some(check => check.status === 'fail'));
      assert.equal(evaluated.machineChecks.criticalFailures.includes('budget-exceeds-cap'), name.includes('over cap'));
    });
  }
});

test('portfolio cost check rejects changed costs, unknown programs, and repeated quantities above fixture availability', async t => {
  const item = (await loadCases()).find(item => item.id === 'global-portfolio');
  const budget = { currency: 'USD', lines: [{ name: 'Developer flagship', units: 1, amount: 1200000 }, { name: 'Regional gathering', units: 3, amount: 660000 }, { name: 'Reserve', amount: 540000 }], total: 2400000 };
  assert.ok(evaluateResponse(item, response({ budget })).machineChecks.checks.every(check => check.status === 'pass'));
  for (const [name, lines] of Object.entries({
    'changed cost': [{ name: 'Developer flagship', units: 1, amount: 1 }],
    'unknown program': [{ name: 'Unlisted program', units: 1, amount: 100 }],
    'too many repeated units': [{ name: 'Regional gathering', units: 2, amount: 440000 }, { name: 'Regional gathering', units: 2, amount: 440000 }],
    'fractional quantity': [{ name: 'Developer flagship', units: 0.5, amount: 600000 }],
  })) {
    await t.test(name, () => {
      const evaluated = evaluateResponse(item, response({ budget: { currency: 'USD', lines, total: lines.reduce((sum, line) => sum + line.amount, 0) } }));
      assert.equal(evaluated.machineChecks.checks.find(check => check.id === 'portfolio-costs').status, 'fail');
    });
  }
});

test('human review is explicit, validates dimensions, and keeps missing scores incomplete', async () => {
  const item = (await loadCases()).find(item => item.id === 'accessibility');
  const incomplete = evaluateResponse(item, response(), { reviewer: 'Fictional reviewer A', scores: { roleJudgment: 3 } });
  assert.equal(incomplete.humanReview.status, 'incomplete');
  assert.equal(incomplete.humanReview.meanScore, null);
  const partiallyFilledTemplate = evaluateResponse(item, response(), { reviewer: 'Fictional reviewer A', scores: { ...completeScores(3), factualHonesty: null } });
  assert.equal(partiallyFilledTemplate.humanReview.status, 'incomplete');
  assert.equal(partiallyFilledTemplate.humanReview.meanScore, null);
  const complete = evaluateResponse(item, response(), { reviewer: 'Fictional reviewer A', scores: completeScores(2), notes: 'Needs concrete verification owners.' });
  assert.equal(complete.humanReview.status, 'reviewed');
  assert.equal(complete.humanReview.meanScore, 2);
  assert.throws(() => evaluateResponse(item, response(), { scores: completeScores(3) }), /name its reviewer/);
  assert.throws(() => evaluateResponse(item, response(), { reviewer: 'A', scores: { roleJudgment: 4 } }), /integer from 0 to 3/);
  assert.throws(() => evaluateResponse(item, response(), { reviewer: 'A', scores: { inventedDimension: 3 } }), /rubric dimension/);
  assert.throws(() => evaluateResponse(item, response(), { reviewer: 'A', criticalFailures: ['invented-id'] }), /Unknown critical failure/);
});

test('release summary needs two independent reviewers and full scores, and publishes disagreements', async () => {
  const item = (await loadCases()).find(item => item.id === 'accessibility');
  const records = ['baseline', 'mira'].flatMap(variant => ['A', 'B'].map(reviewer => evaluateResponse(item, response(), { variant, reviewer, scores: completeScores(reviewer === 'A' ? 3 : 2) })));
  const options = { expectedCaseIds: [item.id], threshold: 2.5 };
  const complete = summarizeReviews(records, options);
  assert.equal(complete.status, 'passed');
  assert.equal(complete.groups[0].meanScore, 2.5);
  assert.deepEqual(complete.groups[0].dimensions.roleJudgment.scores, [{ reviewer: 'A', score: 3 }, { reviewer: 'B', score: 2 }]);
  assert.equal(summarizeReviews(records.slice(0, 3), options).status, 'incomplete');
  assert.equal(summarizeReviews([...records, records[0]], options).status, 'incomplete');
  const incomplete = [...records];
  incomplete[0] = evaluateResponse(item, response(), { variant: 'baseline', reviewer: 'A', scores: { roleJudgment: 3 } });
  assert.equal(summarizeReviews(incomplete, options).status, 'incomplete');
  assert.equal(summarizeReviews(records).status, 'incomplete');
  assert.throws(() => summarizeReviews(records, { ...options, minimumReviewers: 1 }), /Invalid review summary/);
});

test('critical failures override perfect mean scores; machine cap failures also fail the gate', async () => {
  const item = (await loadCases()).find(item => item.id === 'accessibility');
  const records = ['baseline', 'mira'].flatMap(variant => ['A', 'B'].map(reviewer => evaluateResponse(item, response(), { variant, reviewer, scores: completeScores(3), criticalFailures: variant === 'mira' && reviewer === 'B' ? ['ignored-safety-or-access'] : [] })));
  const summary = summarizeReviews(records, { expectedCaseIds: [item.id] });
  assert.equal(summary.status, 'failed');
  assert.equal(summary.groups[1].meanScore, 3);
  assert.ok(summary.failures.some(failure => failure.criticalFailure === 'ignored-safety-or-access'));
  const budgetCase = (await loadCases()).find(item => item.id === 'budget-cut');
  const budgetRecords = ['baseline', 'mira'].flatMap(variant => ['A', 'B'].map(reviewer => evaluateResponse(budgetCase, response({ budget: { currency: 'USD', lines: [{ name: 'Production', amount: 400000 }], total: 400000 } }), { variant, reviewer, scores: completeScores(3) })));
  assert.equal(summarizeReviews(budgetRecords, { expectedCaseIds: [budgetCase.id] }).status, 'failed');
});

test('reviews of different saved outputs cannot satisfy a single comparison group', async () => {
  const item = (await loadCases()).find(item => item.id === 'accessibility');
  const records = ['baseline', 'mira'].flatMap(variant => ['A', 'B'].map(reviewer => evaluateResponse(item, response({ recommendation: reviewer }), { variant, reviewer, scores: completeScores(3) })));
  const summary = summarizeReviews(records, { expectedCaseIds: [item.id] });
  assert.equal(summary.status, 'incomplete');
  assert.ok(summary.incomplete.some(item => item.reason.includes('different outputs')));
});

test('complete numerical scores cannot bypass absent retained-output identity and machine evidence', () => {
  const fabricated = EVALUATION_CASE_IDS.flatMap(caseId => ['baseline', 'mira'].flatMap(variant => ['A', 'B'].map(reviewer => ({
    caseId, variant,
    machineChecks: { checks: [] },
    humanReview: { status: 'reviewed', reviewer, scores: completeScores(3), criticalFailures: [] },
  }))));
  const summary = summarizeReviews(fabricated);
  assert.equal(summary.status, 'incomplete');
  assert.ok(summary.incomplete.some(item => item.reason.includes('SHA-256')));
  assert.ok(summary.incomplete.some(item => item.reason.includes('json-response')));
  assert.ok(summary.incomplete.some(item => item.reason.includes('budget-cap')));
  assert.ok(summary.incomplete.some(item => item.reason.includes('portfolio-costs')));
  assert.throws(() => summarizeReviews([], { expectedCaseIds: [] }), /Invalid review summary/);
  assert.throws(() => summarizeReviews([], { expectedCaseIds: ['invented-case'] }), /Invalid review summary/);
  assert.throws(() => summarizeReviews([], { expectedCaseIds: ['accessibility', 'accessibility'] }), /Invalid review summary/);
});

test('a missing or malformed output hash keeps otherwise complete reviews incomplete', async () => {
  const item = (await loadCases()).find(item => item.id === 'accessibility');
  const records = ['baseline', 'mira'].flatMap(variant => ['A', 'B'].map(reviewer => evaluateResponse(item, response(), { variant, reviewer, scores: completeScores(3) })));
  const options = { expectedCaseIds: [item.id] };
  assert.equal(summarizeReviews(records, options).status, 'passed');
  for (const hash of [undefined, null, '', 'unretained-output', 'a'.repeat(63), 'g'.repeat(64)]) {
    const incomplete = structuredClone(records);
    incomplete[0].responseSha256 = hash;
    assert.equal(summarizeReviews(incomplete, options).status, 'incomplete');
  }
});

test('required JSON and case-specific budget checks cannot be omitted, duplicated, or left unassessed', async t => {
  const cases = await loadCases();
  for (const [caseId, omitted] of [
    ['accessibility', 'json-response'], ['accessibility', 'response-contract'],
    ['budget-cut', 'budget-arithmetic'], ['budget-cut', 'budget-cap'],
    ['global-portfolio', 'portfolio-costs'],
  ]) {
    await t.test(`${caseId}: ${omitted}`, () => {
      const item = cases.find(item => item.id === caseId);
      const budget = caseId === 'global-portfolio'
        ? { currency: 'USD', lines: [{ name: 'Developer flagship', units: 1, amount: 1200000 }, { name: 'Reserve', amount: 1200000 }], total: 2400000 }
        : { currency: 'USD', lines: [{ name: 'Proposed production', amount: 300000 }, { name: 'Reserve', amount: 36000 }], total: 336000 };
      const records = ['baseline', 'mira'].flatMap(variant => ['A', 'B'].map(reviewer => evaluateResponse(item, response(item.machineConstraints.requireBudget ? { budget } : {}), { variant, reviewer, scores: completeScores(3) })));
      const options = { expectedCaseIds: [item.id] };
      assert.equal(summarizeReviews(records, options).status, 'passed');
      const missing = structuredClone(records);
      missing[0].machineChecks.checks = missing[0].machineChecks.checks.filter(check => check.id !== omitted);
      assert.equal(summarizeReviews(missing, options).status, 'incomplete');
      const duplicate = structuredClone(records);
      duplicate[0].machineChecks.checks.push(structuredClone(duplicate[0].machineChecks.checks.find(check => check.id === omitted)));
      assert.equal(summarizeReviews(duplicate, options).status, 'incomplete');
      const unassessed = structuredClone(records);
      unassessed[0].machineChecks.checks.find(check => check.id === omitted).status = 'not_checked';
      assert.equal(summarizeReviews(unassessed, options).status, 'incomplete');
    });
  }
});

test('offline plan writes reproducible requests and separate grading notes without a request or score', async t => {
  const directory = await workspace(t);
  let requests = 0;
  const manifest = await runEvaluation({ out: directory, env: localEnv, fetchImpl: () => { requests++; throw new Error('Must stay offline'); } });
  assert.equal(requests, 0);
  assert.equal(manifest.mode, 'plan');
  assert.equal(manifest.status, 'plan_ready');
  assert.equal(manifest.plannedProviderRequests, 0);
  assert.equal(manifest.attemptedProviderRequests, 0);
  assert.equal(manifest.evaluationStatus, 'unreviewed');
  assert.deepEqual(manifest.caseIds, EVALUATION_CASE_IDS);
  assert.deepEqual(manifest.results, []);
  const baseline = JSON.parse(await readFile(join(directory, 'global-portfolio', 'baseline', 'request.json'), 'utf8'));
  const mira = JSON.parse(await readFile(join(directory, 'global-portfolio', 'mira', 'request.json'), 'utf8'));
  assert.equal(baseline.messages[1].content, mira.messages[1].content);
  assert.notEqual(baseline.messages[0].content, mira.messages[0].content);
  assert.equal(mira.messages[1].content.includes('scoringNotes'), false);
  assert.equal(mira.messages[1].content.includes('expectedEvidence'), false);
  assert.equal(mira.messages[1].content.includes('criticalFailures'), false);
  assert.equal(JSON.parse(await readFile(join(directory, 'grader-notes.json'), 'utf8')).length, 8);
  assert.equal((await readdir(join(directory, 'global-portfolio', 'mira'))).includes('output.txt'), false);
  const review = JSON.parse(await readFile(join(directory, 'global-portfolio', 'mira', 'review-template.json'), 'utf8'));
  assert.ok(Object.values(review.scores).every(score => score === null));
  await assert.rejects(runEvaluation({ out: directory }), /never overwritten/);
});

test('live evaluation requires explicit live flag, one valid case, and ready configuration before a provider call', async t => {
  const directory = await workspace(t);
  let requests = 0;
  const options = { out: directory, fetchImpl: () => { requests++; throw new Error('Must not call'); } };
  await assert.rejects(runEvaluation({ ...options, live: true, env: localEnv }), /two provider requests/);
  await assert.rejects(runEvaluation({ ...options, live: true, caseId: 'invented', env: localEnv }), /Unknown evaluation case/);
  await assert.rejects(runEvaluation({ ...options, live: true, caseId: 'accessibility', env: {} }), /No provider request was made/);
  assert.equal(requests, 0);
  const planned = await runEvaluation({ ...options, caseId: 'accessibility', env: localEnv });
  assert.deepEqual(planned.caseIds, ['accessibility']);
  assert.equal(requests, 0);
});

test('live comparison makes exactly two matched requests and records outputs, usage, timing, and unreviewed scores', async t => {
  const directory = await workspace(t);
  const env = { ...localEnv, OPEN_TEAMMATES_API_KEY: 'fictional-secret' };
  const observed = [];
  const manifest = await runEvaluation({
    out: directory, live: true, caseId: 'accessibility', env,
    fetchImpl: async (url, options) => {
      observed.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization });
      // Mutation between calls cannot change the matched provider configuration.
      env.OPEN_TEAMMATES_MODEL = 'changed-model';
      env.OPEN_TEAMMATES_BASE_URL = 'http://localhost:7777/v1';
      return providerResponse(response());
    },
  });
  assert.equal(observed.length, 2);
  assert.equal(observed[0].url, observed[1].url);
  assert.equal(observed[0].authorization, observed[1].authorization);
  assert.equal(observed[0].body.model, observed[1].body.model);
  assert.equal(observed[0].body.model, 'fictional-eval-model');
  assert.equal(observed[0].body.messages[1].content, observed[1].body.messages[1].content);
  assert.notEqual(observed[0].body.messages[0].content, observed[1].body.messages[0].content);
  assert.equal(observed[0].body.max_completion_tokens, observed[1].body.max_completion_tokens);
  assert.deepEqual(observed[0].body.response_format, observed[1].body.response_format);
  assert.equal(manifest.status, 'outputs_recorded');
  assert.equal(manifest.attemptedProviderRequests, 2);
  assert.equal(manifest.successfulProviderRequests, 2);
  assert.equal(manifest.evaluationStatus, 'unreviewed');
  assert.equal(manifest.results[0].promptSha256, manifest.results[1].promptSha256);
  for (const result of manifest.results) {
    assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 30 });
    assert.ok(result.durationMs >= 0);
    assert.equal(result.cost, null);
    assert.equal(result.humanReview.meanScore, null);
    assert.equal(result.humanReview.scores, null);
  }
  const saved = await readFile(join(directory, 'manifest.json'), 'utf8');
  assert.equal(saved.includes('fictional-secret'), false);
  assert.equal(saved.includes('Authorization'), false);
  const savedRequest = JSON.parse(await readFile(join(directory, 'accessibility', 'baseline', 'request.json'), 'utf8'));
  assert.deepEqual(savedRequest, observed[0].body);
  assert.equal(await readFile(join(directory, 'accessibility', 'mira', 'output.txt'), 'utf8'), response());
});

test('provider failures are retained without retries, fabricated scores, secrets, or error bodies', async t => {
  const directory = await workspace(t);
  const secret = 'fictional-secret-never-save';
  let requests = 0;
  const manifest = await runEvaluation({
    out: directory, live: true, caseId: 'accessibility', env: { ...localEnv, OPEN_TEAMMATES_API_KEY: secret },
    fetchImpl: async () => {
      requests++;
      if (requests === 1) throw new Error(`Network said ${secret} and provider body`);
      return { ok: false, status: 429, text: async () => { throw new Error('Error bodies must not be read'); } };
    },
  });
  assert.equal(requests, 2);
  assert.equal(manifest.status, 'completed_with_errors');
  assert.equal(manifest.attemptedProviderRequests, 2);
  assert.equal(manifest.successfulProviderRequests, 0);
  assert.equal(manifest.results[0].error.code, 'request_failed');
  assert.equal(manifest.results[1].error.code, 'provider_http');
  assert.ok(manifest.results.every(result => result.usage === null && result.humanReview.scores === null));
  const saved = await readFile(join(directory, 'manifest.json'), 'utf8');
  assert.equal(saved.includes(secret), false);
  assert.equal(saved.includes('Network said'), false);
  for (const variant of ['baseline', 'mira']) assert.equal((await readdir(join(directory, 'accessibility', variant))).includes('output.txt'), false);
});

test('malformed model content is retained as evidence with failing machine checks and no semantic grade', async t => {
  const directory = await workspace(t);
  const manifest = await runEvaluation({ out: directory, live: true, caseId: 'accessibility', env: localEnv, fetchImpl: async () => providerResponse('This is not JSON') });
  assert.equal(manifest.successfulProviderRequests, 2);
  assert.equal(manifest.status, 'outputs_recorded');
  assert.ok(manifest.results.every(result => result.machineChecks.checks[0].status === 'fail'));
  assert.ok(manifest.results.every(result => result.humanReview.meanScore === null));
  assert.equal(await readFile(join(directory, 'accessibility', 'mira', 'output.txt'), 'utf8'), 'This is not JSON');
});
