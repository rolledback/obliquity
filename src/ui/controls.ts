// lil-gui control panel bound to the application state.

import { GUI } from 'lil-gui';
import { AXIS_MODE_LABELS, cloneConfig } from '../astro/config';
import type { AxisMode, RotationConfig } from '../astro/config';
import { compileFormula } from '../astro/formula';
import { maxPoleStep } from '../astro/orientation';
import { spinReverses } from '../astro/daypath';
import { CITIES, NOTABLE_DATES } from '../astro/presets';
import { FORMULA_EXAMPLES } from '../formulaExamples';
import {
  CUSTOM_NAME,
  SCENARIO_NAMES,
  applyScenario,
  scenarioDescription,
  scenarioSetup,
} from '../scenarios';
import type { AppState } from '../state';

export interface ControlElements {
  /** Left-hand panel container (View + Time). */
  left: HTMLElement;
  /** Right-hand panel container (Rotation, Axis behaviour, Location). */
  right: HTMLElement;
  scenarioSelect: HTMLSelectElement;
  scenarioPrev: HTMLButtonElement;
  scenarioNext: HTMLButtonElement;
  scenarioRandom: HTMLButtonElement;
  scenarioDesc: HTMLElement;
}

export interface ControlHandlers {
  /** Recompute scene + plots after any change. */
  onChange: () => void;
}

export interface ControlsApi {
  /** Refresh the date/hour controllers (called while animating). */
  refreshTime(): void;
  /** Refresh the Play toggle (called when playback is paused programmatically). */
  refreshPlay(): void;
  /** Refresh the Speed slider (called when the speed is lowered programmatically). */
  refreshSpeed(): void;
  /** Refresh every controller (called after scenario/city changes). */
  refreshAll(): void;
  /** Adapt the View controls to the active 3D view (orbit vs sky). */
  setViewContext(): void;
  /** Adapt the Time controls to the active chart tab (e.g. the Year-only slider). */
  setPlotContext(): void;
  /** Refresh the Location controllers (called when the map sets a new place). */
  refreshLocation(): void;
}

export function buildControls(
  els: ControlElements,
  state: AppState,
  handlers: ControlHandlers,
): ControlsApi {
  const change = handlers.onChange;
  const leftGui = new GUI({ container: els.left, title: 'View & Time', width: 250 });
  const rightGui = new GUI({ container: els.right, title: 'Controls', width: 290 });

  const axisModeOptions: Record<string, AxisMode> = {};
  (Object.keys(AXIS_MODE_LABELS) as AxisMode[]).forEach((mode) => {
    axisModeOptions[AXIS_MODE_LABELS[mode]] = mode;
  });

  // --- Scenario picker (lives in the top bar) ------------------------------
  // A native <select> so arrow keys cycle scenarios live while the animation keeps
  // running. The "Custom" entry is disabled so it shows when you hand-tune controls but
  // arrow-key navigation skips over it.
  const pickableNames = SCENARIO_NAMES.filter((n) => n !== CUSTOM_NAME);
  // "Custom" is a returnable state, not a preset: it stays disabled until you have actually
  // hand-tuned a world (or opened a shared custom link), at which point selecting it restores
  // your last tweaks. lastCustomConfig holds that snapshot; customOption is its dropdown entry.
  let customOption: HTMLOptionElement | null = null;
  let lastCustomConfig: RotationConfig | null = null;
  for (const name of SCENARIO_NAMES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === CUSTOM_NAME) {
      opt.disabled = true; // enabled by captureCustom once a custom config exists
      customOption = opt;
    }
    els.scenarioSelect.appendChild(opt);
  }
  els.scenarioSelect.value = state.scenario;

  // Snapshot the current config as the returnable "Custom" world and enable its dropdown entry.
  function captureCustom() {
    lastCustomConfig = cloneConfig(state.config);
    if (customOption) customOption.disabled = false;
  }

  function showDescription(name: string) {
    const text = scenarioDescription(name);
    els.scenarioDesc.textContent = text;
    els.scenarioDesc.title = text;
  }
  showDescription(state.scenario);

  els.scenarioSelect.addEventListener('change', () => selectScenario(els.scenarioSelect.value));
  // Arrow keys cycle scenarios live (no dropdown popup, no native value quirks), so the
  // simulation keeps animating uninterrupted while you flip through worlds.
  els.scenarioSelect.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      stepScenario(1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      stepScenario(-1);
    }
  });
  els.scenarioPrev.addEventListener('click', () => stepScenario(-1));
  els.scenarioNext.addEventListener('click', () => stepScenario(1));
  els.scenarioRandom.addEventListener('click', () => {
    let name = state.scenario;
    while (name === state.scenario && pickableNames.length > 1) {
      name = pickableNames[Math.floor(Math.random() * pickableNames.length)];
    }
    selectScenario(name);
  });

  // Step to the previous/next scenario, skipping the Custom sentinel and wrapping around.
  function stepScenario(dir: number) {
    let idx = pickableNames.indexOf(state.scenario);
    if (idx < 0) idx = dir > 0 ? -1 : 0; // coming from Custom: next -> first, prev -> last
    const nextIdx = (idx + dir + pickableNames.length) % pickableNames.length;
    selectScenario(pickableNames[nextIdx]);
  }

  // Apply a scenario by name and refresh both panels. The animation loop is untouched, so
  // cycling scenarios never pauses or restarts the simulation.
  function selectScenario(name: string) {
    state.scenario = name;
    if (name === CUSTOM_NAME) {
      // Restore the last hand-tuned world (the entry is only selectable once one exists).
      if (lastCustomConfig) Object.assign(state.config, lastCustomConfig);
    } else {
      applyScenario(state.config, name);
    }
    state.orbit = 0; // a freshly loaded world starts at Year 1
    // Optional scenario side-effect: snap the observer to a place. Built-ins only; choosing
    // Custom leaves you wherever you are (scenarioSetup has no entry for it).
    const setup = scenarioSetup(name);
    if (setup.location) {
      state.latDeg = setup.location.latDeg;
      state.lonDeg = setup.location.lonDeg;
      state.city = setup.location.city;
    }
    updateModeVisibility();
    syncFormulaDraft();
    refreshAllControllers();
    els.scenarioSelect.value = name;
    showDescription(name);
    change();
  }

  // When the user hand-edits a rotation parameter, flip the label to "Custom".
  function markCustom() {
    if (state.scenario !== CUSTOM_NAME) {
      state.scenario = CUSTOM_NAME;
      els.scenarioSelect.value = CUSTOM_NAME;
      showDescription(CUSTOM_NAME);
    }
  }
  const changeCustom = () => {
    markCustom();
    change();
    captureCustom(); // remember this hand-tuned world so "Custom" can return to it
  };

  // Formula drafts (tilt, lean, spin). Each text field edits this draft, not the config
  // directly, so a formula that fails to parse leaves the last good one running instead of
  // breaking the simulation. Declared before the controls that bind to it.
  const formulaDraft = {
    tilt: state.config.tiltFormula,
    lean: state.config.leanFormula,
    spin: state.config.spinFormula,
  };
  const FORMULA_HINT =
    'Tilt and lean dir are degrees. Inputs: phase 0..1, lon 0..360, year/t (grows), ' +
    'orbit, day. Smooth helpers: wave(x)=sin(2\u03C0x), sind, cosd, sat, smooth, lerp.';
  const SPIN_HINT =
    'Spin speed as a multiple of the period above: 1 is normal, below 1 slows the spin, ' +
    '0 stops it. Same inputs as above, e.g. 0.55+0.45*cwave(phase) stretches summer days.';

  // --- Rotation ------------------------------------------------------------
  const rot = rightGui.addFolder('Rotation');
  const tiltCtrl = rot.add(state.config, 'obliquityDeg', 0, 180, 0.1).name('Axial tilt (\u00B0)').onChange(changeCustom);
  const leanDirCtrl = rot.add(state.config, 'axisLongitudeDeg', 0, 360, 1).name('Axis lean dir (\u00B0)').onChange(changeCustom);
  rot.add(state.config, 'rotationPeriodHours', 1, 120, 0.1).name('Rotation period (h)').onChange(changeCustom);
  rot.add(state.config, 'prograde').name('Prograde spin').onChange(changeCustom);
  const spinFormulaCtrl = rot
    .add(formulaDraft, 'spin')
    .name('Spin speed \u00D7 f(\u2026)')
    .onFinishChange(commitSpinFormula);
  const spinMsg = document.createElement('div');
  spinMsg.className = 'formula-hint';
  spinFormulaCtrl.domElement.insertAdjacentElement('afterend', spinMsg);

  // --- Axis behaviour ------------------------------------------------------
  const axis = rightGui.addFolder('Axis behaviour');
  axis
    .add(state.config, 'axisMode', axisModeOptions)
    .name('Mode')
    .onChange(() => {
      updateModeVisibility();
      changeCustom();
    });
  const precCtrl = axis
    .add(state.config, 'precessionTurnsPerYear', -5, 5, 0.1)
    .name('Precession (turns/yr)')
    .onChange(changeCustom);
  const obAmpCtrl = axis
    .add(state.config, 'obliquityAmplitudeDeg', 0, 60, 0.5)
    .name('Tilt wobble (\u00B0)')
    .onChange(changeCustom);
  const rollCtrl = axis
    .add(state.config, 'rollAmplitudeDeg', 0, 120, 1)
    .name('Nodding (\u00B0)')
    .onChange(changeCustom);

  // --- Formula mode controls (shown only when axisMode === 'formula') ------
  const tiltFormulaCtrl = axis
    .add(formulaDraft, 'tilt')
    .name('Tilt = f(\u2026)')
    .onFinishChange(commitFormulas);
  const leanFormulaCtrl = axis
    .add(formulaDraft, 'lean')
    .name('Lean dir = f(\u2026)')
    .onFinishChange(commitFormulas);

  const formulaMsg = document.createElement('div');
  formulaMsg.className = 'formula-hint';
  formulaMsg.textContent = FORMULA_HINT;
  leanFormulaCtrl.domElement.insertAdjacentElement('afterend', formulaMsg);

  const EXAMPLE_PLACEHOLDER = 'load an example\u2026';
  const examplePick = { name: EXAMPLE_PLACEHOLDER };
  const exampleNames = [EXAMPLE_PLACEHOLDER, ...FORMULA_EXAMPLES.map((e) => e.name)];
  const exampleCtrl = axis
    .add(examplePick, 'name', exampleNames)
    .name('Examples')
    .onChange((name: string) => {
      examplePick.name = EXAMPLE_PLACEHOLDER;
      exampleCtrl.updateDisplay();
      if (name !== EXAMPLE_PLACEHOLDER) selectScenario(name);
    });

  // Validate both drafts, paint the message box, and return whether both are valid.
  // Parse errors block the commit; a non-smooth (Sun-teleporting) formula is allowed but
  // earns a gentle, non-blocking heads-up so the user can choose smoothness or chaos.
  const SMOOTH_JUMP_LIMIT = 0.05; // |Δ pole| per quarter-degree; ~3deg pole jump
  function validateFormulas(): boolean {
    const errs: string[] = [];
    const tiltErr = compileFormula(formulaDraft.tilt).error;
    const leanErr = compileFormula(formulaDraft.lean).error;
    if (tiltErr) errs.push(`Tilt: ${tiltErr}`);
    if (leanErr) errs.push(`Lean: ${leanErr}`);
    if (errs.length > 0) {
      formulaMsg.textContent = errs.join('   ');
      formulaMsg.classList.toggle('formula-error', true);
      formulaMsg.classList.toggle('formula-warn', false);
      return false;
    }
    const rough = formulaSmoothnessWarning();
    formulaMsg.textContent = rough ?? FORMULA_HINT;
    formulaMsg.classList.toggle('formula-error', false);
    formulaMsg.classList.toggle('formula-warn', rough !== null);
    return true;
  }

  // A heads-up string when the current drafts make the Sun jump rather than glide, else
  // null. Probes the pole path on a throwaway config so it works before the commit.
  function formulaSmoothnessWarning(): string | null {
    const probe = cloneConfig(state.config);
    probe.axisMode = 'formula';
    probe.tiltFormula = formulaDraft.tilt;
    probe.leanFormula = formulaDraft.lean;
    return maxPoleStep(probe) > SMOOTH_JUMP_LIMIT
      ? 'Heads up: this formula jumps the Sun suddenly somewhere in the year (not smooth). It still runs, but for a glide use wave()/sind() or whole multiples at the year wrap.'
      : null;
  }

  // Commit the drafts to the config when they parse; otherwise keep the last good ones.
  function commitFormulas() {
    if (!validateFormulas()) return;
    state.config.tiltFormula = formulaDraft.tilt;
    state.config.leanFormula = formulaDraft.lean;
    changeCustom();
  }

  // Validate the spin draft and paint its message. Parse errors block the commit; a valid
  // non-default formula shows the hint so the inputs are discoverable, and the plain "1"
  // default stays quiet.
  function validateSpinFormula(): boolean {
    const err = compileFormula(formulaDraft.spin).error;
    if (err) {
      spinMsg.textContent = `Spin: ${err}`;
      spinMsg.classList.toggle('formula-error', true);
      spinMsg.classList.toggle('formula-warn', false);
      spinMsg.style.display = '';
      return false;
    }
    spinMsg.classList.toggle('formula-error', false);
    const active = formulaDraft.spin.trim() !== '' && formulaDraft.spin.trim() !== '1';
    // A spin that crosses zero reverses the planet; warn that the orbit view jolts at the
    // standstill (the sky charts stay correct), but allow it.
    const probe = cloneConfig(state.config);
    probe.spinFormula = formulaDraft.spin;
    const reverses = active && spinReverses(probe);
    spinMsg.classList.toggle('formula-warn', reverses);
    spinMsg.textContent = reverses
      ? 'Heads up: this spin reverses through a standstill, so the orbit view jumps once at the turnaround (the sky charts stay correct). Keep the speed positive for a smooth spin.'
      : active
        ? SPIN_HINT
        : '';
    spinMsg.style.display = active ? '' : 'none';
    return true;
  }

  function commitSpinFormula() {
    if (!validateSpinFormula()) return;
    state.config.spinFormula = formulaDraft.spin;
    changeCustom();
  }

  // Pull the active config formulas back into the draft fields (after a scenario loads).
  function syncFormulaDraft() {
    formulaDraft.tilt = state.config.tiltFormula;
    formulaDraft.lean = state.config.leanFormula;
    formulaDraft.spin = state.config.spinFormula;
    tiltFormulaCtrl.updateDisplay();
    leanFormulaCtrl.updateDisplay();
    spinFormulaCtrl.updateDisplay();
    validateFormulas();
    validateSpinFormula();
  }

  function updateModeVisibility() {
    const mode = state.config.axisMode;
    precCtrl.show(mode === 'precession');
    obAmpCtrl.show(mode === 'obliquityWave');
    rollCtrl.show(mode === 'rollWave');
    const formula = mode === 'formula';
    // In formula mode the base tilt and lean sliders are overridden by the formulas, so
    // hide them to avoid the impression that moving them does anything.
    tiltCtrl.show(!formula);
    leanDirCtrl.show(!formula);
    tiltFormulaCtrl.show(formula);
    leanFormulaCtrl.show(formula);
    exampleCtrl.show(formula);
    formulaMsg.style.display = formula ? '' : 'none';
  }
  updateModeVisibility();
  validateSpinFormula(); // set the spin hint/message visibility for the initial config

  function refreshAllControllers() {
    leftGui.controllersRecursive().forEach((c) => c.updateDisplay());
    rightGui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  // --- Location ------------------------------------------------------------
  const loc = rightGui.addFolder('Location');
  const cityOptions = ['Custom', ...CITIES.map((c) => c.name)];
  const cityCtrl = loc
    .add(state, 'city', cityOptions)
    .name('Place')
    .onChange((name: string) => {
      const city = CITIES.find((c) => c.name === name);
      if (city) {
        state.latDeg = city.latDeg;
        state.lonDeg = city.lonDeg;
        latCtrl.updateDisplay();
        lonCtrl.updateDisplay();
      }
      change();
    });
  const latCtrl = loc
    .add(state, 'latDeg', -90, 90, 0.1)
    .name('Latitude')
    .onChange(() => {
      state.city = 'Custom';
      cityCtrl.updateDisplay();
      change();
    });
  const lonCtrl = loc
    .add(state, 'lonDeg', -180, 180, 0.1)
    .name('Longitude')
    .onChange(() => {
      state.city = 'Custom';
      cityCtrl.updateDisplay();
      change();
    });

  // --- Time ----------------------------------------------------------------
  const time = leftGui.addFolder('Time');
  const dateOptions: Record<string, number> = { 'jump to a date\u2026': -1 };
  NOTABLE_DATES.forEach((d) => (dateOptions[d.name] = d.dayOfYear));
  const jump = { date: -1 };
  const dateCtrl = time
    .add(jump, 'date', dateOptions)
    .name('Notable date')
    .onChange((day: number) => {
      if (day > 0) {
        state.dayOfYear = day;
        dayCtrl.updateDisplay();
        change();
      }
      // Snap the dropdown back to the placeholder so the same date can be picked again
      // (a native <select> fires no change event when re-choosing the current value).
      jump.date = -1;
      dateCtrl.updateDisplay();
    });
  const dayCtrl = time
    .add(state, 'dayOfYear', 1, 365, 0.25)
    .name('Day of year')
    .onChange(change);
  const hourCtrl = time
    .add(state, 'timeOfDay', 0, 24, 0.05)
    .name('Local solar time')
    .onChange(change);
  const playCtrl = time.add(state, 'playing').name('Play');
  const speedCtrl = time.add(state, 'speed', 0, 600, 1).name('Speed (sim h/s)');
  const yearsCtrl = time
    .add(state, 'yearsShown', 1, 24, 1)
    .name('Years shown')
    .onChange(change);

  // --- View ----------------------------------------------------------------
  // Everything here drives the 3D orbit scene, so these controllers are hidden in Sky
  // view via updateViewVisibility.
  const view = leftGui.addFolder('View');
  const followCtrl = view.add(state, 'followEarth').name('Follow Earth');
  const orbitViewCtrls = [
    followCtrl,
    view.add(state.show, 'axis').name('Axis'),
    view.add(state.show, 'equator').name('Equator'),
    view.add(state.show, 'orbit').name('Orbit path'),
    view.add(state.show, 'marker').name('Location pin'),
    view.add(state.show, 'subsolar').name('Sub-solar point'),
    view.add(state.show, 'sunline').name('Earth-to-Sun line'),
    view.add(state.show, 'grid').name('Ecliptic grid'),
    view.add(state.show, 'stars').name('Stars'),
  ];

  // Sky-view-only toggles. These deliberately have no .onChange: they only affect the 3D
  // sky scene, which updateScene() re-reads and redraws every animation frame, so flipping
  // the state value is enough (no plot recompute is needed).
  const skyViewCtrls = [
    view.add(state, 'followSun').name('Follow the Sun'),
    view.add(state, 'skyGrid').name('Sky grid'),
    view.add(state, 'sunTrail').name('Sun trail'),
  ];
  function updateViewVisibility() {
    const orbit = state.viewMode === 'orbit';
    orbitViewCtrls.forEach((c) => c.show(orbit));
    skyViewCtrls.forEach((c) => c.show(!orbit));
  }
  updateViewVisibility();

  // The "Years shown" slider drives both multi-year charts (the Year heatmap and the
  // Climate curve), so show it on those tabs and hide it on the single-day chart.
  function updatePlotVisibility() {
    yearsCtrl.show(state.plotMode === 'year' || state.plotMode === 'climate');
  }
  updatePlotVisibility();

  // A shared custom link starts the app already in Custom; make that world returnable too
  // (so switching to a built-in and back restores it).
  if (state.scenario === CUSTOM_NAME) captureCustom();

  return {
    refreshTime() {
      dayCtrl.updateDisplay();
      hourCtrl.updateDisplay();
    },
    refreshPlay() {
      playCtrl.updateDisplay();
    },
    refreshSpeed() {
      speedCtrl.updateDisplay();
    },
    refreshAll() {
      updateModeVisibility();
      syncFormulaDraft();
      refreshAllControllers();
    },
    setViewContext() {
      updateViewVisibility();
    },
    setPlotContext() {
      updatePlotVisibility();
    },
    refreshLocation() {
      cityCtrl.updateDisplay();
      latCtrl.updateDisplay();
      lonCtrl.updateDisplay();
    },
  };
}
