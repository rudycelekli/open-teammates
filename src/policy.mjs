import { createHash } from 'node:crypto';

// These are handoff requests. This package deliberately contains no executor
// for communication, transactions, booking, publication or credential access.
export const ACTION_KINDS = Object.freeze(['send_message', 'publish', 'spend', 'sign_contract', 'book_venue', 'share_attendee_data']);
export function actionDigest(action) {
  return createHash('sha256').update(JSON.stringify([action.kind, action.summary, action.payload, action.missionId, action.missionRevision ?? null])).digest('hex');
}
export function evaluateAction(input) {
  if (!input || typeof input !== 'object' || !ACTION_KINDS.includes(input.kind)) throw new Error(`Unsupported action. Allowed kinds: ${ACTION_KINDS.join(', ')}`);
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 1000) throw new Error('An action needs a summary of 1–1000 characters.');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('An action needs a concrete payload object to review.');
  if (JSON.stringify(input.payload).length > 16000) throw new Error('Action payload is too large.');
  if (input.kind === 'spend' && (!Number.isSafeInteger(input.payload.amountMinor) || input.payload.amountMinor <= 0 || !/^[A-Z]{3}$/.test(input.payload.currency ?? ''))) throw new Error('Spending requests need positive integer amountMinor and a three-letter currency.');
  return { kind: input.kind, summary: input.summary.trim(), payload: input.payload, missionId: input.missionId ?? null, status: 'pending', reason: 'Owner review required for this exact handoff. No external action will execute in this local release.' };
}
export function resolveApproval(action, decision) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('Decision must be approve or reject.');
  if (action.status !== 'pending') throw new Error('This request has already been decided.');
  if (action.digest !== actionDigest(action)) throw new Error('Action changed since it was proposed. Create a new request.');
  return { ...action, status: decision === 'approve' ? 'approved_for_handoff' : 'rejected', decidedAt: new Date().toISOString(), executed: false };
}
