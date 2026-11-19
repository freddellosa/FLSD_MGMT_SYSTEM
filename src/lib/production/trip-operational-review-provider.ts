import type {OperationalReviewProvider} from './authenticated-operational-review';
import type {OperationalReviewActor, OperationalReviewReceipt} from './operational-envelope';

type ScopedRecord = {authority: string; id: string};
type DirectoryRecord = ScopedRecord & {active: boolean};
type TripRecord = ScopedRecord & {
  customerId: string;
  vehicleId: string | null;
  driverId: string | null;
  version: string;
};

export interface TripReviewSnapshot {
  /** Verify the request session, including expiry and revocation, and read current staff state. */
  findVerifiedActor(authority: string, request: Request): Promise<OperationalReviewActor | null>;
  findTrip(authority: string, id: string): Promise<TripRecord | null>;
  findCustomer(authority: string, id: string): Promise<DirectoryRecord | null>;
  findVehicle(authority: string, id: string): Promise<DirectoryRecord | null>;
  findDriver(authority: string, id: string): Promise<DirectoryRecord | null>;
  findReceipt(authority: string, operationId: string): Promise<OperationalReviewReceipt | null>;
}

export interface TripReviewRepository {
  readSnapshot<T>(read: (snapshot: TripReviewSnapshot) => Promise<T>): Promise<T>;
}

/** Trip-only adapter for the read contract. The repository supplies verified, read-only snapshots. */
export function createTripOperationalReviewProvider(
  authority: string,
  repository: TripReviewRepository,
): OperationalReviewProvider {
  if (!authority) throw new Error('Operational authority required');

  return {
    readSnapshot: review => repository.readSnapshot(snapshot => {
      const inScope = (record: ScopedRecord | null, id: string) =>
        record !== null && record.authority === authority && record.id === id;
      const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id);
      const readTrip = async (id: string) => {
        const record = await snapshot.findTrip(authority, id);
        return inScope(record, id) ? record : null;
      };
      const canUseCustomer = async (id: unknown, retainedId?: string) => {
        if (!validId(id)) return false;
        const record = await snapshot.findCustomer(authority, id);
        return inScope(record, id) && (record?.active === true || id === retainedId);
      };
      const canUseMasters = async (vehicleId: unknown, driverId: unknown, previous?: TripRecord) => {
        if (!validId(vehicleId) || !validId(driverId)) return false;
        const [vehicle, driver] = await Promise.all([
          snapshot.findVehicle(authority, vehicleId),
          snapshot.findDriver(authority, driverId),
        ]);
        return inScope(vehicle, vehicleId) && (vehicle?.active === true || previous?.vehicleId === vehicleId) &&
          inScope(driver, driverId) && (driver?.active === true || previous?.driverId === driverId);
      };

      return review({
        async resolveCurrentActor(request) {
          const actor = await snapshot.findVerifiedActor(authority, request);
          return actor?.authority === authority ? actor : null;
        },
        async allowsCommand(actor, envelope) {
          if (actor.authority !== authority || envelope.schemaVersion !== 2) return false;
          const {action} = envelope;
          if (action.type === 'CREATE_TRIP') {
            return await canUseCustomer(action.trip.customerId) && canUseMasters(action.trip.vehicleId, action.trip.driverId);
          }
          const previous = await readTrip(action.tripId);
          if (!previous || !await canUseCustomer(previous.customerId, previous.customerId) ||
              !await canUseMasters(action.edit.vehicleId, action.edit.driverId, previous)) return false;
          const replacement = action.replacement;
          return !replacement || (
            await canUseCustomer(replacement.customerId, previous.customerId) &&
            canUseMasters(replacement.vehicleId, replacement.driverId, previous)
          );
        },
        findReceipt: (requestedAuthority, operationId) => requestedAuthority === authority
          ? snapshot.findReceipt(authority, operationId)
          : Promise.resolve(null),
        async readTargetVersions(requestedAuthority, targets) {
          const target = targets[0];
          if (requestedAuthority !== authority || targets.length !== 1 || target.kind !== 'TRIP') return [];
          const trip = await readTrip(target.id);
          return trip ? [{kind:'TRIP', id:trip.id, version:trip.version}] : [];
        },
        async allowsReceiptResult(actor, commandType, result) {
          if (actor.authority !== authority || (commandType !== 'CREATE_TRIP' && commandType !== 'EDIT_TRIP')) return false;
          const trip = await readTrip(result.entityId);
          return trip !== null && canUseCustomer(trip.customerId, trip.customerId);
        },
      });
    }),
  };
}
