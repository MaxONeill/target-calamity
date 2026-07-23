-- Drops the vestigial Gestalt trust-graph anchor.
--
-- The column was reserved for a federated trust-graph hand-off that was never
-- built. It was NULL on every row, the schema exposed it as permanently null,
-- and the UI shipped a permanently-disabled button for it. Removing it rather
-- than carrying a column no producer ever wrote to.

ALTER TABLE factors DROP COLUMN IF EXISTS gestalt_channel_address;
