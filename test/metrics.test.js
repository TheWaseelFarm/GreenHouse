import { describe, it, expect } from 'vitest';
import {
  saturationVaporPressure,
  calcVPD,
  calcDewPoint,
  calcHeatIndex,
  calcAbsHumidity,
  calcPSI,
} from '../_lib/metrics.js';

describe('saturationVaporPressure', () => {
  it('matches the Tetens equation at reference points', () => {
    expect(saturationVaporPressure(25)).toBeCloseTo(3.1678, 3);
    expect(saturationVaporPressure(20)).toBeCloseTo(2.3383, 3);
    expect(saturationVaporPressure(0)).toBeCloseTo(0.6108, 4);
  });

  it('increases monotonically with temperature', () => {
    expect(saturationVaporPressure(30)).toBeGreaterThan(saturationVaporPressure(25));
  });
});

describe('calcVPD', () => {
  it('computes vapour pressure deficit for known conditions', () => {
    expect(calcVPD(25, 60)).toBe(1.27);
    expect(calcVPD(30, 50)).toBe(2.12);
    expect(calcVPD(20, 80)).toBe(0.47);
  });

  it('is ~0 at 100% humidity (air fully saturated)', () => {
    expect(calcVPD(25, 100)).toBe(0);
  });

  it('equals the full SVP at 0% humidity', () => {
    expect(calcVPD(25, 0)).toBeCloseTo(saturationVaporPressure(25), 2);
  });

  it('rounds to 2 decimal places', () => {
    const v = calcVPD(23.456, 47.89);
    expect(Number.isFinite(v)).toBe(true);
    expect(v.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });
});

describe('calcDewPoint', () => {
  it('computes dew point for known conditions', () => {
    expect(calcDewPoint(25, 60)).toBe(16.7);
    expect(calcDewPoint(30, 50)).toBe(18.4);
  });

  it('equals ambient temperature at 100% humidity', () => {
    expect(calcDewPoint(20, 100)).toBe(20);
  });

  it('handles sub-zero dew points', () => {
    expect(calcDewPoint(10, 40)).toBe(-3);
  });
});

describe('calcHeatIndex', () => {
  it('returns the dry-bulb temperature unchanged below 27°C', () => {
    expect(calcHeatIndex(25, 60)).toBe(25);
    expect(calcHeatIndex(20, 80)).toBe(20);
    expect(calcHeatIndex(26.9, 50)).toBe(26.9);
  });

  it('applies the Rothfusz regression at/above 27°C', () => {
    expect(calcHeatIndex(27, 70)).toBe(22.5);
  });

  it('27°C is the branch boundary (inclusive of the regression)', () => {
    // At exactly 27 the regression path is taken, not the passthrough.
    expect(calcHeatIndex(27, 70)).not.toBe(27);
  });
});

describe('calcAbsHumidity', () => {
  // NOTE: these assertions pin CURRENT behaviour. The magnitudes (~1.4 g/m³
  // at 25°C/60%) are ~10x below the physically expected ~13.8 g/m³, which
  // points to a kPa-vs-hPa unit mismatch in the formula. See the test
  // "flags the suspected unit bug" below — fix the formula and update these.
  it('returns current (characterization) values', () => {
    expect(calcAbsHumidity(25, 60)).toBe(1.4);
    expect(calcAbsHumidity(30, 50)).toBe(1.5);
  });

  it('increases with humidity at fixed temperature', () => {
    expect(calcAbsHumidity(25, 80)).toBeGreaterThan(calcAbsHumidity(25, 40));
  });

  it('is 0 at 0% humidity', () => {
    expect(calcAbsHumidity(25, 0)).toBe(0);
  });

  it.fails('flags the suspected unit bug (expected ~13.8 g/m³ at 25°C/60%)', () => {
    // Intentionally failing: documents the physically-correct target so the
    // discrepancy is visible in CI. Remove `.fails` once the formula is fixed.
    expect(calcAbsHumidity(25, 60)).toBeCloseTo(13.8, 1);
  });
});

describe('calcPSI', () => {
  it('is 0 in the comfort zone', () => {
    expect(calcPSI(0.8, 20, 70)).toBe(0);
  });

  it('sums VPD, temperature and humidity band contributions', () => {
    // vpd 1.2 (+2), temp 24 (+2), hum 55 (+1) = 5
    expect(calcPSI(1.2, 24, 55)).toBe(5);
  });

  describe('VPD bands', () => {
    it('adds 2 in the 1.0–1.3 band', () => {
      expect(calcPSI(1.2, 20, 70)).toBe(2);
    });
    it('adds nothing at exactly 1.0 (band is exclusive)', () => {
      expect(calcPSI(1.0, 20, 70)).toBe(0);
    });
    it('adds 4 above 1.3', () => {
      expect(calcPSI(1.4, 20, 70)).toBe(4);
    });
    it('adds 2 at exactly the 1.3 upper edge', () => {
      expect(calcPSI(1.3, 20, 70)).toBe(2);
    });
  });

  describe('temperature bands', () => {
    it('adds 2 in the 22–26 band', () => {
      expect(calcPSI(0.5, 24, 70)).toBe(2);
    });
    it('adds 4 above 26', () => {
      expect(calcPSI(0.5, 28, 70)).toBe(4);
    });
    it('adds nothing at exactly 22 (band is exclusive)', () => {
      expect(calcPSI(0.5, 22, 70)).toBe(0);
    });
  });

  describe('humidity bands', () => {
    it('adds 1 in the 50–60 band', () => {
      expect(calcPSI(0.5, 20, 55)).toBe(1);
    });
    it('adds 3 below 50', () => {
      expect(calcPSI(0.5, 20, 45)).toBe(3);
    });
    it('adds 2 above 85', () => {
      expect(calcPSI(0.5, 20, 90)).toBe(2);
    });
  });

  it('clamps the total at 10', () => {
    // vpd>1.3 (+4), temp>26 (+4), hum<50 (+3) = 11 → clamped to 10
    expect(calcPSI(2, 35, 45)).toBe(10);
    expect(calcPSI(2, 35, 90)).toBe(10);
  });
});
