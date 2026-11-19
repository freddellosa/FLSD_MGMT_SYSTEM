/** Shared review-entry checks; callers must verify the packet body hash separately. */
import type {BillingMappingPacket, BillingMappingDecisions} from './billing-mapping-proposals';
export function validateBillingDecisionEntries(packet: BillingMappingPacket, decisions: BillingMappingDecisions) {
  if (decisions.kind !== 'BILLING_MAPPING_REVIEW_DECISIONS' || decisions.version !== 1 || decisions.evidenceSha256 !== packet.evidenceSha256) throw new Error('Mapping decision evidence is stale or changed');
  const proposals = new Map(packet.proposals.filter(p => p.classification !== 'PARTIAL_EXPORT_REFERENCE').map(p => [p.id, p]));
  if (!Array.isArray(decisions.items) || decisions.items.length !== proposals.size || new Set(decisions.items.map(d => d.proposalId)).size !== proposals.size) throw new Error('Every proposal needs one decision entry');
  for (const decision of decisions.items) {
    const proposal = proposals.get(decision.proposalId);
    if (!proposal || !['PENDING', 'CONFIRM_CANDIDATE_IDENTITY', 'KEEP_UNRESOLVED', 'REJECT_CANDIDATE'].includes(decision.decision) ||
        typeof decision.reviewerNote !== 'string' || decision.reviewerNote.length > 2000) throw new Error('Invalid mapping review entry');
    if (decision.decision !== 'PENDING' && !decision.reviewerNote.trim()) throw new Error('Review note required');
    if (decision.decision === 'CONFIRM_CANDIDATE_IDENTITY') {
      if (proposal.classification !== 'CANDIDATE_IDENTITY_CONFIRMATION' || !proposal.candidateCustomerId || decision.customerId !== proposal.candidateCustomerId) throw new Error('Only the exact proposed customer identity may be confirmed');
    } else if (decision.customerId !== null) throw new Error('Unconfirmed decisions cannot assign a customer');
  }
  return {importEnabled: false as const, executionAuthorized: false as const,
    pending: decisions.items.filter(d => d.decision === 'PENDING').length,
    recordedIdentityConfirmations: decisions.items.filter(d => d.decision === 'CONFIRM_CANDIDATE_IDENTITY').length};
}
