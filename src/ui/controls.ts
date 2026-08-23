import { CALENDAR_DAYS } from '../astro/calendar';
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
} from '../scenarios';
import type { AppState } from '../state';

export interface ControlElements {
  left: HTMLElement;
  right: HTMLElement;
  scenarioSelect: HTMLSelectElement;
  scenarioPrev: HTMLButtonElement;
  scenarioNext: HTMLButtonElement;
  scenarioRandom: HTMLButtonElement;
  scenarioDesc: HTMLElement;
}

export interface ControlHandlers {
  onChange: () => void;
  /** Jump to a visible total eclipse, or report that none was found. */
  onFindEclipse?: (type: 'solar' | 'lunar', backwards: boolean) => void;
}

export interface ControlsApi {
  refreshTime(): void;
  refreshPlay(): void;
  refreshSpeed(): void;
  refreshAll(): void;
  setViewContext(): void;
  setPlotContext(): void;
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
  // Keep Custom disabled until saved, and skip it during arrow-key cycling.
  const pickableNames = SCENARIO_NAMES.filter((n) => n !== CUSTOM_NAME);
  let customOption: HTMLOptionElement | null = null;
  let lastCustomConfig: RotationConfig | null = null;
  for (const name of SCENARIO_NAMES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === CUSTOM_NAME) {
      opt.disabled = true;
      customOption = opt;
    }
    els.scenarioSelect.appendChild(opt);
  }
  els.scenarioSelect.value = state.scenario;

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

  function stepScenario(dir: number) {
    let idx = pickableNames.indexOf(state.scenario);
    if (idx < 0) idx = dir > 0 ? -1 : 0;
    const nextIdx = (idx + dir + pickableNames.length) % pickableNames.length;
    selectScenario(pickableNames[nextIdx]);
  }

  function selectScenario(name: string) {
    state.scenario = name;
    if (name === CUSTOM_NAME) {
      if (lastCustomConfig) Object.assign(state.config, lastCustomConfig);
    } else {
      applyScenario(state.config, name);
    }
    state.orbit = 0;
    updateModeVisibility();
    syncFormulaDraft();
    refreshAllControllers();
    els.scenarioSelect.value = name;
    showDescription(name);
    change();
  }

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
    captureCustom();
  };

  // Drafts keep invalid formulas from replacing the last working configuration.
  const formulaDraft = {
    tilt: state.config.tiltFormula,
    lean: state.config.leanFormula,
    spin: state.config.spinFormula,
  };
  const FORMULA_HINT =
    'Tilt and lean dir are degrees. Inputs: phase 0..1, lon 0..360, year/t (grows), ' +
    'orbit, day, plus lat/site for where you are standing. Smooth helpers: ' +
    'wave(x)=sin(2\u03C0x), sind, cosd, sat, smooth, lerp.';
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

  // Rough formulas remain valid, but receive a non-blocking warning.
  const SMOOTH_JUMP_LIMIT = 0.05; // About a 3 degree pole jump per quarter-degree.
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

  // Probe a clone so validation cannot mutate the active configuration.
  function formulaSmoothnessWarning(): string | null {
    const probe = cloneConfig(state.config);
    probe.axisMode = 'formula';
    probe.tiltFormula = formulaDraft.tilt;
    probe.leanFormula = formulaDraft.lean;
    return maxPoleStep(probe) > SMOOTH_JUMP_LIMIT
      ? 'Heads up: this formula jumps the Sun suddenly somewhere in the year (not smooth). It still runs, but for a glide use wave()/sind() or whole multiples at the year wrap.'
      : null;
  }

  function commitFormulas() {
    if (!validateFormulas()) return;
    state.config.tiltFormula = formulaDraft.tilt;
    state.config.leanFormula = formulaDraft.lean;
    changeCustom();
  }

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
    // Reversing spin is valid, but the orbit view jolts at the standstill.
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
    // Formula mode overrides the base sliders, so hide controls that would do nothing.
    tiltCtrl.show(!formula);
    leanDirCtrl.show(!formula);
    tiltFormulaCtrl.show(formula);
    leanFormulaCtrl.show(formula);
    exampleCtrl.show(formula);
    formulaMsg.style.display = formula ? '' : 'none';
  }
  updateModeVisibility();
  validateSpinFormula();

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
      // Reset because selecting the same native option again emits no change event.
      jump.date = -1;
      dateCtrl.updateDisplay();
    });
  const dayCtrl = time
    .add(state, 'dayOfYear', 1, CALENDAR_DAYS, 0.25)
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
  const view = leftGui.addFolder('View');
  const followCtrl = view.add(state, 'followEarth').name('Follow Earth');
  // True scale requires following Earth, otherwise it leaves the camera's view.
  const trueScaleCtrl = view
    .add(state, 'trueScale')
    .name('True scale')
    .onChange(() => {
      if (state.trueScale) state.followEarth = true;
      followCtrl.enable(!state.trueScale).updateDisplay();
      // The scene reads display settings every frame, so no recompute is needed.
    });
  const orbitViewCtrls = [
    followCtrl,
    trueScaleCtrl,
    view.add(state.show, 'axis').name('Axis'),
    view.add(state.show, 'equator').name('Equator'),
    view.add(state.show, 'orbit').name('Orbit path'),
    view.add(state.show, 'marker').name('Location pin'),
    view.add(state.show, 'subsolar').name('Sub-solar point'),
    view.add(state.show, 'sunline').name('Earth-to-Sun line'),
    view.add(state.show, 'grid').name('Ecliptic grid'),
    view.add(state.show, 'stars').name('Stars'),
    view.add(state.show, 'moonOrbit').name("Moon's orbit"),
  ];

  view.add(state.show, 'moon').name('Moon').onChange(change);

  // Sky display settings are read every frame and need no change callback.
  const skyViewCtrls = [
    view.add(state, 'followSun').name('Follow the Sun'),
    view.add(state, 'skyGrid').name('Sky grid'),
    view.add(state, 'sunTrail').name('Sun trail'),
  ];
  function updateViewVisibility() {
    const orbit = state.viewMode === 'orbit';
    followCtrl.enable(!state.trueScale).updateDisplay();
    orbitViewCtrls.forEach((c) => c.show(orbit));
    skyViewCtrls.forEach((c) => c.show(!orbit));
  }
  updateViewVisibility();

  // --- Eclipses -------------------------------------------------------------
  // Totality is too brief and rare to find by scrubbing, so jump directly to it.
  const eclipses = leftGui.addFolder('Eclipses');

  const makeJumpRow = (label: string, type: 'solar' | 'lunar') => {
    const row = document.createElement('div');
    row.className = 'eclipse-row';
    const title = document.createElement('span');
    title.className = 'eclipse-row-label';
    title.textContent = label;
    const prev = document.createElement('button');
    prev.className = 'eclipse-btn';
    prev.textContent = '\u25C0 Prev';
    const next = document.createElement('button');
    next.className = 'eclipse-btn';
    next.textContent = 'Next \u25B6';

    const go = (backwards: boolean) => {
      if (!handlers.onFindEclipse) return;
      const btn = backwards ? prev : next;
      const restore = btn.textContent;
      // Pin the width so the narrow loading label does not make the control jump.
      btn.style.minWidth = `${btn.offsetWidth}px`;
      btn.textContent = '\u2026';
      prev.disabled = true;
      next.disabled = true;
      // Yield so the loading state paints before the synchronous search.
      setTimeout(() => {
        handlers.onFindEclipse!(type, backwards);
        btn.textContent = restore;
        prev.disabled = false;
        next.disabled = false;
      }, 0);
    };
    prev.addEventListener('click', () => go(true));
    next.addEventListener('click', () => go(false));

    row.append(title, prev, next);
    return row;
  };

  eclipses.$children.append(
    makeJumpRow('Total solar', 'solar'),
    makeJumpRow('Total lunar', 'lunar'),
  );
  // Start occasional settings collapsed to leave the scene unobstructed.
  view.close();
  eclipses.close();

  // Hide Years shown on the day tab, where it would do nothing.
  function updatePlotVisibility() {
    yearsCtrl.show(state.plotMode === 'year' || state.plotMode === 'climate');
  }
  updatePlotVisibility();

  // Preserve a custom world loaded from a share link.
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
