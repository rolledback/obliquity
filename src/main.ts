import './style.css';
import { Scene3D } from './scene/scene3d';
import type { SceneState } from './scene/scene3d';
import { SkyView } from './scene/skyview';
import { SkyPlot } from './ui/skyplot';
import { YearPlot } from './ui/yearplot';
import { ClimatePlot } from './ui/climateplot';
import type { TimePick } from './ui/plot';
import { buildControls } from './ui/controls';
import { LocationMap } from './ui/locationmap';
import { BottomStrip } from './ui/bottomStrip';
import {
  accumulatedSunLonDeg,
  advanceTime,
  clockLabel,
  currentSpinDeg,
  defaultState,
  setObserverLocation,
} from './state';
import { storageGet, storageSet } from './storage';
import { applyShare, buildShareUrl, parseShareFromUrl } from './share';
import { REALISTIC, sunLongitudeDeg } from './astro/config';
import type { RotationConfig } from './astro/config';
import { computeDayPath, solarDayHours } from './astro/daypath';
import { sunAltAzAt } from './astro/sun';
import { seasonCycle, warmthAt } from './astro/season';
import { compass16 } from './ui/draw';
import { dayOfYearLabel } from './astro/presets';
import { posMod, clamp } from './astro/vec';

const REALISTIC_COLOR = '#ffce54';
const CUSTOM_COLOR = '#5ec8ff';

const sceneEl = document.getElementById('scene') as HTMLElement;
const guiContainer = document.getElementById('gui-container') as HTMLElement;
const guiLeft = document.getElementById('gui-left') as HTMLElement;
const readoutEl = document.getElementById('readout') as HTMLElement;
const hintEl = document.getElementById('scene-hint') as HTMLElement;
const headingEl = document.getElementById('heading-readout') as HTMLElement;
const viewToggleEl = document.getElementById('view-toggle') as HTMLElement;
const appEl = document.getElementById('app') as HTMLElement;
const plotsResizerEl = document.getElementById('plots-resizer') as HTMLElement;
const scenarioEls = {
  scenarioSelect: document.getElementById('scenario-select') as HTMLSelectElement,
  scenarioPrev: document.getElementById('scenario-prev') as HTMLButtonElement,
  scenarioNext: document.getElementById('scenario-next') as HTMLButtonElement,
  scenarioRandom: document.getElementById('scenario-random') as HTMLButtonElement,
  scenarioDesc: document.getElementById('scenario-desc') as HTMLElement,
};

function panelParts(config: 'realistic' | 'custom') {
  const panel = document.querySelector(`.panel[data-config="${config}"]`) as HTMLElement;
  return {
    canvas: panel.querySelector('canvas.skyplot') as HTMLCanvasElement,
    stats: panel.querySelector('.stats') as HTMLElement,
    banner: panel.querySelector('.banner') as HTMLElement,
    caption: panel.querySelector('.panel-caption') as HTMLElement,
  };
}

const realisticParts = panelParts('realistic');
const customParts = panelParts('custom');
const plotModeToggleEl = document.getElementById('plot-mode-toggle') as HTMLElement;

const state = defaultState();
// A ?s=<slug> or ?c=<payload> link prefills the scenario before the UI is built, so the whole
// app simply initialises from the shared world (the recipient keeps their own place and time).
const incomingShare = parseShareFromUrl();
if (incomingShare) applyShare(state, incomingShare);
const scene = new Scene3D(sceneEl);
const skyView = new SkyView(sceneEl);

// The two comparison columns (Real Earth, Your Earth), described once and driven by loops
// everywhere below. Each column owns the three plot renderers that share its canvas. `config`
// is the rotation config it draws: REALISTIC is a const, and state.config is mutated in place
// (never reassigned), so both references stay valid for the app's lifetime.
interface Panel {
  id: 'realGraph' | 'customGraph';
  parts: ReturnType<typeof panelParts>;
  config: RotationConfig;
  color: string;
  day: SkyPlot;
  year: YearPlot;
  climate: ClimatePlot;
}
function makePanel(
  id: Panel['id'],
  parts: ReturnType<typeof panelParts>,
  config: RotationConfig,
  color: string,
): Panel {
  return {
    id,
    parts,
    config,
    color,
    day: new SkyPlot(parts.canvas, parts.stats, parts.banner),
    year: new YearPlot(parts.canvas, parts.stats, parts.banner),
    climate: new ClimatePlot(parts.canvas, parts.stats, parts.banner),
  };
}
const panels: Panel[] = [
  makePanel('realGraph', realisticParts, REALISTIC, REALISTIC_COLOR),
  makePanel('customGraph', customParts, state.config, CUSTOM_COLOR),
];

const mapPanel = document.querySelector('.panel[data-view-id="locationMap"]') as HTMLElement;
const locationMap = new LocationMap(
  mapPanel.querySelector('canvas.earth-map') as HTMLCanvasElement,
  mapPanel.querySelector('.stats') as HTMLElement,
  (latDeg, lonDeg) => {
    setObserverLocation(state, latDeg, lonDeg);
    state.city = 'Custom';
    applyAll();
    controls.refreshLocation();
    controls.refreshTime(); // the local-solar clock shifted with longitude
  },
);

const DAY_CAPTION = 'Sun\u2019s height in the sky, midnight to midnight';
const YEAR_CAPTION = 'Sun\u2019s height across the whole year';
const CLIMATE_CAPTION = 'Felt warmth through the year (Sun-driven, with thermal lag)';

function recomputePlots() {
  const { dayOfYear, latDeg, lonDeg, timeOfDay, orbit } = state;
  const axisPhase = accumulatedSunLonDeg(state);
  const shown = panels.filter((p) => state.bottomViews.includes(p.id));
  if (shown.length === 0) return; // no graph columns shown: nothing to draw

  if (state.plotMode === 'year') {
    const years = Math.max(1, Math.round(state.yearsShown));
    for (const p of shown) p.year.render({ config: p.config, latDeg, dayOfYear, timeOfDay, orbit, years });
    return;
  }

  if (state.plotMode === 'climate') {
    const years = Math.max(1, Math.round(state.yearsShown));
    // Real Earth is a stable reference: its own warmth scale, independent of the scenario.
    const realisticWarmthMax = seasonCycle(REALISTIC, latDeg).warmthMax;
    for (const p of shown) {
      // Your Earth scales to its own warmth, but never below Real Earth's amplitude so a
      // near-seasonless world still reads as flat instead of being zoomed up into noise.
      const ownWarmthMax =
        p.id === 'realGraph' ? realisticWarmthMax : seasonCycle(p.config, latDeg, orbit).warmthMax;
      const yMax = Math.max(realisticWarmthMax, ownWarmthMax, 1e-3) * 1.08;
      p.climate.render({ config: p.config, latDeg, orbit, dayOfYear, yMax, years });
    }
    return;
  }

  const nowFrac = timeOfDay / 24;
  for (const p of shown) {
    p.day.render({
      path: computeDayPath(p.config, dayOfYear, latDeg, lonDeg, undefined, axisPhase),
      dayOfYear,
      accent: p.color,
      nowFrac,
    });
  }
}

function setPlotMode(mode: 'day' | 'year' | 'climate') {
  state.plotMode = mode;
  const caption = mode === 'year' ? YEAR_CAPTION : mode === 'climate' ? CLIMATE_CAPTION : DAY_CAPTION;
  for (const p of panels) p.parts.caption.textContent = caption;
  plotModeToggleEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode);
  });
  controls.setPlotContext();
  recomputePlots();
}

// Configurable bottom view strip (0-3 resizable columns). The controller (layout, resizers,
// chips, and localStorage persistence) lives in src/ui/bottomStrip.ts; it is created below
// once the plot panels and recomputePlots are ready.
const stripEl = document.getElementById('bottom-view-strip') as HTMLElement;

function currentAltAz() {
  return sunAltAzAt(
    state.config,
    state.dayOfYear,
    currentSpinDeg(state),
    state.latDeg,
    state.lonDeg,
    accumulatedSunLonDeg(state),
  );
}

function updateScene() {
  if (state.viewMode === 'orbit') {
    const sceneState: SceneState = {
      config: state.config,
      dayOfYear: state.dayOfYear,
      spinDeg: currentSpinDeg(state),
      latDeg: state.latDeg,
      lonDeg: state.lonDeg,
      show: state.show,
      followEarth: state.followEarth,
      axisPhaseLonDeg: accumulatedSunLonDeg(state),
    };
    scene.update(sceneState);
  } else {
    const warmth = warmthAt(state.config, state.latDeg, state.orbit, state.dayOfYear);
    skyView.setTrailEnabled(state.sunTrail);
    skyView.setGridVisible(state.skyGrid);
    const aa = currentAltAz();
    skyView.update({ altDeg: aa.altDeg, azDeg: aa.azDeg, warmth, followSun: state.followSun });
    skyView.pushTrail(aa.altDeg, aa.azDeg);
  }
}

function updateHeading() {
  if (state.viewMode !== 'ground') return;
  const { azDeg, altDeg } = skyView.getHeading();
  const tilt = altDeg >= 0 ? `${altDeg.toFixed(0)}\u00B0 up` : `${Math.abs(altDeg).toFixed(0)}\u00B0 down`;
  headingEl.textContent = `Facing ${compass16(azDeg)} (${azDeg.toFixed(0)}\u00B0) \u00B7 ${tilt}`;
}

function updateReadout() {
  const yearLabel = state.orbit > 0 ? `, Year ${state.orbit + 1}` : '';
  const { altDeg, azDeg } = currentAltAz();
  const solar = solarDayHours(state.config, sunLongitudeDeg(state.dayOfYear), accumulatedSunLonDeg(state));
  const solarLabel = Number.isFinite(solar) ? `${solar.toFixed(2)} h` : 'none';
  const altLabel = altDeg >= 0 ? `${altDeg.toFixed(1)}\u00B0 up` : `${altDeg.toFixed(1)}\u00B0`;
  readoutEl.innerHTML =
    `<b>${dayOfYearLabel(state.dayOfYear)}${yearLabel}</b> ${clockLabel(state.timeOfDay)} ` +
    `&middot; Sun <b>${altLabel}</b>, az ${azDeg.toFixed(0)}\u00B0 ` +
    `&middot; solar day <b>${solarLabel}</b>`;
}

function setViewMode(mode: 'orbit' | 'ground') {
  state.viewMode = mode;
  scene.setEnabled(mode === 'orbit');
  skyView.setEnabled(mode === 'ground');
  skyView.clearTrail(); // switching views starts the trail fresh
  hintEl.textContent =
    mode === 'orbit' ? 'Drag to orbit \u00B7 scroll to zoom' : 'Drag to look around \u00B7 scroll to zoom';
  headingEl.hidden = mode !== 'ground';
  viewToggleEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.view === mode);
  });
  if (mode === 'orbit') scene.resize();
  controls.setViewContext();
  updateScene();
  updateHeading();
}

function applyAll() {
  // A user-driven change can move the Sun discontinuously, so drop the recorded trail
  // to avoid drawing a streak across the jump; updateScene re-seeds it at the new spot.
  skyView.clearTrail();
  recomputePlots();
  updateScene();
  updateReadout();
  locationMap.setLocation(state.latDeg, state.lonDeg);
}

const controls = buildControls(
  { left: guiLeft, right: guiContainer, ...scenarioEls },
  state,
  { onChange: applyAll },
);

viewToggleEl.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => setViewMode((b as HTMLElement).dataset.view as 'orbit' | 'ground'));
});

plotModeToggleEl.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => setPlotMode((b as HTMLElement).dataset.mode as 'day' | 'year' | 'climate'));
});

// Share: copy a link that reloads the current scenario (a built-in by name slug, a hand-tuned
// world as an encoded config). Also reflected in the address bar so a reload keeps the world.
const shareBtn = document.getElementById('scenario-share') as HTMLButtonElement;
const shareToastEl = document.getElementById('share-toast') as HTMLElement;
let shareToastTimer = 0;
function showShareToast(message: string) {
  shareToastEl.textContent = message;
  shareToastEl.hidden = false;
  void shareToastEl.offsetWidth; // restart the fade-in transition
  shareToastEl.classList.add('show');
  clearTimeout(shareToastTimer);
  shareToastTimer = window.setTimeout(() => {
    shareToastEl.classList.remove('show');
    setTimeout(() => { shareToastEl.hidden = true; }, 220);
  }, 1900);
}
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
shareBtn.addEventListener('click', async () => {
  const url = buildShareUrl(state);
  try { history.replaceState(null, '', url); } catch { /* ignore (e.g. file:// origin) */ }
  const ok = await copyText(url);
  showShareToast(ok ? 'Link copied to clipboard' : 'Link is in the address bar');
});

// --- Photosensitivity guard -------------------------------------------------
// Speeding up the Sky view makes the whole screen flash between day and night. We warn before
// that flashing can begin, and freeze time while the warning is up so nothing flashes behind it.
// The check is rate-based (day/night cycles per real second = speed / solar-day length), so it
// fires for EVERY path into fast flashing: turning up Speed, pressing Play, switching into Sky
// view, or shortening the rotation period / spin formula - all raise the cycle rate, and all are
// caught as a rising edge in the frame loop below.
const FLASH_KEY = 'obliquity:flash-warning-dismissed';
const FLASH_HZ = 3; // day/night cycles per second; WCAG's general-flash threshold
const SAFE_FLASH_HZ = 2; // target rate for "slow down": comfortably under the threshold

const flashModalEl = document.getElementById('flash-modal') as HTMLElement;
const flashDontAskEl = document.getElementById('flash-dont-ask') as HTMLInputElement;
const flashContinueBtn = document.getElementById('flash-continue') as HTMLButtonElement;
const flashSlowBtn = document.getElementById('flash-slow') as HTMLButtonElement;
const flashCancelBtn = document.getElementById('flash-cancel') as HTMLButtonElement;

let flashDontAsk = storageGet(FLASH_KEY) === '1';
let flashModalOpen = false;
let flashAcknowledged = false; // user chose "show me" for the current flashing episode
let wasFlashing = false;

/** The current Sky view solar-day length in hours, or 0 when it cannot flash (frozen/locked). */
function currentSolarDayHours(): number {
  const solar = solarDayHours(state.config, sunLongitudeDeg(state.dayOfYear), accumulatedSunLonDeg(state));
  return Number.isFinite(solar) && solar > 0 ? solar : 0;
}

/** Day/night cycles per real second the Sky view would show now (0 if it cannot flash). */
function skyFlashRate(): number {
  if (state.viewMode !== 'ground' || !state.playing || state.speed <= 0) return 0;
  const solar = currentSolarDayHours();
  return solar > 0 ? state.speed / solar : 0;
}

/** Watch for the rising edge into fast flashing and prompt once; re-arm when it calms down. */
function updateFlashGuard() {
  const flashing = skyFlashRate() >= FLASH_HZ;
  if (flashing && !wasFlashing && !flashModalOpen && !flashAcknowledged && !flashDontAsk) {
    openFlashModal();
  }
  if (!flashing) flashAcknowledged = false; // left the flashing zone: ask again next time
  wasFlashing = flashing;
}

function openFlashModal() {
  flashModalOpen = true; // freezes time in the frame loop, so the sky holds still behind it
  flashDontAskEl.checked = false;
  flashModalEl.hidden = false;
  flashSlowBtn.focus(); // the recommended, safe-but-watchable choice
}

type FlashChoice = 'play' | 'slow' | 'pause';

function resolveFlash(choice: FlashChoice) {
  if (!flashModalOpen) return;
  if (flashDontAskEl.checked) {
    flashDontAsk = true;
    storageSet(FLASH_KEY, '1');
  }
  flashModalOpen = false;
  flashModalEl.hidden = true;
  flashAcknowledged = false;

  if (choice === 'play') {
    flashAcknowledged = true; // play on at the current speed
  } else if (choice === 'slow') {
    // Drop the speed to the fastest that still stays under the flash threshold and keep
    // playing, so people can watch the motion safely. If even the slowest non-zero speed
    // would flash (an extremely short day), pause instead.
    const solar = currentSolarDayHours();
    const safeSpeed = Math.floor(SAFE_FLASH_HZ * solar);
    if (safeSpeed >= 1) {
      state.speed = Math.min(safeSpeed, state.speed); // never speed up
      controls.refreshSpeed();
    } else {
      state.playing = false;
      controls.refreshPlay();
    }
  } else {
    state.playing = false; // pause: the universally safe outcome for any trigger
    controls.refreshPlay();
  }
  wasFlashing = skyFlashRate() >= FLASH_HZ; // resync the edge tracker to the resolved state
}

flashContinueBtn.addEventListener('click', () => resolveFlash('play'));
flashSlowBtn.addEventListener('click', () => resolveFlash('slow'));
flashCancelBtn.addEventListener('click', () => resolveFlash('pause'));
// Clicking the dimmed backdrop, or pressing Escape, is the safe choice (keep it paused).
flashModalEl.addEventListener('click', (e) => {
  if (e.target === flashModalEl) resolveFlash('pause');
});
window.addEventListener('keydown', (e) => {
  if (flashModalOpen && e.key === 'Escape') {
    e.preventDefault();
    resolveFlash('pause');
  }
});

// The bottom-view strip controller: restores the saved layout, builds the columns, and owns
// the toolbar chips, per-panel close buttons, column resizers, and layout persistence
// (see src/ui/bottomStrip.ts).
const bottomStrip = new BottomStrip({
  state,
  stripEl,
  plotModeToggleEl,
  locationMap,
  onLayoutChange: recomputePlots,
});
// Sync the chart-tab UI (active button, caption, Years-slider visibility) to the default
// plot mode, since the markup starts with the Day tab marked active.
setPlotMode(state.plotMode);

window.addEventListener('resize', () => {
  // Keep the split valid for the new viewport, then re-render everything to fit.
  setPlotsHeight(currentPlotsHeight());
});

// --- Resizable split between the simulation and the charts ------------------
// The plots occupy the last grid row, whose height is the --plots-height variable.
// Dragging the divider rewrites that variable and re-runs the same resize path the
// window-resize handler uses, so the 3D view and the charts re-fit crisply.
const PLOTS_MIN = 120; // never collapse the charts past readability
const SCENE_MIN = 160; // always leave the simulation a usable slab
const PLOTS_DEFAULT = 320;
const PLOTS_STORAGE_KEY = 'obliquity:plots-height';

function syncViewportToLayout() {
  if (state.viewMode === 'orbit') scene.resize();
  else skyView.resize();
  bottomStrip.resizeViews();
  recomputePlots();
}

function currentPlotsHeight(): number {
  return parseFloat(getComputedStyle(appEl).getPropertyValue('--plots-height')) || PLOTS_DEFAULT;
}

function clampPlotsHeight(px: number): number {
  const sceneTop = sceneEl.getBoundingClientRect().top;
  const available = window.innerHeight - sceneTop - plotsResizerEl.offsetHeight;
  const maxPlots = Math.max(PLOTS_MIN, available - SCENE_MIN);
  return Math.round(clamp(px, PLOTS_MIN, maxPlots));
}

function setPlotsHeight(px: number) {
  appEl.style.setProperty('--plots-height', `${clampPlotsHeight(px)}px`);
  syncViewportToLayout();
}

// Restore a previously chosen split (clamped to the current viewport).
const savedPlots = Number(storageGet(PLOTS_STORAGE_KEY));
if (Number.isFinite(savedPlots) && savedPlots >= PLOTS_MIN) {
  appEl.style.setProperty('--plots-height', `${clampPlotsHeight(savedPlots)}px`);
}

let resizing = false;
let lastDownAt = 0;
plotsResizerEl.addEventListener('pointerdown', (e) => {
  // preventDefault on every press (not just the drag path) so a quick double-press to
  // reset never leaks into native double-click text selection.
  e.preventDefault();
  // Manual double-press detection: preventDefault (needed to suppress text selection while
  // dragging) also suppresses the native dblclick, so we detect a quick second press here
  // and treat it as "reset to default".
  const now = performance.now();
  if (now - lastDownAt < 350) {
    lastDownAt = 0;
    setPlotsHeight(PLOTS_DEFAULT);
    storageSet(PLOTS_STORAGE_KEY, String(currentPlotsHeight()));
    return;
  }
  lastDownAt = now;
  resizing = true;
  plotsResizerEl.classList.add('dragging');
  plotsResizerEl.setPointerCapture(e.pointerId);
});
plotsResizerEl.addEventListener('pointermove', (e) => {
  if (resizing) setPlotsHeight(window.innerHeight - e.clientY);
});
function endResize(e: PointerEvent) {
  if (!resizing) return;
  resizing = false;
  plotsResizerEl.classList.remove('dragging');
  try {
    plotsResizerEl.releasePointerCapture(e.pointerId);
  } catch {
    // no-op: capture may already be gone
  }
  storageSet(PLOTS_STORAGE_KEY, String(currentPlotsHeight()));
}
plotsResizerEl.addEventListener('pointerup', endResize);
plotsResizerEl.addEventListener('pointercancel', endResize);

// Keyboard accessibility: nudge the split when the divider is focused.
plotsResizerEl.addEventListener('keydown', (e) => {
  const stepFor = (key: string) => (key === 'ArrowUp' ? 16 : key === 'ArrowDown' ? -16 : 0);
  const step = stepFor(e.key);
  if (step === 0) return;
  setPlotsHeight(currentPlotsHeight() + step);
  storageSet(PLOTS_STORAGE_KEY, String(currentPlotsHeight()));
  e.preventDefault();
});

// --- Scrub the simulation by dragging the "now" dot on any chart -------------
// Each plot maps a pointer position back to a moment in time (pickTime): the day chart
// scrubs the local solar time, the climate chart scrubs the day (and which year, for a
// multi-year cycle), and the year heatmap scrubs both day and time of day. Dragging on
// either panel moves the shared clock, since both panels share the same time axes.
function activePlot(p: Panel): SkyPlot | YearPlot | ClimatePlot {
  return state.plotMode === 'year' ? p.year : state.plotMode === 'climate' ? p.climate : p.day;
}

function applyTimePick(pick: TimePick) {
  if (pick.timeOfDay != null) state.timeOfDay = posMod(pick.timeOfDay, 24);
  if (pick.dayOfYear != null) state.dayOfYear = clamp(pick.dayOfYear, 1, 365);
  if (pick.orbit != null) state.orbit = pick.orbit;
}

let scrubbing = false;
function scrubTo(pick: TimePick) {
  applyTimePick(pick);
  applyAll(); // clears the Sun trail (a time jump) and recomputes plots, scene and readout
  controls.refreshTime(); // keep the GUI date/hour fields in step with the drag
}

for (const panel of panels) {
  const c = panel.parts.canvas;
  const localPos = (e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  c.addEventListener('pointerdown', (e) => {
    const { x, y } = localPos(e);
    const pick = activePlot(panel).pickTime(x, y, false);
    if (!pick) return; // pressed outside the plotting area (axis labels, margins)
    scrubbing = true;
    c.classList.add('scrubbing');
    c.setPointerCapture(e.pointerId);
    e.preventDefault();
    scrubTo(pick);
  });
  c.addEventListener('pointermove', (e) => {
    const { x, y } = localPos(e);
    if (scrubbing) {
      const pick = activePlot(panel).pickTime(x, y, true);
      if (pick) scrubTo(pick);
    } else {
      // Hover affordance: show a scrub cursor only over the chart itself.
      const pick = activePlot(panel).pickTime(x, y, false);
      c.style.cursor = pick ? (state.plotMode === 'year' ? 'crosshair' : 'ew-resize') : '';
    }
  });
  const endScrub = (e: PointerEvent) => {
    if (!scrubbing) return;
    scrubbing = false;
    c.classList.remove('scrubbing');
    try {
      c.releasePointerCapture(e.pointerId);
    } catch {
      // no-op: capture may already be gone
    }
  };
  c.addEventListener('pointerup', endScrub);
  c.addEventListener('pointercancel', endScrub);
  c.addEventListener('pointerleave', () => {
    if (!scrubbing) c.style.cursor = '';
  });
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  // Catch any transition into fast flashing before advancing time; a freeze keeps the sky
  // static while the warning is shown.
  updateFlashGuard();

  if (state.playing && state.speed > 0 && !scrubbing && !flashModalOpen) {
    advanceTime(state, dt);
    controls.refreshTime();
    recomputePlots();
  }

  updateScene();
  updateReadout();
  if (state.viewMode === 'orbit') {
    scene.render();
  } else {
    skyView.render();
    updateHeading();
  }
  requestAnimationFrame(frame);
}

// Initial paint (after layout settles so canvases have a size).
requestAnimationFrame(() => {
  scene.resize();
  applyAll();
  last = performance.now();
  requestAnimationFrame(frame);
});
