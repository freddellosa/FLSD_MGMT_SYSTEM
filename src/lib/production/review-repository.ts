/** Synthetic in-memory reference for the proposed production transaction contract. Never a live DB adapter. */
import {randomUUID} from 'node:crypto';
import type {Role} from '../security/permissions';
import type {SixTableKind} from '../migration/six-table-contract';
import type {BusinessNumberCounter, BusinessNumberKind} from '../domain/business-numbering';
import type {NormalizedSlot} from '../migration/normalized-snapshot';

export type ReviewEntity = {id: string; kind: SixTableKind; version: string; businessNumber: string | null;
  legacyBusinessNumber?: string | null;
  typedFacts: Record<string, string | boolean | null>; foreignKeys: Record<string, string | null>;
  reviewSlots: NormalizedSlot[]; visibility: 'REVIEW_HOLD'};
export type ReviewMapping = {namespace: string; kind: SixTableKind; key: string; entityId: string; evidenceSha256: string; mappingSha256: string};
export type ReviewSourceRow = {namespace: string; fileSha256: string; logicalRow: number; kind: SixTableKind; key: string; evidenceSha256: string; payload: Record<string, string>};
export type ReviewBatch = {id: string; namespace: string; manifestSha256: string; sourceSnapshotSha256: string; mappingSha256: string; rows: number; chunkSize: number; chunks: number[]; state: 'LOADING' | 'RECONCILING'};
export type ReviewFileVersion = {namespace: string; kind: SixTableKind; sha256: string; filename: string; rows: number};
export type ReviewReceipt = {actorId: string; digest: string; result: {entityIds: string[]; batchId: string | null; chunkIndex: number | null; businessNumber: string | null}};
export type ReviewAudit = {operationId: string; actorId: string; action: string; subjects: string[]};
export type ReviewRepositoryState = {revision: number; entities: ReviewEntity[]; mappings: ReviewMapping[]; sourceRows: ReviewSourceRow[];
  files: ReviewFileVersion[]; batches: ReviewBatch[]; receipts: Record<string, ReviewReceipt>; counters: BusinessNumberCounter[]; history: ReviewEntity[]; audit: ReviewAudit[]};
export type ReviewActor = {id: string; role: Role};
export interface ReviewImportTransaction {
  currentActor(): ReviewActor;
  state: ReviewRepositoryState;
  newEntityId(): string;
  checkpoint(): void;
}
export interface ReviewImportRepository {
  readonly environment: 'DISCONNECTED_SYNTHETIC';
  serializable<T>(fn: (tx: ReviewImportTransaction) => Promise<T>): Promise<T>;
}

function assertState(s: ReviewRepositoryState) {
  const entities = new Set<string>(), mappings = new Set<string>(), numbers = new Set<string>(), rows = new Set<string>();
  for (const e of s.entities) {
    if (entities.has(e.kind + ':' + e.id) || e.visibility !== 'REVIEW_HOLD' || !/^[1-9]\d*$/.test(e.version)) throw new Error('Duplicate/invalid review entity');
    entities.add(e.kind + ':' + e.id);
    if (e.businessNumber !== null) {const key = e.kind + ':' + e.businessNumber; if (numbers.has(key)) throw new Error('Duplicate business number'); numbers.add(key);}
    for (const [field, target] of Object.entries(e.foreignKeys)) if (target !== null) {
      const kind = field === 'CompanyID' ? 'company_tbl' : field === 'DriverID' ? 'Driver_tbl' : field === 'VehicleID' ? 'vehicle_tbl' : field === 'SOANo' ? 'SOA_Tbl' : 'Invoice_Tbl';
      if (!s.entities.some(parent => parent.kind === kind && parent.id === target)) throw new Error('Review foreign key missing');
    }
  }
  for (const m of s.mappings) {const key = JSON.stringify([m.namespace, m.kind, m.key]); if (mappings.has(key) || !entities.has(m.kind + ':' + m.entityId)) throw new Error('Duplicate/unresolved source mapping'); mappings.add(key);}
  for (const r of s.sourceRows) {const key = JSON.stringify([r.namespace, r.kind, r.fileSha256, r.logicalRow]); if (rows.has(key) || Object.hasOwn(r.payload, 'SSSNo') || Object.hasOwn(r.payload, 'SSS_Rate')) throw new Error('Duplicate/unsafe source row'); rows.add(key);}
  if (s.audit.length !== Object.keys(s.receipts).length || new Set(s.audit.map(a => a.operationId)).size !== s.audit.length || s.audit.some(a => !s.receipts[a.operationId] || s.receipts[a.operationId].actorId !== a.actorId)) throw new Error('Import receipt/audit must commit together');
  if (s.history.length !== s.entities.length || s.entities.some(e => !s.history.some(h => h.kind === e.kind && h.id === e.id && JSON.stringify(h) === JSON.stringify(e)))) throw new Error('Immutable entity revision required');
}

/** Simulation only. Serializes reference transactions and clones rollback state; does not prove PostgreSQL behavior. */
export function createSyntheticReviewRepository(actor: ReviewActor, options: {failAtCheckpoint?: number; failAfterCommitOnce?: boolean} = {}) {
  let state: ReviewRepositoryState = {revision: 0, entities: [], mappings: [], sourceRows: [], files: [], batches: [], receipts: {}, counters: [], history: [], audit: []};
  let currentActor = {...actor}, tail = Promise.resolve(), afterCommitFailure = !!options.failAfterCommitOnce;
  const repository: ReviewImportRepository = {environment: 'DISCONNECTED_SYNTHETIC', async serializable<T>(fn: (tx: ReviewImportTransaction) => Promise<T>) {
    let release!: () => void;
    const previous = tail; tail = new Promise<void>(resolve => {release = resolve;}); await previous;
    try {
      const next = structuredClone(state); let checkpoints = 0;
      const result = await fn({state: next, currentActor: () => ({...currentActor}), newEntityId: () => randomUUID(), checkpoint: () => {checkpoints++; if (options.failAtCheckpoint === checkpoints) throw new Error('Synthetic injected transaction failure');}});
      if (next.revision !== state.revision) throw new Error('Repository revision is server-controlled');
      assertState(next);
      const encode = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
      if (encode(next) !== encode(state)) {
        for (const name of ['entities', 'mappings', 'sourceRows', 'files', 'history'] as const) {
          if (next[name].length < state[name].length || state[name].some((entry, i) => encode(entry) !== encode(next[name][i]))) throw new Error('Import cannot overwrite existing entity or source history');
        }
        if (Object.keys(next.receipts).length !== Object.keys(state.receipts).length + 1 || Object.entries(state.receipts).some(([key, receipt]) => encode(next.receipts[key]) !== encode(receipt))) throw new Error('One immutable operation receipt required per changed transaction');
        if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Review revision exhausted'); next.revision++;
      }
      state = next;
      if (afterCommitFailure) {afterCommitFailure = false; throw new Error('Synthetic commit outcome unknown; retry the same operation');}
      return result;
    } finally {release();}
  }};
  return {repository, snapshot: () => structuredClone(state), setActorForTest: (next: ReviewActor) => {currentActor = {...next};},
    counterForTest: (kind: BusinessNumberKind) => structuredClone(state.counters.find(c => c.kind === kind))};
}
