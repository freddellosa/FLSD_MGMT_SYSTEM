import {createHash} from 'node:crypto';
import {Prisma, type PrismaClient} from '@prisma/client';
import {roles} from '../security/permissions';
import type {OperationalReviewActor, OperationalReviewReceipt} from './operational-envelope';
import type {TripReviewRepository, TripReviewSnapshot} from './trip-operational-review-provider';

type Target = {authority: string; database: string; databaseOid: string; databaseRole: string};
type Client = Pick<PrismaClient, '$transaction'>;
type TripRow = NonNullable<Awaited<ReturnType<TripReviewSnapshot['findTrip']>>>;
type DirectoryRow = NonNullable<Awaited<ReturnType<TripReviewSnapshot['findCustomer']>>>;
type ReceiptRow = Omit<OperationalReviewReceipt, 'result'> & {entityId: string; version: string};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const relations = {
  customer: Prisma.sql`flsd_operational.customer`,
  vehicle: Prisma.sql`flsd_operational.vehicle`,
  driver: Prisma.sql`flsd_operational.driver`,
};

function one<T>(rows: T[]): T | null {
  if (rows.length > 1) throw new Error('Operational review data integrity mismatch');
  return rows[0] ?? null;
}

/** Inject a reviewed client and a dedicated session-token reader. This factory opens no connection. */
export function createPostgresTripReviewRepository(
  client: Client,
  target: Target,
  readSessionToken: (request: Request) => string | null,
): TripReviewRepository {
  const {authority, database, databaseOid, databaseRole} = target;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(authority) ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(database) || !/^[a-z_][a-z0-9_]{0,62}$/.test(databaseRole) ||
      !/^[1-9][0-9]{0,9}$/.test(databaseOid) || BigInt(databaseOid) > 4294967295n) {
    throw new Error('Invalid operational review target');
  }

  return {
    readSnapshot: read => client.$transaction(async db => {
      await db.$executeRaw`SET TRANSACTION READ ONLY`;
      await db.$executeRaw`SET LOCAL search_path TO pg_catalog`;
      const identity = one(await db.$queryRaw<{verified: boolean}[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_database d
          JOIN pg_catalog.pg_roles r ON r.rolname = current_user
          CROSS JOIN flsd_operational.authority_meta a
          WHERE d.datname = current_database() AND d.datname = ${database} AND d.oid = ${databaseOid}::oid
            AND r.rolname = ${databaseRole} AND r.rolcanlogin AND NOT (
              r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
            )
            AND a.authority_id = ${authority} AND a.contract_version = 1
            AND current_setting('transaction_read_only') = 'on'
            AND current_setting('transaction_isolation') = 'repeatable read'
        ) AS verified
      `);
      if (identity?.verified !== true) throw new Error('Operational review target verification failed');

      const inScope = (requestedAuthority: string, id: string) => requestedAuthority === authority && uuid.test(id);
      async function findDirectory(kind: keyof typeof relations, requestedAuthority: string, id: string) {
        if (!inScope(requestedAuthority,id)) return null;
        return one(await db.$queryRaw<DirectoryRow[]>`
          SELECT authority_id AS authority, id::text, active FROM ${relations[kind]}
          WHERE authority_id = ${authority} AND id = ${id}::uuid
        `);
      }

      return read({
        async findVerifiedActor(requestedAuthority, request) {
          if (requestedAuthority !== authority) return null;
          const token = readSessionToken(request);
          if (token === null || !/^[0-9a-f]{64}$/.test(token)) return null;
          const digest = createHash('sha256').update(token, 'utf8').digest();
          const actor = one(await db.$queryRaw<OperationalReviewActor[]>`
            SELECT u.authority_id AS authority, u.id::text, u.role::text, u.active
            FROM flsd_operational.staff_session s
            JOIN flsd_operational.staff_authorization a
              ON a.authority_id = s.authority_id AND a.staff_id = s.staff_id
            JOIN flsd_operational.staff_user u
              ON u.authority_id = a.authority_id AND u.id = a.staff_id
            WHERE s.authority_id = ${authority} AND s.token_digest = ${digest}
              AND s.issued_at <= statement_timestamp() AND s.expires_at > statement_timestamp()
              AND s.revoked_at IS NULL AND u.active = true
          `);
          return actor?.authority === authority && actor.active === true && uuid.test(actor.id) && roles.includes(actor.role) ? actor : null;
        },
        async findTrip(requestedAuthority, id) {
          if (!inScope(requestedAuthority,id)) return null;
          return one(await db.$queryRaw<TripRow[]>`
            SELECT authority_id AS authority, id::text, customer_id::text AS "customerId",
              vehicle_id::text AS "vehicleId", driver_id::text AS "driverId", version::text
            FROM flsd_operational.trip WHERE authority_id = ${authority} AND id = ${id}::uuid
          `);
        },
        findCustomer: (requestedAuthority,id) => findDirectory('customer',requestedAuthority,id),
        findVehicle: (requestedAuthority,id) => findDirectory('vehicle',requestedAuthority,id),
        findDriver: (requestedAuthority,id) => findDirectory('driver',requestedAuthority,id),
        async findReceipt(requestedAuthority, operationId) {
          if (!inScope(requestedAuthority,operationId)) return null;
          const row = one(await db.$queryRaw<ReceiptRow[]>`
            SELECT authority_id AS authority, operation_id::text AS "operationId", actor_id::text AS "actorId",
              command_kind::text AS "commandType", encode(request_digest,'hex') AS digest,
              result_entity_id::text AS "entityId", result_version::text AS version
            FROM flsd_operational.operational_receipt
            WHERE authority_id = ${authority} AND operation_id = ${operationId}::uuid
          `);
          if (!row) return null;
          const {entityId,version,...receipt} = row;
          return {...receipt,result:{entityId,version}};
        },
      });
    }, {isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead}),
  };
}
