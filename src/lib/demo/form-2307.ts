import {reconcileWithholdingEvidence, type Form2307Evidence} from '../domain/withholding-evidence';
import type {DemoState} from './store';

export type PilotCertificate = Form2307Evidence & {
  reference: string;
  periodStart: string;
  periodEnd: string;
  supersedesId?: string;
};

export function activeCertificates(records: readonly PilotCertificate[]) {
  const superseded = new Set(records.map(record => record.supersedesId));
  return records.filter(record => !superseded.has(record.certificateId));
}

export function invoiceWithholding(state: DemoState, invoiceId: string, customerId: string) {
  const records = activeCertificates(state.certificates2307 ?? []);
  const result = reconcileWithholdingEvidence({
    invoiceId, customerId, expectedCentavos: state.withholdingExpectations?.[invoiceId] ?? null,
  }, records);
  return {...result, received: result.attachmentIds.length > 0};
}
