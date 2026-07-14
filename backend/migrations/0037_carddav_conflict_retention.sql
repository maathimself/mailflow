ALTER TABLE carddav_conflicts
  DROP CONSTRAINT carddav_conflicts_remote_object_fkey;

ALTER TABLE carddav_conflicts
  ADD CONSTRAINT carddav_conflicts_address_book_id_fkey
  FOREIGN KEY (address_book_id) REFERENCES address_books(id) ON DELETE CASCADE;
