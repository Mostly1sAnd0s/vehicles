/**
 * Heat: an infrared radiation FIELD, and a sensor that is a small thermal body inside it.
 *
 * This is deliberately NOT the light model with a different constant. Light sensing here is
 * an instantaneous intensity read; heat is different in four physical ways, and each one is
 * implemented rather than gestured at:
 *
 *  1. AMBIENT. Heat is sensed as an imbalance against the environment's own temperature, so
 *     there is a floor: a world with no sources reads room temperature, not zero, and a
 *     source that happens to BE at ambient is invisible. A world can also contain a cold
 *     sink, which pulls a probe BELOW ambient.
 *
 *  2. STEFAN–BOLTZMANN. Emitted power goes as T⁴ in KELVIN. At 0 °C a body still radiates,
 *     and a 300 °C source is far more than 5× a 60 °C one — the reason heat "feels" different
 *     from a light bulb is exactly this non-linearity, so it is kept and pinned by tests.
 *
 *  3. AIR ABSORBS INFRARED. Beer–Lambert `e^(−r/L)` on top of the geometric 1/r². With a
 *     short L, heat is short-ranged and line-of-sight-ish; with L = ∞ the air is transparent
 *     and inverse-square alone shapes the field.
 *
 *  4. THE PROBE HAS THERMAL MASS. A real thermistor/thermopile is a lumped heat-capacitance
 *     body, so it CANNOT read the field instantly:
 *        C·dT/dt = Σ q_i − h(T − T_ambient)
 *     which gives lag when a vehicle moves, ring-down when it leaves, accumulation over
 *     repeated passes, and one shared equilibrium for several sources.
 *
 * THE BOUND (this is the part that was wrong in the first cut):
 * A passive probe can never become hotter than the hottest thing it sees. The first version
 * wrote the equilibrium as `T_ambient + coupling·flux`, i.e. rise proportional to incident
 * flux — and flux grows without limit as the probe approaches a source (1/r²), so a robot
 * driving over a 220 °C furnace read 4000+ °C. That is not a calibration problem, it is the
 * second law: flux is not heat, and the probe radiates back.
 *
 * The fix is the standard linearisation of radiative exchange about the ambient temperature:
 *        q_i = α·F_i·σ·(T_s⁴ − T⁴) ≈ G_i·(T_s − T),
 *        G_i = α·F_i·σ·(T_s² + T_a²)(T_s + T_a)      (always ≥ 0)
 * Balanced against the passive leak h to the environment, the steady state is
 *        T_eq = (Σ G_i·T_s,i + h·T_a) / (Σ G_i + h)
 * — a conductance-weighted MEAN of the source and ambient temperatures. That is bounded by
 * construction, keeps the T³/T⁴ steepness (hot sources both pull harder and pull harder),
 * makes a sub-ambient body a genuine sink, and makes two fires settle at ONE temperature
 * between them rather than at a runaway sum. `flux` is still computed (it is the signed net
 * irradiance, which is what detection and beam-drawing want), but it no longer sets
 * temperature on its own.
 */

import { inFov } from './light.js';
import { castRay } from './raycast.js';

/** Celsius ↔ kelvin. Emission is computed in kelvin; the UI and config speak Celsius. */
export const KELVIN = 273.15;
export const toKelvin = (celsius) => celsius + KELVIN;

const DEFAULTS = {
  ambientTemp: 20,        // °C — the world's baseline temperature
  radiationConstant: 1,   // bundles εσ·(normalisation); scales net source power
  referenceDistance: 100, // px — the radius at which a source's netPower IS the irradiance
  // Ĝ/h: the probe's radiative conductance to a body AT AMBIENT one referenceDistance away,
  // over its passive leak to the environment. A hotter body scales this up by
  // `linearizedConductance` (~2.6× at 220 °C), which is why this number is small: with the
  // old unbounded formula it was 10 because it was secretly a °C-per-flux gain.
  coupling: 0.5,
  timeConstantMs: 400,    // τ, the sensor's thermal inertia. 0 = instantaneous (pure radiative)
  attenuationLength: Infinity, // e^(−r/L) air absorption; Infinity = transparent
  minDistance: 12,        // px — kills the 1/r² singularity inside a small source
  outputSpanC: 40,        // °C above ambient that reads as full-scale 1.0
};

/** Config read with fallbacks, so a bundle without a `heat` key still resolves. */
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function heatConfig(config = {}) {
  const src = config && typeof config === 'object' ? config : {};
  // Unknown keys (range, fov, thresholdC, occluded…) pass through untouched — this function
  // NORMALISES the constants it owns, it is not a whitelist, and callers hand the result
  // straight back to the samplers which read those other keys off the same object.
  const cfg = {
    ...src,
    ambientTemp: num(src.ambientTemp, DEFAULTS.ambientTemp),
    radiationConstant: num(src.radiationConstant, DEFAULTS.radiationConstant),
    referenceDistance: Math.max(1e-6, num(src.referenceDistance, DEFAULTS.referenceDistance)),
    coupling: num(src.coupling, DEFAULTS.coupling),
    timeConstantMs: Math.max(0, num(src.timeConstantMs, DEFAULTS.timeConstantMs)),
    attenuationLength: num(src.attenuationLength, DEFAULTS.attenuationLength),
    minDistance: Math.max(0.1, num(src.minDistance, DEFAULTS.minDistance)),
    outputSpanC: Math.max(1e-6, num(src.outputSpanC, DEFAULTS.outputSpanC)),
  };
  // A negative span would invert the sensor silently; a negative coupling would make heat
  // cold. Both read as typos, so they are clamped rather than honoured.
  if (cfg.coupling < 0) cfg.coupling = 0;
  if (cfg.attenuationLength <= 0) cfg.attenuationLength = Infinity;
  return cfg;
}

/**
 * Net radiant power of a source, measured against the environment:
 * `k·(T_s⁴/T_a⁴ − 1)` with both temperatures in kelvin.
 *
 * Zero at ambient, positive when hot, NEGATIVE when the body is colder than its
 * surroundings — which is correct (a cold mass is a net radiative sink and will pull a
 * sensor below room temperature) and lets a world contain a cold trap, not just a fire.
 */
export function radiantPower(temperatureC, config = {}) {
  const cfg = heatConfig(config);
  const t = num(temperatureC, cfg.ambientTemp);
  const ts = toKelvin(t);
  const ta = toKelvin(cfg.ambientTemp);
  if (ts <= 0 || ta <= 0) return 0; // below absolute zero: unphysical, emits nothing
  return cfg.radiationConstant * (Math.pow(ts / ta, 4) - 1);
}

/**
 * The dimensionless radiative CONDUCTANCE of a source, from linearising σ(T_s⁴ − T⁴) about
 * the ambient temperature: `(T_s² + T_a²)(T_s + T_a) / (4·T_a³)`, both in kelvin.
 *
 * 1.0 for a body at ambient, 0 at absolute zero, ~2.57 for 220 °C in a 20 °C room. Note it
 * never goes negative: a cold object is not "anti-conductance", it is a normal conductor
 * pulling toward a lower temperature. That distinction is what keeps the equilibrium inside
 * the physical range.
 */
export function linearizedConductance(temperatureC, config = {}) {
  const cfg = heatConfig(config);
  const ts = toKelvin(num(temperatureC, cfg.ambientTemp));
  const ta = toKelvin(cfg.ambientTemp);
  if (ts <= 0 || ta <= 0) return 0;
  return ((ts * ts + ta * ta) * (ts + ta)) / (4 * ta * ta * ta);
}

/**
 * Everything the thermal model knows about a point: the signed net irradiance arriving there
 * AND the equilibrium temperature a probe would settle at.
 *
 * `field = { flux, conductance, equilibriumC, sources }`
 *  · `flux`        — Σ netPower·geometry. Signed (cold sinks subtract), superposes linearly,
 *                    and is what detection and beam drawing want. It is NOT temperature.
 *  · `conductance` — Σ Ĝ (dimensionless, includes `coupling`), the probe's coupling to the
 *                    sources relative to its leak to ambient.
 *  · `equilibriumC`— the conductance-weighted mean of source + ambient temperatures:
 *
 *                        T_eq = (Σ Ĝ_i·T_s,i + T_a) / (Σ Ĝ_i + 1)
 *
 *                    Bounded between the coldest and hottest thing in view. Sitting on a
 *                    220 °C furnace with strong coupling reads just under 220 °C; a source at
 *                    ambient contributes nothing to the numerator's excess, so it reads 0.
 *
 * `opts = { aim, fov, obstacles }`. Occlusion is OFF unless `config.occluded` is true, and
 * when on it is honest only about the RADIATIVE component — this model has no conduction, so
 * it cannot say "heat diffuses around the wall".
 */
export function heatField(point, sources, config = {}, opts = {}) {
  const cfg = heatConfig(config);
  const empty = { flux: 0, conductance: 0, equilibriumC: cfg.ambientTemp, sources: 0 };
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return empty;
  const range = Number.isFinite(config?.range) ? config.range : Infinity;
  const absorbing = Number.isFinite(cfg.attenuationLength);
  let flux = 0;
  let conductance = 0;
  let tempWeight = 0;
  let count = 0;
  for (const src of sources ?? []) {
    if (!src || !Number.isFinite(src.x) || !Number.isFinite(src.y)) continue;
    const dx = src.x - point.x;
    const dy = src.y - point.y;
    const r = Math.hypot(dx, dy);
    if (r > range) continue;
    if (!inFov(Math.atan2(dy, dx), opts)) continue;
    // One sanitised temperature for every use below. `radiantPower` guards itself, but the
    // weighted mean below multiplies the temperature directly, so an Infinity reaching ONLY
    // there would poison the equilibrium while the flux stayed finite.
    const temperatureC = num(src.temperatureC, cfg.ambientTemp);
    const power = radiantPower(temperatureC, cfg);
    const lin = linearizedConductance(temperatureC, cfg);
    if (power === 0 && lin === 0) continue;
    // The 1/r² law uses the true distance, floored so that standing inside a small source
    // cannot produce an infinite reading; the absorption path uses the real path length.
    const d = Math.max(r, cfg.minDistance);
    // Inverse-square about the calibration radius (see the header note).
    let geometry = (cfg.referenceDistance / d) ** 2;
    if (absorbing) geometry *= Math.exp(-r / cfg.attenuationLength);
    if (config?.occluded && opts.obstacles?.length) {
      // A body between here and the source casts a shadow: the ray toward it stops short.
      const hit = castRay(point, Math.atan2(dy, dx), r, opts.obstacles);
      if (hit?.hit && hit.distance < r - 1e-6) continue;
    }
    flux += power * geometry;
    // A cold sink conducts too — toward ITS temperature — so it is weighted the same way a
    // fire is, and the mean lands below ambient. Weighting by |power| instead would have
    // quietly deleted cold sinks from the world.
    const g = cfg.coupling * lin * geometry;
    conductance += g;
    tempWeight += g * temperatureC;
    count++;
  }
  // The "+ 1" is the probe's passive leak to ambient, in the same normalised units.
  const equilibriumC = (tempWeight + cfg.ambientTemp) / (conductance + 1);
  return { flux, conductance, equilibriumC, sources: count };
}

/** Signed net irradiance only — see `heatField` for the full picture. */
export function radiantFlux(point, sources, config = {}, opts = {}) {
  return heatField(point, sources, config, opts).flux;
}

/**
 * Advance the sensor's own temperature by `dtMs`, exactly.
 *
 * `field` is a `heatField` result (it needs BOTH the equilibrium and, conceptually, the
 * path taken). Passing a bare flux number is refused rather than guessed at: a flux alone
 * has no temperature ceiling, and quietly re-deriving one from it is exactly the bug this
 * function used to contain.
 *
 * Exponential integration is not a nicety: a naive `T += (T_eq − T)·dt/τ` goes unstable and
 * oscillates once `dt > τ`, which is exactly what happens when a user drags the Time slider
 * up, and an oscillating sensor reads as a buggy robot rather than a stiff ODE.
 */
export function stepSensorTemperature(state, field, dtMs, config = {}) {
  const cfg = heatConfig(config);
  if (field !== null && typeof field === 'object' && Number.isFinite(field.equilibriumC)) {
    // the normal path
  } else {
    throw new TypeError(
      'stepSensorTemperature needs a heatField() result ({ equilibriumC, … }); a bare flux '
      + 'number has no bound, which is how the probe used to read hotter than its source.',
    );
  }
  const equilibrium = field.equilibriumC;
  const dt = Math.max(0, num(dtMs, 1000 / 60));
  const prev = Number.isFinite(state?.temperatureC) ? state.temperatureC : cfg.ambientTemp;
  const tau = cfg.timeConstantMs;
  const temperatureC = tau <= 0
    ? equilibrium // massless probe: tracks the field instantly
    : equilibrium + (prev - equilibrium) * Math.exp(-dt / tau);
  return {
    temperatureC,
    equilibriumC: equilibrium,
    flux: num(field.flux, 0),
    conductance: num(field.conductance, 0),
    // seconds of exposure, for tests and for a "how long has it been warm" readout
    warmMs: (Number.isFinite(state?.warmMs) ? state.warmMs : 0) + (temperatureC > cfg.ambientTemp ? dt : 0),
  };
}

/**
 * Map the sensor's temperature onto the [0,1] the wiring system expects: linear in DEGREES
 * above ambient, `outputSpanC` reaching full scale. Ambient reads exactly 0, and the value
 * is clamped so a robot never receives a number outside the range every other sensor uses.
 * (A sensor cooler than ambient clamps to 0 too — an inverted sensor is what the polarity
 * control is for, not a negative output.)
 */
export function heatOutput(temperatureC, config = {}) {
  const cfg = heatConfig(config);
  if (!Number.isFinite(temperatureC)) return 0;
  const v = (temperatureC - cfg.ambientTemp) / cfg.outputSpanC;
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/**
 * The largest distance at which a source still holds the sensor at or above `thresholdC`
 * above ambient — used to draw the beam at its TRUE reach rather than an arbitrary circle.
 *
 * Derived from the bounded equilibrium, not from flux. With ΔT = Ĝ(T_s − T_a)/(Ĝ + 1), the
 * conductance needed for a threshold rise is
 *        Ĝ_req = ΔT / ((T_s − T_a) − ΔT)
 * which is only solvable while ΔT < T_s − T_a — a restatement of "the probe never reaches
 * the source temperature", and the reason a threshold above the source's own rise has no
 * reach at all rather than an infinite one.
 *
 * Transparent air then inverts in closed form (`Ĝ = coupling·lin·(d0/r)²`); with absorption
 * there is no closed form (`e^(−r/L)/r²`), so it is bisected — monotone decreasing, so
 * bisection is exact to the iteration count and cannot miss a root.
 */
export function heatEffectiveRange(sources, config = {}, center = { x: 0, y: 0 }, opts = {}) {
  const cfg = heatConfig(config);
  const range = Number.isFinite(config?.range) ? config.range : Infinity;
  // Threshold defaults to a tenth of full scale, so the drawn beam matches the output scale.
  const thresholdC = Math.max(1e-9, num(config?.thresholdC, cfg.outputSpanC / 10));
  const absorbing = Number.isFinite(cfg.attenuationLength);
  let best = 0;
  for (const src of sources ?? []) {
    if (!src || !Number.isFinite(src.x) || !Number.isFinite(src.y)) continue;
    const dx = src.x - center.x;
    const dy = src.y - center.y;
    const d = Math.hypot(dx, dy);
    if (d > range) continue;
    if (!inFov(Math.atan2(dy, dx), opts)) continue;
    const temperatureC = num(src.temperatureC, cfg.ambientTemp);
    const power = radiantPower(temperatureC, cfg);
    if (power <= 0) continue; // cold sinks draw no beam
    // A threshold at or above the source's own temperature rise is unreachable, by the bound.
    const rise = temperatureC - cfg.ambientTemp;
    if (rise <= thresholdC) continue;
    const required = thresholdC / (rise - thresholdC);
    const available = cfg.coupling * linearizedConductance(temperatureC, cfg);
    if (!(available > 0) || !(required > 0)) continue;
    let reach;
    if (!absorbing) {
      // coupling·lin·(d0/r)² = Ĝ_req  ⟹  r = d0·√(coupling·lin / Ĝ_req)
      reach = cfg.referenceDistance * Math.sqrt(available / required);
    } else {
      // f(r) = coupling·lin·(d0/r)²·e^(−r/L) − Ĝ_req, decreasing in r.
      const f = (r) => available * Math.pow(cfg.referenceDistance / Math.max(r, cfg.minDistance), 2) * Math.exp(-r / cfg.attenuationLength) - required;
      if (f(0) < 0) continue;
      let lo = 0;
      let hi = Math.min(range, Math.max(cfg.minDistance, 1));
      // Grow the bracket until the signal has certainly dropped below threshold.
      let guard = 0;
      while (f(hi) > 0 && hi < range && guard++ < 64) hi = Math.min(range, hi * 2);
      if (f(hi) > 0) { reach = hi; }
      else {
        for (let i = 0; i < 48; i++) {
          const mid = (lo + hi) / 2;
          if (f(mid) > 0) lo = mid; else hi = mid;
        }
        reach = (lo + hi) / 2;
      }
    }
    const capped = Math.min(reach, range);
    if (capped > best) best = capped;
  }
  return best;
}
