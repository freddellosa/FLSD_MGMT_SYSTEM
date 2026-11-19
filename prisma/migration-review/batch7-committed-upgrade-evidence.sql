-- Explicit fixture assignments only. Historical rows and their digests are preserved.
INSERT INTO flsd_batch7_commit_rehearsal.staff_authorization(staff_id)
VALUES ('70000000-0000-4000-8000-000000000001');
INSERT INTO flsd_batch7_commit_rehearsal.payment_scope(payment_id,customer_id,evidence_ref)
VALUES ('70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000002','SYNTHETIC-CANDIDATE-CUSTOMER-CASH');
INSERT INTO flsd_batch7_commit_rehearsal.receivable(id,customer_id,trip_id,payable,evidence_ref)
VALUES ('70000000-0000-4000-8000-000000000014','70000000-0000-4000-8000-000000000002',
        '70000000-0000-4000-8000-000000000003',70.00,'SYNTHETIC-CANDIDATE-PAYABLE');
INSERT INTO flsd_batch7_commit_rehearsal.invoice_attribution(invoice_id,customer_id,receivable_id,evidence_ref)
VALUES ('70000000-0000-4000-8000-000000000005','70000000-0000-4000-8000-000000000002',
        '70000000-0000-4000-8000-000000000014','SYNTHETIC-CANDIDATE-ONE-INVOICE');
INSERT INTO flsd_batch7_commit_rehearsal.operation_scope(operation_id,payment_id,customer_id,invoice_id,receivable_id,evidence_ref)
VALUES ('70000000-0000-4000-8000-000000000007','70000000-0000-4000-8000-000000000006',
        '70000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000005',
        '70000000-0000-4000-8000-000000000014','SYNTHETIC-CANDIDATE-BOUND-RECEIPT');
INSERT INTO flsd_batch7_commit_rehearsal.invoice_reservation(receivable_id,operation_id,invoice_id,customer_id)
VALUES ('70000000-0000-4000-8000-000000000014','70000000-0000-4000-8000-000000000007',
        '70000000-0000-4000-8000-000000000005','70000000-0000-4000-8000-000000000002');
