/** Compare two independently byte-verified offline datasets. No balance migration. */
import {createHash} from 'node:crypto';
import {reviewRelatedCsvBytes} from './csv-review';
import {buildReviewReport, canonicalReviewJson, type CsvReviewRequest, type ReviewReport} from './review-report';
import {reconcileOffline, type SourceIdentity} from './reconciliation';

export function buildComparisonReport(source: CsvReviewRequest, candidate: CsvReviewRequest) {
  const sourceReport = buildReviewReport(source), candidateReport = buildReviewReport(candidate);
  const reasons: string[] = [];
  if (source.manifest.namespace !== candidate.manifest.namespace) reasons.push('NAMESPACE_CHANGED');
  if (source.manifest.mappingVersion !== candidate.manifest.mappingVersion) reasons.push('MAPPING_VERSION_CHANGED');
  const mappings = (request: CsvReviewRequest) => [...request.files].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(f => ({id: f.id, mapping: f.mapping,
    recordType: request.manifest.files.find(d => d.id === f.id)?.recordType ?? 'DATED'}));
  if (canonicalReviewJson(mappings(source)) !== canonicalReviewJson(mappings(candidate))) reasons.push('MAPPING_CONTENT_CHANGED');
  if (canonicalReviewJson(source.manifest.coverage) !== canonicalReviewJson(candidate.manifest.coverage)) reasons.push('COVERAGE_CHANGED');
  const canonicalRules = (request: CsvReviewRequest) => [...request.rules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (canonicalReviewJson(canonicalRules(source)) !== canonicalReviewJson(canonicalRules(candidate))) reasons.push('RELATIONSHIP_RULES_CHANGED');
  if (sourceReport.structuralStatus !== 'REVIEWED') reasons.push('SOURCE_REQUIRES_REVIEW');
  if (candidateReport.structuralStatus !== 'REVIEWED') reasons.push('CANDIDATE_REQUIRES_REVIEW');
  const provenance = {source: sourceReport.provenance, candidate: candidateReport.provenance};
  const common = {version: 1 as const, importEnabled: false as const, policyStatus: 'PENDING' as const, provenance};
  if (reasons.length) return {...common, status: 'NOT_COMPARED' as const, reasons, reconciliation: null};
  const left = reviewRelatedCsvBytes(source.manifest, source.files, source.rules);
  const right = reviewRelatedCsvBytes(candidate.manifest, candidate.files, candidate.rules);
  const result = reconcileOffline(left.records.map(r => r.candidate), right.records.map(r => r.candidate));
  const identityKey = (id: SourceIdentity) => JSON.stringify([id.namespace, id.kind, id.key]);
  const locations = (report: ReviewReport) => new Map(report.records.map(r => [identityKey(r.identity), r.locator]));
  const sourceLocations = locations(sourceReport), candidateLocations = locations(candidateReport);
  const locate = (identity: SourceIdentity) => ({identity: structuredClone(identity),
    sourceLocator: sourceLocations.get(identityKey(identity)) ?? null, candidateLocator: candidateLocations.get(identityKey(identity)) ?? null});
  const reconciliation = {
    comparison: result.comparison, sourceCount: result.sourceCount, candidateCount: result.candidateCount,
    missing: result.missing.map(locate), unexpected: result.unexpected.map(locate),
    differences: result.differences.map(d => ({...locate(d.identity), field: d.field,
      // Text/evidence values remain private in source files; only exact money is rendered.
      ...(d.field.startsWith('money.') ? {source: d.source, candidate: d.candidate} : {})})),
    totals: result.totals, pendingRows: result.blocked.length,
  };
  const sha256 = createHash('sha256').update(canonicalReviewJson({provenance, reconciliation})).digest('hex');
  return {...common, status: result.comparison, reasons, reconciliation, sha256};
}
