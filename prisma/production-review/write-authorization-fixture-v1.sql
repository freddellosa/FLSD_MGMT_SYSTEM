-- Reviewed fixture body only. A future guarded installer must create the fresh schema
-- and role, establish provenance, and verify ACLs before committing this body.
CREATE TABLE flsd_write_auth_rehearsal.staff_authorization (
  authority_id text NOT NULL CHECK (authority_id='flsd-synthetic-write-auth'),
  staff_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('BILLING','VIEWER')),
  active boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  lock_guard boolean NOT NULL DEFAULT true CHECK (lock_guard),
  PRIMARY KEY (authority_id,staff_id)
);
CREATE TABLE flsd_write_auth_rehearsal.staff_session (
  authority_id text NOT NULL,
  session_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  token_digest bytea NOT NULL CHECK (octet_length(token_digest)=32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>issued_at),
  revoked_at timestamptz CHECK (revoked_at>=issued_at),
  PRIMARY KEY (authority_id,session_id),
  UNIQUE (authority_id,token_digest),
  FOREIGN KEY (authority_id,staff_id) REFERENCES flsd_write_auth_rehearsal.staff_authorization(authority_id,staff_id)
);
CREATE TABLE flsd_write_auth_rehearsal.customer (
  authority_id text NOT NULL CHECK (authority_id='flsd-synthetic-write-auth'),
  id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY (authority_id,id)
);
CREATE TABLE flsd_write_auth_rehearsal.receipt (
  authority_id text NOT NULL,
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  staff_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  PRIMARY KEY (authority_id,operation_key),
  FOREIGN KEY (authority_id,staff_id) REFERENCES flsd_write_auth_rehearsal.staff_authorization(authority_id,staff_id),
  FOREIGN KEY (authority_id,customer_id) REFERENCES flsd_write_auth_rehearsal.customer(authority_id,id)
);
