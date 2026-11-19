/** Disconnected validation only. No authentication, persistence, command execution or posting. */
import {createHash} from 'node:crypto';
import {validateCommand} from '../pilot/input';
import {canonicalWire} from '../pilot/wire';
import {requireDemoActionPermission, type DemoAction} from '../demo/store';
import {requirePermission, roles, type Role} from '../security/permissions';

type Kind = 'CREATE_TRIP' | 'EDIT_TRIP' | 'CREATE_SOA' | 'EDIT_SOA' | 'FINALIZE_SOA' | 'CREATE_INVOICE';
type Action = Extract<DemoAction, {type: Kind}>;
export type ExpectedOperationalVersion = {kind: 'TRIP' | 'SOA'; id: string; version: string};
export type OperationalEnvelope = {schemaVersion: 1; operationId: string; action: Action; expectedVersions: ExpectedOperationalVersion[]};
type CreateTrip = Extract<Action, {type: 'CREATE_TRIP'}>;
type EditTrip = Extract<Action, {type: 'EDIT_TRIP'}>;
type WithMasterIds<T> = Omit<T, 'vehicle' | 'driver'> & {vehicleId: string; driverId: string};
type ProductionTripAction =
  | {type:'CREATE_TRIP'; trip:WithMasterIds<CreateTrip['trip']>}
  | (Omit<EditTrip, 'edit' | 'replacement'> & {
      edit:WithMasterIds<EditTrip['edit']>;
      replacement?:WithMasterIds<NonNullable<EditTrip['replacement']>>;
    });
export type OperationalReviewEnvelope = OperationalEnvelope |
  {schemaVersion:2;operationId:string;action:ProductionTripAction;expectedVersions:ExpectedOperationalVersion[]};
/** Supplied by a future verified server context; this type is not proof of authentication. */
export type OperationalReviewActor = {authority: string; id: string; role: Role; active: boolean};
export type OperationalReviewReceipt = {operationId: string; authority: string; actorId: string; commandType: Kind; digest: string; result: {entityId: string; version: string}};
const kinds = ['CREATE_TRIP', 'EDIT_TRIP', 'CREATE_SOA', 'EDIT_SOA', 'FINALIZE_SOA', 'CREATE_INVOICE'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const targetKey = (v: {kind: string; id: string}) => v.kind + ':' + v.id;

export function validateOperationalEnvelope(value: unknown): OperationalEnvelope {
  const envelope = validateOperationalReviewEnvelope(value);
  if (envelope.schemaVersion !== 1) throw new Error('Invalid operation envelope');
  return envelope;
}

export function validateOperationalReviewEnvelope(value: unknown): OperationalReviewEnvelope {
  if (!object(value) || !exact(value, ['schemaVersion', 'operationId', 'action', 'expectedVersions']) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2) || typeof value.operationId !== 'string' || !uuid.test(value.operationId)) throw new Error('Invalid operation envelope');
  let nodes = 0, textUnits = 0;
  const forbidden = new Set(['actor', 'actorId', 'role', 'userId', 'authority', 'balance', 'balances', 'expectedBalance', 'availableCredit', 'capabilities', 'postingEnabled', 'enablePosting', 'executionAuthorized', 'zeroChargeTrips', 'generatedBusinessNumber', 'importEnabled', '__proto__', 'constructor', 'prototype']);
  function bounded(v: unknown, depth: number): void {
    if (++nodes > 10000 || depth > 20) throw new Error('Command complexity exceeded');
    if (typeof v === 'string') {textUnits += v.length; if (v.length > 4000 || textUnits > 1024 * 1024) throw new Error('Command text too long');}
    else if (typeof v === 'bigint') {if (v < 0n || v > 999999999999999999n) throw new Error('Invalid exact amount');}
    else if (typeof v === 'number') {if (!Number.isSafeInteger(v)) throw new Error('Invalid numeric value');}
    else if (Array.isArray(v)) {if (v.length > 500) throw new Error('Too many command targets'); for (const child of v) bounded(child, depth + 1);}
    else if (object(v)) {for (const [key, child] of Object.entries(v)) {if (forbidden.has(key)) throw new Error('Client authority or balance is forbidden'); bounded(child, depth + 1);}}
    else if (v !== null && typeof v !== 'boolean') throw new Error('Invalid command value');
  }
  bounded(value, 0);
  validateCommand(value.action);
  if (!kinds.includes(value.action.type)) throw new Error('Unsupported operational command');
  const action = value.action as Action;
  if (action.type === 'CREATE_TRIP' && (!object(action.trip) || Object.hasOwn(action, 'payment'))) throw new Error('Trip details required; receipt commands are excluded');
  if (action.type === 'EDIT_TRIP' && (!id(action.tripId) || !object(action.edit) || !Number.isSafeInteger(action.expectedVersion) || action.expectedVersion < 1)) throw new Error('Invalid trip edit target');
  if (value.schemaVersion === 2) {
    const hasMasterIds = (selection: unknown) => object(selection) && id(selection.vehicleId) && id(selection.driverId) &&
      !Object.hasOwn(selection, 'vehicle') && !Object.hasOwn(selection, 'driver');
    if (action.type === 'CREATE_TRIP') {
      if (!id(action.trip.customerId) || !hasMasterIds(action.trip)) throw new Error('Stable customer, vehicle and driver IDs required');
    } else if (action.type === 'EDIT_TRIP') {
      if (!hasMasterIds(action.edit) || (Object.hasOwn(action, 'replacement') &&
          (!object(action.replacement) || !id(action.replacement.customerId) || !hasMasterIds(action.replacement)))) {
        throw new Error('Stable vehicle and driver IDs required for trip edits');
      }
    } else {
      throw new Error('Version 2 supports trip commands only');
    }
  }
  if (['CREATE_SOA', 'EDIT_SOA'].includes(action.type)) {
    const tripIds = (action as Extract<Action, {type: 'CREATE_SOA' | 'EDIT_SOA'}>).tripIds;
    if (!Array.isArray(tripIds) || !tripIds.length || tripIds.some(t => !id(t)) || new Set(tripIds).size !== tripIds.length) throw new Error('Unique selected trips required');
  }
  if ((action.type === 'EDIT_SOA' || action.type === 'FINALIZE_SOA') && (!id(action.soaId) || !Number.isSafeInteger(action.expectedVersion) || action.expectedVersion < 1)) throw new Error('Invalid SOA target');
  if (action.type === 'CREATE_INVOICE' && (Boolean(action.tripId) === Boolean(action.soaId) || !id(action.tripId || action.soaId))) throw new Error('Exactly one invoice source required');
  if (!Array.isArray(value.expectedVersions)) throw new Error('Expected versions required');
  const versions = value.expectedVersions;
  if (versions.some(v => !object(v) || !exact(v, ['kind', 'id', 'version']) || !['TRIP', 'SOA'].includes(String(v.kind)) || !id(v.id) || !version(v.version))) throw new Error('Invalid expected version');
  const expected = versions as ExpectedOperationalVersion[];
  if (new Set(expected.map(targetKey)).size !== expected.length) throw new Error('Duplicate expected target');
  const required: string[] = [];
  if (action.type === 'EDIT_TRIP') required.push('TRIP:' + action.tripId);
  if (action.type === 'CREATE_SOA' || action.type === 'EDIT_SOA') required.push(...action.tripIds.map(t => 'TRIP:' + t));
  if (action.type === 'EDIT_SOA' || action.type === 'FINALIZE_SOA') required.push('SOA:' + action.soaId);
  if (action.type === 'CREATE_INVOICE') required.push(action.tripId ? 'TRIP:' + action.tripId : 'SOA:' + action.soaId);
  if (required.length !== expected.length || required.some(k => !expected.some(v => targetKey(v) === k))) throw new Error('Exact explicit-target version coverage required');
  if ('expectedVersion' in action && expected.find(v => v.id === ('tripId' in action ? action.tripId : action.soaId) && v.kind === (action.type === 'EDIT_TRIP' ? 'TRIP' : 'SOA'))?.version !== String(action.expectedVersion)) throw new Error('Conflicting command version');
  if (action.type === 'CREATE_INVOICE' && action.soaId && expected.find(v => v.kind === 'SOA' && v.id === action.soaId)?.version !== String(action.expectedSoaVersion)) throw new Error('Conflicting source version');
  // Snapshot validated values so later caller mutations cannot alter this envelope.
  const normalized = {operationId: value.operationId.toLowerCase(), expectedVersions: expected};
  return value.schemaVersion === 1
    ? structuredClone({schemaVersion:1, ...normalized, action})
    : structuredClone({schemaVersion:2, ...normalized, action:action as unknown as ProductionTripAction});
}

export function assertOperationalReviewPermission(actor: OperationalReviewActor | null, action: OperationalReviewEnvelope['action']): asserts actor is OperationalReviewActor {
  if (!actor || actor.active !== true || !id(actor.id) || !id(actor.authority) || !roles.includes(actor.role)) throw new Error('Forbidden');
  if (action.type === 'CREATE_TRIP' || action.type === 'EDIT_TRIP') {
    requirePermission(actor.role,'trip:write');
    if (action.type === 'CREATE_TRIP' && 'payment' in action && action.payment) requirePermission(actor.role,'payment:write');
  } else requireDemoActionPermission(actor.role, action);
}

export function reviewOperationalReplay(input: unknown, actor: OperationalReviewActor, receipt: OperationalReviewReceipt | null, currentVersions: readonly ExpectedOperationalVersion[]) {
  const envelope = validateOperationalReviewEnvelope(input);
  assertOperationalReviewPermission(actor, envelope.action);
  const normalizedAction = structuredClone(envelope.action);
  if (normalizedAction.type === 'CREATE_SOA' || normalizedAction.type === 'EDIT_SOA') normalizedAction.tripIds.sort();
  const canonical = canonicalWire({schemaVersion: envelope.schemaVersion, authority: actor.authority, actorId: actor.id, action: normalizedAction, expectedVersions: [...envelope.expectedVersions].sort((a,b) => targetKey(a) < targetKey(b) ? -1 : 1)});
  const digest = createHash('sha256').update(canonical).digest('hex');
  const disabled = {executionAuthorized: false as const, postingEnabled: false as const};
  if (receipt) {
    if (!object(receipt) || !exact(receipt, ['operationId', 'authority', 'actorId', 'commandType', 'digest', 'result']) || typeof receipt.operationId !== 'string' || receipt.operationId.toLowerCase() !== envelope.operationId || receipt.authority !== actor.authority || receipt.actorId !== actor.id || receipt.commandType !== envelope.action.type || receipt.digest !== digest || !object(receipt.result) || !exact(receipt.result, ['entityId', 'version']) || !id(receipt.result.entityId) || !version(receipt.result.version)) throw new Error('Operation receipt conflict');
    return {status: 'REPLAY_REVIEW_ONLY' as const, digest, result: structuredClone(receipt.result), ...disabled};
  }
  if (currentVersions.some(v => !id(v.id) || !version(v.version) || !['TRIP', 'SOA'].includes(v.kind)) || new Set(currentVersions.map(targetKey)).size !== currentVersions.length) throw new Error('Invalid current version snapshot');
  if (envelope.expectedVersions.some(v => !currentVersions.some(c => targetKey(c) === targetKey(v) && c.version === v.version))) throw new Error('Stale operational target');
  return {status: 'VALIDATED_REVIEW_ONLY' as const, digest, result: null, ...disabled};
}
