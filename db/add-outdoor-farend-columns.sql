-- ============================================================================
-- Al-Waseel Farm — add outdoor + far-end sensor columns to `readings`
-- Run ONCE in Supabase: Dashboard → SQL Editor → paste → Run.
-- Safe to re-run (IF NOT EXISTS). Existing rows get NULL for the new columns.
-- ============================================================================

alter table readings add column if not exists outdoor_temp      double precision;
alter table readings add column if not exists outdoor_humidity  double precision;
alter table readings add column if not exists far_end_temp      double precision;
alter table readings add column if not exists far_end_humidity  double precision;
