-- ============================================================================
-- Al-Waseel Farm — Daily Plant Log v2.
-- Upgrades `field_logs` from a photo/notes journal into two structured logs:
--   • log_type = 'monitoring' — nutrient/water + plant health (سجل زراعة الشتلات)
--   • log_type = 'treatment'  — pest control & prevention (سجل المكافحة والوقاية)
-- Plus a per-plant location index: Line → Tower → Level → Outlet (4 per level),
-- collapsed into `plant_code` (e.g. "L3-T12-Lv4-O2") for QR labels + search.
-- Run ONCE in Supabase -> SQL Editor. Safe to re-run (idempotent add column).
-- ============================================================================

alter table field_logs
  -- which of the two logs this row belongs to
  add column if not exists log_type   text not null default 'monitoring',
  -- location index (per-plant address)
  add column if not exists line       smallint,
  add column if not exists tower      smallint,
  add column if not exists level       smallint,
  add column if not exists outlet     smallint,          -- 1..4 per level
  add column if not exists plant_code text,               -- e.g. L3-T12-Lv4-O2
  -- monitoring: crop + nutrient/water + health
  add column if not exists variety      text,
  add column if not exists growth_stage text,
  add column if not exists vigor        smallint,         -- 1..5
  add column if not exists feed_ec      numeric,
  add column if not exists feed_ph      numeric,
  add column if not exists drain_ec     numeric,
  add column if not exists drain_ph     numeric,
  add column if not exists water_temp   numeric,
  add column if not exists irrigation   text,
  add column if not exists fertilizer   text,
  -- treatment (pest control & prevention)
  add column if not exists pesticide         text,        -- اسم المبيد
  add column if not exists active_ingredient text,        -- المادة الفعالة
  add column if not exists dose              text,        -- الجرعة
  add column if not exists method            text,        -- رش / سقي (spray/drench)
  add column if not exists pest              text,        -- السبب أو الآفة
  add column if not exists phi_days          smallint,    -- فترة الأمان (pre-harvest interval)
  add column if not exists safety_end        date,        -- تاريخ انتهاء الأمان (auto: log_date + phi_days)
  add column if not exists operator          text,        -- المنفذ
  -- the live greenhouse climate at the moment of logging (auto-attached)
  add column if not exists climate    jsonb;

create index if not exists field_logs_plant_idx on field_logs (line, tower, level, outlet);
create index if not exists field_logs_code_idx  on field_logs (plant_code);
create index if not exists field_logs_type_idx  on field_logs (log_type);
-- Open (not-yet-expired) pre-harvest safety windows, for the harvest-safety check.
create index if not exists field_logs_safety_idx on field_logs (safety_end) where safety_end is not null;
