-- ============================================================================
-- Al-Waseel Farm — add Tuya sensor + water-temperature columns to `readings`
-- Run ONCE in Supabase: Dashboard → SQL Editor → paste → Run.
-- Safe to re-run (IF NOT EXISTS). Existing rows get NULL for the new columns.
--
-- Tuya qxj sensors (model T01CB3S) report the unit's own air temp/humidity plus
-- an external probe (temp_current_external) used here as a water temperature:
--   greenhouse sensor probe  → water_temp_irrigation
--   outside "water" sensor probe → water_temp_outside
-- ============================================================================

-- Air temp/humidity from the two Tuya units
alter table readings add column if not exists tuya_gh_temp        double precision;
alter table readings add column if not exists tuya_gh_humidity    double precision;
alter table readings add column if not exists tuya_out_temp       double precision;
alter table readings add column if not exists tuya_out_humidity   double precision;

-- Water temperatures (external probes, already scaled to °C)
alter table readings add column if not exists water_temp_irrigation double precision;
alter table readings add column if not exists water_temp_outside    double precision;
