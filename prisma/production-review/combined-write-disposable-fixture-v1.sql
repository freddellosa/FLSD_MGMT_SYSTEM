-- Run only inside the guarded installer transaction as the disposable owner.
INSERT INTO flsd_combined_write_rehearsal.staff_authorization (authority_id,staff_id,active,role)
VALUES ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000001',true,'BILLING');

INSERT INTO flsd_combined_write_rehearsal.staff_session (authority_id,session_id,staff_id,token_digest,issued_at,expires_at)
VALUES ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',decode(:'fixture_digest','hex'),transaction_timestamp(),transaction_timestamp()+interval '2 hours');

INSERT INTO flsd_combined_write_rehearsal.customer (authority_id,id)
VALUES ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000003'),
       ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000004');

INSERT INTO flsd_combined_write_rehearsal.trip (authority_id,id,customer_id)
VALUES ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000005',
        '10000000-0000-4000-8000-000000000003');

INSERT INTO flsd_combined_write_rehearsal.payment (authority_id,id,customer_id,state,allocation_scope,received)
VALUES ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000006',
        '10000000-0000-4000-8000-000000000003','RECORDED','CUSTOMER',100.01),
       ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000007',
        '10000000-0000-4000-8000-000000000004','RECORDED','CUSTOMER',100.01);

INSERT INTO flsd_combined_write_rehearsal.refund (authority_id,id,payment_id,customer_id,state,amount)
VALUES ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000008',
        '10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000003','RESERVED',25.00),
       ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000009',
        '10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000003','COMPLETED',5.00);

INSERT INTO flsd_combined_write_rehearsal.trip_receivable (authority_id,id,customer_id,trip_id,eligible,payable)
VALUES ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000010',
        '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000005',true,70.00);

INSERT INTO flsd_combined_write_rehearsal.invoice (authority_id,id,customer_id,receivable_id,eligible)
VALUES ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000011',
        '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000010',true),
       ('flsd-synthetic-combined-write','10000000-0000-4000-8000-000000000012',
        '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000010',true);
