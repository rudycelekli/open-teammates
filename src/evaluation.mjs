import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { callModel, modelConfig } from './model.mjs';
import { loadRole, packageRoot, systemPrompt } from './role.mjs';

export const EVALUATION_CASE_IDS = Object.freeze([
  'global-portfolio', 'launch-deadline', 'budget-cut', 'vip-privacy',
  'accessibility', 'production-incident', 'executive-pushback', 'causal-outcomes',
]);
export const EVALUATION_DIMENSIONS = Object.freeze([
  'roleJudgment', 'factualHonesty', 'operationalFeasibility', 'attendeeExperience', 'outcomeReasoning',
]);
const variants = ['baseline', 'mira'];
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validOutputHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requiredMachineChecks(caseId) {
  const required = ['json-response', 'response-contract'];
  if (['global-portfolio', 'budget-cut'].includes(caseId)) required.push('budget-arithmetic', 'budget-cap');
  if (caseId === 'global-portfolio') required.push('portfolio-costs');
  return required;
}
const baselineRole = Object.freeze({
  foundation: 'You are a competent general-purpose assistant.',
  soul: 'Provide a useful response to the assignment.',
  instructions: 'Explain your recommendation clearly.',
  skill: 'Use the supplied facts and state assumptions.',
});
const responseContract = {
  recommendation: 'string',
  tradeoffs: ['string'],
  assumptions: ['string'],
  owners: [{ role: 'accountable functional role', decision: 'specific decision or deliverable' }],
  artifactsToRevise: ['string'],
  nextDecisiveStep: 'string',
};

export async function loadCases() {
  const fixture = JSON.parse(await readFile(new URL('evals/chief-of-events.json', packageRoot), 'utf8'));
  if (fixture.schemaVersion !== 1 || fixture.fictional !== true || !Array.isArray(fixture.cases)
      || JSON.stringify(fixture.cases.map(item => item.id)) !== JSON.stringify(EVALUATION_CASE_IDS)
      || JSON.stringify(fixture.rubric?.dimensions) !== JSON.stringify(EVALUATION_DIMENSIONS)) {
    throw new Error('Evaluation fixture does not match the fixed eight-case suite.');
  }
  for (const item of fixture.cases) {
    if (!nonempty(item.title) || !nonempty(item.category) || !isObject(item.facts)
        || !nonempty(item.assignment) || !isObject(item.machineConstraints)
        || !Array.isArray(item.criticalFailures) || !isObject(item.graderNotes)
        || !item.criticalFailures.every(failure => /^[a-z][a-z0-9-]+$/.test(failure.id) && nonempty(failure.description))) {
      throw new Error(`Invalid evaluation fixture: ${item.id}.`);
    }
  }
  return fixture.cases.map(item => ({ ...item, rubric: structuredClone(fixture.rubric), suite: fixture.suite, schemaVersion: fixture.schemaVersion }));
}

export async function listEvaluationCases() {
  return (await loadCases()).map(({ id, title, category }) => ({ id, title, category }));
}

// Only this explicit allowlist enters the model request. Grader notes, failure
// definitions, rubric anchors, and reviewer expectations never enter it.
export function buildEvaluationRequest(evaluationCase, { variant = 'mira' } = {}) {
  if (!variants.includes(variant)) throw new Error('Evaluation variant must be mira or baseline.');
  const budgetContract = evaluationCase.machineConstraints?.requireBudget ? {
    budget: {
      currency: evaluationCase.machineConstraints.currency,
      lines: [{ name: 'allocation name; use exact candidate program names for a portfolio, or Reserve', amount: 'nonnegative number in major currency units', ...(evaluationCase.machineConstraints.candidateProgramsOnly ? { units: 'whole quantity; omit for Reserve' } : {}) }],
      total: 'number equal to the sum of all line amounts, including any reserve',
    },
  } : {};
  const prompt = JSON.stringify({
    caseId: evaluationCase.id,
    title: evaluationCase.title,
    fictional: true,
    facts: evaluationCase.facts,
    assignment: evaluationCase.assignment,
    outputInstructions: 'Return one JSON object following this contract. Arrays may be empty when there is nothing applicable. Budget allocations are proposals unless the facts confirm them. Include any other useful event artifacts in an optional artifacts field. No real-world action is available.',
    responseContract: { ...responseContract, ...budgetContract },
  }, null, 2);
  return {
    variant,
    prompt,
    mission: { id: evaluationCase.id, name: evaluationCase.title, fictional: true, facts: structuredClone(evaluationCase.facts) },
    metadata: { caseId: evaluationCase.id, title: evaluationCase.title, category: evaluationCase.category, suite: evaluationCase.suite, promptSha256: digest(prompt) },
  };
}

function inspectResponse(evaluationCase, response) {
  const checks = [];
  const criticalFailures = [];
  const check = (id, status, evidence) => checks.push({ id, status, evidence });
  let data;
  try { data = typeof response === 'string' ? JSON.parse(response) : structuredClone(response); }
  catch { check('json-response', 'fail', 'Output is not a JSON object.'); }
  if (!isObject(data)) {
    if (!checks.length) check('json-response', 'fail', 'Output is not a JSON object.');
    check('response-contract', 'not_checked', 'No parsed object available.');
    if (evaluationCase.machineConstraints?.requireBudget) check('budget-arithmetic', 'not_checked', 'No parsed budget available.');
    return { checks, criticalFailures };
  }
  check('json-response', 'pass', 'Output parses as a JSON object.');
  const stringArrays = ['tradeoffs', 'assumptions', 'artifactsToRevise'];
  const schemaValid = nonempty(data.recommendation) && nonempty(data.nextDecisiveStep)
    && stringArrays.every(key => Array.isArray(data[key]) && data[key].every(nonempty))
    && Array.isArray(data.owners) && data.owners.every(owner => isObject(owner) && nonempty(owner.role) && nonempty(owner.decision));
  check('response-contract', schemaValid ? 'pass' : 'fail', schemaValid ? 'Required fields have the requested types. Content quality is not checked.' : 'A required field is absent or has an invalid type.');
  const constraints = evaluationCase.machineConstraints ?? {};
  if (!constraints.requireBudget) return { checks, criticalFailures };
  const budget = data.budget;
  const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
  const validBudget = isObject(budget) && budget.currency === constraints.currency && money(budget.total)
    && Array.isArray(budget.lines) && budget.lines.length > 0
    && budget.lines.every(line => isObject(line) && nonempty(line.name) && money(line.amount));
  if (!validBudget) {
    check('budget-arithmetic', 'fail', 'Budget needs the fixture currency, nonnegative amounts with at most two decimal places, nonempty lines, and a total.');
    check('budget-cap', 'not_checked', 'A valid structured budget was not supplied. A human must assess the prose.');
    return { checks, criticalFailures };
  }
  const sumMinor = budget.lines.reduce((sum, line) => sum + BigInt(Math.round(line.amount * 100)), 0n);
  const declaredMinor = BigInt(Math.round(budget.total * 100));
  const capMinor = BigInt(Math.round(constraints.budgetCap * 100));
  const reconciled = sumMinor === declaredMinor;
  check('budget-arithmetic', reconciled ? 'pass' : 'fail', `Line sum: ${sumMinor} minor units; declared total: ${declaredMinor} minor units.`);
  const withinCap = sumMinor <= capMinor && declaredMinor <= capMinor;
  check('budget-cap', withinCap ? 'pass' : 'fail', `Cap: ${constraints.budgetCap} ${constraints.currency}; line sum and declared total must both remain within it.`);
  if (!withinCap) criticalFailures.push('budget-exceeds-cap');
  if (constraints.candidateProgramsOnly) {
    const programs = new Map(evaluationCase.facts.candidatePrograms.map(program => [program.name, program]));
    const counts = new Map();
    let validPortfolio = true;
    for (const line of budget.lines) {
      if (line.name === 'Reserve') continue;
      const program = programs.get(line.name);
      if (!program || !Number.isSafeInteger(line.units) || line.units < 1 || Math.round(line.amount * 100) !== line.units * program.unitCost * 100) { validPortfolio = false; continue; }
      counts.set(line.name, (counts.get(line.name) ?? 0) + line.units);
      if (counts.get(line.name) > program.quantity) validPortfolio = false;
    }
    check('portfolio-costs', validPortfolio ? 'pass' : 'fail', validPortfolio ? 'Selections use whole candidate programs at fixture planning costs, within available quantities.' : 'Selection names, units, costs, or aggregate quantities differ from the fixed candidates.');
  }
  return { checks, criticalFailures };
}

export function evaluateResponse(evaluationCase, response, { variant = 'mira', reviewer, scores, criticalFailures = [], notes = '' } = {}) {
  if (!variants.includes(variant)) throw new Error('Evaluation variant must be mira or baseline.');
  if (scores !== undefined && !isObject(scores)) throw new Error('Review scores must be an object keyed by rubric dimension.');
  if (!Array.isArray(criticalFailures)) throw new Error('Review criticalFailures must be an array.');
  const allowedFailures = new Set(evaluationCase.criticalFailures.map(item => item.id));
  if (!criticalFailures.every(failure => allowedFailures.has(failure))) throw new Error('Unknown critical failure for this case.');
  if (scores && !Object.entries(scores).every(([dimension, score]) => EVALUATION_DIMENSIONS.includes(dimension) && (score === null || Number.isInteger(score) && score >= 0 && score <= 3))) throw new Error('Each supplied score must use a rubric dimension and an integer from 0 to 3, or null while unreviewed.');
  const suppliedReview = reviewer !== undefined || scores !== undefined || criticalFailures.length > 0 || notes !== '';
  if (suppliedReview && !nonempty(reviewer)) throw new Error('A human review must name its reviewer.');
  if (typeof notes !== 'string') throw new Error('Review notes must be text.');
  const complete = suppliedReview && EVALUATION_DIMENSIONS.every(dimension => Number.isInteger(scores?.[dimension]));
  const inspected = inspectResponse(evaluationCase, response);
  return {
    caseId: evaluationCase.id,
    variant,
    responseSha256: digest(response),
    machineChecks: {
      scope: 'JSON types and explicit structured budget arithmetic only; no semantic judgment, truth verification, privacy inference, or production readiness assessment.',
      ...inspected,
    },
    humanReview: {
      status: suppliedReview ? complete ? 'reviewed' : 'incomplete' : 'unreviewed',
      reviewer: suppliedReview ? reviewer.trim() : null,
      scores: scores ? structuredClone(scores) : null,
      criticalFailures: [...new Set(criticalFailures)],
      notes: suppliedReview ? notes : null,
      meanScore: complete ? EVALUATION_DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension], 0) / EVALUATION_DIMENSIONS.length : null,
    },
  };
}

export function summarizeReviews(records, { expectedCaseIds = EVALUATION_CASE_IDS, minimumReviewers = 2, threshold = 2.5 } = {}) {
  if (!Array.isArray(records) || !Array.isArray(expectedCaseIds) || !expectedCaseIds.length
      || new Set(expectedCaseIds).size !== expectedCaseIds.length || expectedCaseIds.some(id => !EVALUATION_CASE_IDS.includes(id))
      || !Number.isInteger(minimumReviewers) || minimumReviewers < 2 || typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 3) throw new Error('Invalid review summary or release gate.');
  const failures = [];
  const incomplete = [];
  const groups = [];
  const expected = new Set(expectedCaseIds);
  for (const record of records) {
    if (!isObject(record) || !expected.has(record.caseId) || !variants.includes(record.variant) || !isObject(record.machineChecks) || !Array.isArray(record.machineChecks.checks) || !isObject(record.humanReview)) throw new Error('Review record does not belong to this evaluation gate.');
    const evidenceGap = reason => incomplete.push({ caseId: record.caseId, variant: record.variant, reviewer: record.humanReview.reviewer ?? null, reason });
    if (!validOutputHash(record.responseSha256)) evidenceGap('Missing a valid SHA-256 identity for the retained output.');
    if (!nonempty(record.machineChecks.scope)) evidenceGap('Missing the machine-check scope.');
    const required = requiredMachineChecks(record.caseId);
    const checks = record.machineChecks.checks;
    if (checks.some(check => !isObject(check) || !required.includes(check.id) || !['pass', 'fail', 'not_checked'].includes(check.status) || !nonempty(check.evidence))) evidenceGap('Machine-check entries must use the case-specific IDs, valid statuses, and explicit evidence.');
    for (const id of required) {
      const entries = checks.filter(check => isObject(check) && check.id === id);
      if (entries.length !== 1) evidenceGap(`Required machine check ${id} must occur exactly once.`);
      else if (entries[0].status === 'not_checked') evidenceGap(`Required machine check ${id} has not been assessed.`);
    }
    for (const source of ['machineChecks', 'humanReview']) {
      if (!Array.isArray(record[source].criticalFailures) || record[source].criticalFailures.some(failure => !nonempty(failure))) evidenceGap(`${source} must include an explicit criticalFailures array.`);
      else for (const failure of record[source].criticalFailures) failures.push({ caseId: record.caseId, variant: record.variant, reviewer: record.humanReview.reviewer, criticalFailure: failure });
    }
    for (const check of checks.filter(check => isObject(check) && check.status === 'fail')) failures.push({ caseId: record.caseId, variant: record.variant, machineCheck: check.id });
  }
  for (const caseId of expectedCaseIds) {
    for (const variant of variants) {
      const selected = records.filter(record => record.caseId === caseId && record.variant === variant);
      const reviewed = selected.filter(record => record.humanReview.status === 'reviewed'
        && nonempty(record.humanReview.reviewer)
        && EVALUATION_DIMENSIONS.every(dimension => Number.isInteger(record.humanReview.scores?.[dimension]) && record.humanReview.scores[dimension] >= 0 && record.humanReview.scores[dimension] <= 3));
      const unique = new Map();
      for (const record of reviewed) {
        if (unique.has(record.humanReview.reviewer)) incomplete.push({ caseId, variant, reason: `Duplicate reviewer: ${record.humanReview.reviewer}.` });
        else unique.set(record.humanReview.reviewer, record);
      }
      if (selected.some(record => !reviewed.includes(record))) incomplete.push({ caseId, variant, reason: 'At least one supplied record has missing human scores.' });
      if (unique.size < minimumReviewers) incomplete.push({ caseId, variant, reason: `Needs ${minimumReviewers} independent human reviewers; has ${unique.size}.` });
      if (new Set(selected.map(record => record.responseSha256)).size > 1) incomplete.push({ caseId, variant, reason: 'Reviewers scored different outputs; group reviews of an identical saved output.' });
      const reviews = [...unique.values()];
      const meanScore = reviews.length ? reviews.reduce((sum, record) => sum + EVALUATION_DIMENSIONS.reduce((subtotal, dimension) => subtotal + record.humanReview.scores[dimension], 0), 0) / (reviews.length * EVALUATION_DIMENSIONS.length) : null;
      const dimensions = Object.fromEntries(EVALUATION_DIMENSIONS.map(dimension => [dimension, {
        mean: reviews.length ? reviews.reduce((sum, record) => sum + record.humanReview.scores[dimension], 0) / reviews.length : null,
        scores: reviews.map(record => ({ reviewer: record.humanReview.reviewer, score: record.humanReview.scores[dimension] })),
      }]));
      if (unique.size >= minimumReviewers && meanScore < threshold) failures.push({ caseId, variant, belowThreshold: meanScore });
      groups.push({ caseId, variant, reviewerCount: unique.size, meanScore, dimensions });
    }
  }
  return {
    status: failures.length ? 'failed' : incomplete.length ? 'incomplete' : 'passed',
    scope: 'This gate summarizes supplied human judgments and required machine checks for fixed fictional cases. Output hashes identify asserted retained evidence; this function does not read output files or authenticate reviewers. Passing does not demonstrate real event delivery or autonomous leadership.',
    gate: { minimumReviewers, threshold, criticalFailuresAllowed: 0, machineFailuresAllowed: 0, expectedCaseIds: [...expectedCaseIds] },
    failures, incomplete, groups,
  };
}

function safeFailure(error) {
  const message = String(error?.message ?? '');
  const http = message.match(/^Model provider returned HTTP (\d{3})\./);
  if (http) return { code: 'provider_http', message: `Provider returned HTTP ${http[1]}. No output recorded.` };
  if (message.startsWith('Model output was truncated.')) return { code: 'truncated', message: 'Provider output was truncated. No output recorded.' };
  if (message === 'Model provider returned invalid JSON.') return { code: 'invalid_provider_json', message };
  if (message === 'Model provider returned no text.') return { code: 'empty_response', message };
  if (message === 'Model response exceeded the local size limit.') return { code: 'response_limit', message };
  return { code: 'request_failed', message: 'Provider request failed. No output recorded; credentials and provider error bodies are not retained.' };
}

// A live run is deliberately one selected case, with exactly one attempt per
// variant. Planning never contacts a provider, even when credentials exist.
export async function runEvaluation({ out, live = false, env = process.env, fetchImpl = fetch, caseId } = {}) {
  if (!nonempty(out)) throw new Error('Evaluation needs an output directory.');
  if (typeof live !== 'boolean') throw new Error('Evaluation live must be a boolean.');
  const cases = await loadCases();
  if (caseId && !EVALUATION_CASE_IDS.includes(caseId)) throw new Error(`Unknown evaluation case. Choose: ${EVALUATION_CASE_IDS.join(', ')}.`);
  if (live && !caseId) throw new Error('A live evaluation requires one explicit caseId; it makes two provider requests (baseline and Mira).');
  const selected = caseId ? cases.filter(item => item.id === caseId) : cases;
  // Snapshot all provider inputs once; both variants use the exact same config.
  const matchedEnv = Object.freeze(Object.fromEntries(['OPEN_TEAMMATES_BASE_URL', 'OPEN_TEAMMATES_MODEL', 'OPEN_TEAMMATES_API_KEY'].filter(key => env[key] !== undefined).map(key => [key, env[key]])));
  const config = modelConfig(matchedEnv);
  if (live && !config.ready) throw new Error('Live evaluation needs OPEN_TEAMMATES_MODEL and OPEN_TEAMMATES_API_KEY (key optional for localhost). No provider request was made.');
  const [mira, packageInfo] = await Promise.all([
    loadRole(),
    readFile(new URL('package.json', packageRoot), 'utf8').then(JSON.parse),
  ]);
  const output = resolve(out);
  const systems = { baseline: systemPrompt(baselineRole), mira: systemPrompt(mira) };
  const manifest = {
    schemaVersion: 1,
    suite: cases[0].suite,
    fixtureSha256: digest(cases),
    packageVersion: packageInfo.version,
    nodeVersion: process.version,
    createdAt: new Date().toISOString(),
    mode: live ? 'live' : 'plan',
    status: 'preparing',
    out: output,
    caseIds: selected.map(item => item.id),
    variants,
    configuration: { model: config.model || null, provider: config.baseUrl, parameters: { max_completion_tokens: 8000, response_format: { type: 'json_object' } }, samplingParameters: 'Provider defaults; no temperature or seed is set by callModel.' },
    systemPromptSha256: Object.fromEntries(variants.map(variant => [variant, digest(systems[variant])])),
    plannedProviderRequests: live ? selected.length * 2 : 0,
    attemptedProviderRequests: 0,
    successfulProviderRequests: 0,
    evaluationStatus: 'unreviewed',
    cost: null,
    costNote: 'Token usage is retained if the provider returns it. Monetary cost is unknown; no rate is inferred.',
    gate: { minimumReviewers: 2, threshold: 2.5, criticalFailuresAllowed: 0, machineFailuresAllowed: 0, requiredCaseIds: [...EVALUATION_CASE_IDS], note: 'Gate set before this run. A single-case run cannot satisfy the full-suite gate.' },
    results: [],
  };
  await mkdir(output, { recursive: true });
  try { await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Evaluation output already contains a manifest. Choose a fresh directory; previous evidence is never overwritten.'); throw error; }
  const saveJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await saveJson(join(output, 'grader-notes.json'), selected.map(item => ({ caseId: item.id, rubric: item.rubric, criticalFailures: item.criticalFailures, graderNotes: item.graderNotes })));
  for (const item of selected) {
    for (const variant of variants) {
      const request = buildEvaluationRequest(item, { variant });
      const directory = join(output, item.id, variant);
      await mkdir(directory, { recursive: true });
      const payload = {
        model: config.model || null,
        messages: [{ role: 'system', content: systems[variant] }, { role: 'user', content: JSON.stringify({ mission: request.mission, ownerPreferences: [], assignment: request.prompt }) }],
        ...manifest.configuration.parameters,
      };
      await saveJson(join(directory, 'request.json'), payload);
      await writeFile(join(directory, 'prompt.txt'), `${request.prompt}\n`, { flag: 'wx' });
      await writeFile(join(directory, 'system.txt'), `${systems[variant]}\n`, { flag: 'wx' });
      await saveJson(join(directory, 'review-template.json'), { caseId: item.id, variant, reviewer: null, scores: Object.fromEntries(EVALUATION_DIMENSIONS.map(dimension => [dimension, null])), criticalFailures: [], notes: '', instructions: 'Enter independent human judgment after reading the saved output and separate grader-notes.json. Null scores mean unreviewed. Do not submit this empty template as evidence.' });
      if (!live) continue;
      const startedAt = new Date().toISOString();
      const start = performance.now();
      manifest.attemptedProviderRequests++;
      let result;
      let generated;
      try {
        generated = await callModel({ role: variant === 'mira' ? mira : baselineRole, mission: request.mission, memory: [], message: request.prompt, json: true, env: matchedEnv, fetchImpl });
      } catch (error) {
        result = { caseId: item.id, variant, status: 'request_failed', startedAt, durationMs: Math.round(performance.now() - start), model: config.model, provider: config.baseUrl, usage: null, cost: null, promptSha256: request.metadata.promptSha256, error: safeFailure(error), humanReview: { status: 'unreviewed', reviewer: null, scores: null, criticalFailures: [], notes: null, meanScore: null } };
      }
      if (generated) {
        result = {
          caseId: item.id, variant, status: 'output_recorded', startedAt,
          durationMs: Math.round(performance.now() - start), model: generated.model, provider: generated.provider,
          usage: generated.usage, cost: null, promptSha256: request.metadata.promptSha256,
          ...evaluateResponse(item, generated.content, { variant }),
        };
        await writeFile(join(directory, 'output.txt'), generated.content, { flag: 'wx' });
        manifest.successfulProviderRequests++;
      }
      await saveJson(join(directory, 'result.json'), result);
      manifest.results.push(result);
      await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  manifest.status = live ? manifest.successfulProviderRequests === manifest.plannedProviderRequests ? 'outputs_recorded' : 'completed_with_errors' : 'plan_ready';
  manifest.completedAt = new Date().toISOString();
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
