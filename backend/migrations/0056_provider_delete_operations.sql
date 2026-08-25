ALTER TABLE provider_operations
  DROP CONSTRAINT provider_operations_kind_check;

ALTER TABLE provider_operations
  ADD CONSTRAINT provider_operations_kind_check
  CHECK (kind IN ('move', 'copy', 'append', 'delete'));
