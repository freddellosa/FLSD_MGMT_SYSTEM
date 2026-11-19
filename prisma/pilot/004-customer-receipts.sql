BEGIN;
DO $$
BEGIN
  IF current_database() <> 'flsd_pilot_qa_phase_payments'
     OR NOT EXISTS (
       SELECT 1 FROM pilot_meta
       WHERE id = 1 AND schema_version = 3 AND marker = 'FLSD_ISOLATED_PILOT_ONLY'
     ) THEN
    RAISE EXCEPTION 'Dedicated fictional payments candidate required';
  END IF;
END $$;
ALTER TABLE pilot_receipts ALTER COLUMN trip_id DROP NOT NULL;
ALTER TABLE pilot_receipts ADD CONSTRAINT pilot_customer_receipt_scope CHECK (
  trip_id IS NOT NULL OR (
    payload->'tripId' IS NOT DISTINCT FROM 'null'::jsonb
    AND coalesce(payload->>'collector', '') = 'OFFICE'
    AND coalesce(payload->>'purpose', '') = 'SETTLEMENT'
  )
);
UPDATE pilot_meta SET schema_version = 4 WHERE id = 1;
COMMIT;
