import './style.css';
import { Scene3D } from './scene/scene3d';
import type { SceneState } from './scene/scene3d';
import { SkyView } from './scene/skyview';
import type { SkyMoonState } from './scene/skyMoon';
import { SkyPlot } from './ui/skyplot';
import { YearPlot } from './ui/yearplot';
import { ClimatePlot } from './ui/climateplot';
import type { TimePick } from './ui/plot';
import { alignedSpanStart } from './ui/plot';
import { buildControls } from './ui/controls';
import { LocationMap } from './ui/locationmap';
import { BottomStrip } from './ui/bottomStrip';
import {
  accumulatedSunLonDeg,
  advanceTime,
  setLocalSolarTime,
  setToNow,
  timeRate,
  clockLabel,
  currentSpinDeg,
  defaultState,
  setObserverLocation,
  syncSiteToConfig,
} from './state';
import { storageGet, storageSet } from './storage';
import { applyShare, buildShareUrl, parseShareFromUrl } from './share';
import { REALISTIC, axisConfigKey, spinConfigKey, sunLongitudeDeg } from './astro/config';
import type { RotationConfig } from './astro/config';
import { CALENDAR_DAYS, absDaysFrom, dateFromAbsDays } from './astro/calendar';
import { computeDayPath, earthMatrixAtLocalTime, localSolarTimeAt, solarDayHours } from './astro/daypath';
import { sunAltAzAt, directionAltAz } from './astro/sun';
import { sunDirEcliptic } from './astro/orientation';
import { moonStateAt, moonTopocentric, phaseGlyph, topocentricIlluminated } from './astro/moon';
import { lunarEclipseAt, solarEclipseAt, solarShadowCentreKm } from './astro/eclipse';
import { findNextEclipse } from './astro/eclipseFinder';
import { seasonCycle, warmthAt } from './astro/season';
import { compass16 } from './ui/draw';
import { calendarLabel } from './astro/presets';
import { posMod, clamp, scale as scaleV3 } from './astro/vec';

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
// Apply shared rotation settings before building their controls.
const incomingShare = parseShareFromUrl();
if (incomingShare) applyShare(state, incomingShare);
// Start at the present, so the sky matches what is outside the window.
setToNow(state);
// Location-aware formulas need the shared location before their first validation.
syncSiteToConfig(state);
const scene = new Scene3D(sceneEl);
const skyView = new SkyView(sceneEl);

// Each comparison panel owns three renderers that share one canvas.
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
    controls.refreshTime(); // Longitude shifts local solar time.
  },
);

const DAY_CAPTION = 'Sun\u2019s height in the sky, midnight to midnight';
const YEAR_CAPTION = 'Sun\u2019s height across the whole year';
const CLIMATE_CAPTION = 'Felt warmth through the year (Sun-driven, with thermal lag)';

// A total eclipse at one spot is rare, so this usually finds nothing; searching every frame
// would still cost the whole hunt, hence the cache.
const eclipseMarkCache = new Map<string, { orbit: number; dayOfYear: number; timeOfDay: number }[]>();

function totalEclipseMarks(
  config: RotationConfig,
  latDeg: number,
  lonDeg: number,
  orbit: number,
  years: number,
): { orbit: number; dayOfYear: number; timeOfDay: number }[] {
  const spanStart = alignedSpanStart(orbit, years);
  const key = `${axisConfigKey(config)}|${spinConfigKey(config)}|${latDeg}|${lonDeg}|${spanStart}|${years}`;
  const hit = eclipseMarkCache.get(key);
  if (hit) return hit;

  const marks: { orbit: number; dayOfYear: number; timeOfDay: number }[] = [];
  const endAbs = absDaysFrom(spanStart + years, 1);
  let searchOrbit = spanStart;
  let searchDay = 1;
  for (let i = 0; i < 64; i++) {
    const found = findNextEclipse('solar', config, latDeg, lonDeg, searchOrbit, searchDay, {
      kinds: ['total'],
      maxYears: years + 1,
      clock: (t) => localSolarTimeAt(config, t, lonDeg),
    });
    if (!found || found.absDays >= endAbs) break;
    marks.push({ orbit: found.orbit, dayOfYear: found.dayOfYear, timeOfDay: found.timeOfDay });
    searchOrbit = found.orbit;
    searchDay = found.dayOfYear + 0.05;
  }
  if (eclipseMarkCache.size > 24) eclipseMarkCache.clear();
  eclipseMarkCache.set(key, marks);
  return marks;
}

function recomputePlots() {
  const { dayOfYear, latDeg, lonDeg, timeOfDay, orbit } = state;
  const axisPhase = accumulatedSunLonDeg(state);
  const shown = panels.filter((p) => state.bottomViews.includes(p.id));
  if (shown.length === 0) return;

  if (state.plotMode === 'year') {
    const years = Math.max(1, Math.round(state.yearsShown));
    for (const p of shown) {
      p.year.render({
        config: p.config,
        latDeg,
        dayOfYear,
        timeOfDay,
        orbit,
        years,
        eclipses: totalEclipseMarks(p.config, latDeg, lonDeg, orbit, years),
      });
    }
    return;
  }

  if (state.plotMode === 'climate') {
    const years = Math.max(1, Math.round(state.yearsShown));
    // Keep Real Earth's scale independent of the custom scenario.
    const realisticWarmthMax = seasonCycle(REALISTIC, latDeg).warmthMax;
    for (const p of shown) {
      // Never magnify a near-seasonless custom world above Real Earth's reference scale.
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

type MoonMoment = ReturnType<typeof computeMoonMoment>;

// When shown, compute lunar state once per paint so views and readout agree.
function computeMoonMoment() {
  const absDays = absDaysFrom(state.orbit, state.dayOfYear);
  const moon = moonStateAt(absDays);
  const M = earthMatrixAtLocalTime(
    state.config,
    state.orbit,
    state.dayOfYear,
    state.lonDeg,
    state.timeOfDay,
  );
  const solar = solarEclipseAt(moon, M, state.latDeg, state.lonDeg);
  const lunar = lunarEclipseAt(moon);
  const topo = moonTopocentric(moon, M, state.latDeg, state.lonDeg);
  const altAz = directionAltAz(M, topo.dir, state.latDeg, state.lonDeg);
  const sunAltAz = directionAltAz(
    M,
    sunDirEcliptic(moon.sunLonDeg),
    state.latDeg,
    state.lonDeg,
  );
  return {
    absDays,
    moon,
    M,
    solar,
    lunar,
    topo,
    altAz,
    // An eclipse is locally visible only while the Sun is above the horizon.
    solarVisible: solar.kind !== 'none' && sunAltAz.altDeg > 0,
  };
}

function paint() {
  const moment = state.show.moon ? computeMoonMoment() : null;
  updateScene(moment);
  updateReadout(moment);
}

function updateScene(moonMoment: MoonMoment | null) {
  if (state.viewMode === 'orbit') {
    const sceneState: SceneState = {
      config: state.config,
      dayOfYear: state.dayOfYear,
      spinDeg: currentSpinDeg(state),
      latDeg: state.latDeg,
      lonDeg: state.lonDeg,
      show: state.show,
      followEarth: state.followEarth,
      trueScale: state.trueScale,
      axisPhaseLonDeg: accumulatedSunLonDeg(state),
      moon: moonMoment?.moon,
      absDays: moonMoment?.absDays,
      lunarEclipse: moonMoment?.lunar,
      shadowCentreKm: moonMoment ? solarShadowCentreKm(moonMoment.moon) : null,
    };
    scene.update(sceneState);
  } else {
    const warmth = warmthAt(state.config, state.latDeg, state.orbit, state.dayOfYear);
    skyView.setTrailEnabled(state.sunTrail);
    skyView.setMoonTrailEnabled(state.moonTrail);
    skyView.setGridVisible(state.skyGrid);
    const aa = currentAltAz();
    let moonState: SkyMoonState | undefined;
    let sunRadiusDeg: number | undefined;
    let solarObscuration = 0;
    if (moonMoment) {
      const { moon, lunar, solar, topo, altAz, M } = moonMoment;
      // A lunar eclipse's umbral bite is centered on the anti-solar point.
      const antiSun = directionAltAz(
        M,
        scaleV3(sunDirEcliptic(moon.sunLonDeg), -1),
        state.latDeg,
        state.lonDeg,
      );
      // The ecliptic pole approximates lunar north within the Moon's 1.54 degree tilt.
      const north = directionAltAz(M, [0, 0, 1], state.latDeg, state.lonDeg);
      moonState = {
        altDeg: altAz.altDeg,
        azDeg: altAz.azDeg,
        illuminated: topocentricIlluminated(moon, M, state.latDeg, state.lonDeg),
        radiusDeg: topo.angularRadiusDeg,
        umbralBite: lunar.kind === 'partial' || lunar.kind === 'total',
        umbraRadii: lunar.umbraRadii,
        missRadii: lunar.missRadii,
        antiSunAltDeg: antiSun.altDeg,
        antiSunAzDeg: antiSun.azDeg,
        northAltDeg: north.altDeg,
        northAzDeg: north.azDeg,
      };
      sunRadiusDeg = solar.sunRadiusDeg || undefined;
      // Do not dim the sky for an eclipse below the horizon.
      solarObscuration = moonMoment.solarVisible ? solar.obscuration : 0;
    }
    skyView.update({
      altDeg: aa.altDeg,
      azDeg: aa.azDeg,
      warmth,
      followSun: state.followSun,
      followMoon: state.followMoon,
      moon: moonState,
      sunRadiusDeg,
      solarObscuration,
    });
    skyView.pushTrail(aa.altDeg, aa.azDeg);
  }
}

function updateHeading() {
  if (state.viewMode !== 'ground') return;
  const { azDeg, altDeg } = skyView.getHeading();
  const tilt = altDeg >= 0 ? `${altDeg.toFixed(0)}\u00B0 up` : `${Math.abs(altDeg).toFixed(0)}\u00B0 down`;
  headingEl.textContent = `Facing ${compass16(azDeg)} (${azDeg.toFixed(0)}\u00B0) \u00B7 ${tilt}`;
}

function updateReadout(moonMoment: MoonMoment | null) {
  const { altDeg, azDeg } = currentAltAz();
  const solar = solarDayHours(state.config, sunLongitudeDeg(state.dayOfYear), accumulatedSunLonDeg(state));
  const solarLabel = Number.isFinite(solar) ? `${solar.toFixed(2)} h` : 'none';
  const altLabel = altDeg >= 0 ? `${altDeg.toFixed(1)}\u00B0 up` : `${altDeg.toFixed(1)}\u00B0`;
  let moonLabel = '';
  if (state.show.moon) {
    const m = moonMoment ?? computeMoonMoment();
    const up = m.altAz.altDeg >= 0 ? `${m.altAz.altDeg.toFixed(0)}\u00B0 up` : 'below';
    moonLabel =
      ` &middot; Moon ${phaseGlyph(m.moon.illuminated, m.moon.waxing)} ` +
      `${Math.round(m.moon.illuminated * 100)}%, ${up}`;
  }
  readoutEl.innerHTML =
    `<b>${calendarLabel(state.orbit, state.dayOfYear, state.lonDeg)}</b> ` +
    `<span class="ro-wall" title="The same moment on your own clock, in your time zone.">${wallClockLabel(state.orbit, state.dayOfYear)}</span> ` +
    `<span class="ro-solar" title="Local apparent solar time: noon is when the Sun is highest where the pin is. It differs from clock time by daylight saving and by how far the pin sits from its time zone's meridian.">${clockLabel(state.timeOfDay)} solar</span> ` +
    `&middot; Sun <b>${altLabel}</b>, az ${azDeg.toFixed(0)}\u00B0 ` +
    `&middot; solar day <b>${solarLabel}</b>${moonLabel}`;
}

function setViewMode(mode: 'orbit' | 'ground') {
  state.viewMode = mode;
  scene.setEnabled(mode === 'orbit');
  skyView.setEnabled(mode === 'ground');
  skyView.clearTrail();
  hintEl.textContent =
    mode === 'orbit' ? 'Drag to orbit \u00B7 scroll to zoom' : 'Drag to look around \u00B7 scroll to zoom';
  headingEl.hidden = mode !== 'ground';
  viewToggleEl.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.view === mode);
  });
  if (mode === 'orbit') scene.resize();
  controls.setViewContext();
  paint();
  updateHeading();
}

function applyAll() {
  // Sync location before evaluating formulas that reference the observer.
  syncSiteToConfig(state);
  skyView.setLocation(state.latDeg, state.lonDeg);
  // Clear the trail before discontinuous user-driven changes.
  skyView.clearTrail();
  recomputePlots();
  paint();
  locationMap.setLocation(state.latDeg, state.lonDeg);
}

const noticeModalEl = document.getElementById('notice-modal') as HTMLElement;
const noticeTitleEl = document.getElementById('notice-modal-title') as HTMLElement;
const noticeBodyEl = document.getElementById('notice-modal-body') as HTMLElement;
const noticeOkBtn = document.getElementById('notice-ok') as HTMLButtonElement;

function showNotice(title: string, body: string) {
  noticeTitleEl.textContent = title;
  noticeBodyEl.textContent = body;
  noticeModalEl.hidden = false;
  noticeOkBtn.focus();
}

function closeNotice() {
  noticeModalEl.hidden = true;
}

noticeOkBtn.addEventListener('click', closeNotice);
noticeModalEl.addEventListener('click', (e) => {
  if (e.target === noticeModalEl) closeNotice();
});

/** The simulated instant as your own clock would read it, zone and all. */
function wallClockLabel(orbit: number, dayOfYear: number): string {
  const d = dateFromAbsDays(absDaysFrom(orbit, dayOfYear));
  return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function jumpToNow(): void {
  state.transport = 'paused';
  setToNow(state);
  controls.refreshAll();
  applyAll();
}

/** Jump to a visible total eclipse and pause there. */
function jumpToEclipse(type: 'solar' | 'lunar', backwards: boolean): void {
  // Fixed locations may wait centuries for totality.
  const MAX_YEARS = 600;
  const hit = findNextEclipse(
    type,
    state.config,
    state.latDeg,
    state.lonDeg,
    state.orbit,
    state.dayOfYear,
    {
      backwards,
      maxYears: MAX_YEARS,
      kinds: ['total'],
      // Keep the observer where they actually are, rather than wherever on their parallel
      // the shadow happens to fall.
      clock: (t) => localSolarTimeAt(state.config, t, state.lonDeg),
    },
  );
  if (!hit) {
    showNotice(
      'No eclipse found',
      `Searching ${backwards ? 'back' : 'forward'} ${MAX_YEARS} years found no total ` +
        `${type} eclipse visible from this location on this world. Totality falls on a ` +
        `narrow track, so most places wait a very long time. Try moving the pin, or ` +
        `reshaping the rotation to carry this spot under the shadow more often.`,
    );
    return;
  }
  state.transport = 'paused';
  state.orbit = hit.orbit;
  state.dayOfYear = hit.dayOfYear;
  state.timeOfDay = hit.timeOfDay;
  state.show.moon = true;
  controls.refreshAll();
  applyAll();

}

const controls = buildControls(
  { left: guiLeft, right: guiContainer, ...scenarioEls },
  state,
  {
    onChange: applyAll,
    onFindEclipse: jumpToEclipse,
    onJumpToNow: jumpToNow,
    onSetLocalTime: (h) => setLocalSolarTime(state, h),
  },
);

viewToggleEl.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => setViewMode((b as HTMLElement).dataset.view as 'orbit' | 'ground'));
});

plotModeToggleEl.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => setPlotMode((b as HTMLElement).dataset.mode as 'day' | 'year' | 'climate'));
});

// Copy the current scenario link and mirror it in the address bar.
const shareBtn = document.getElementById('scenario-share') as HTMLButtonElement;
const shareToastEl = document.getElementById('share-toast') as HTMLElement;
let shareToastTimer = 0;
function showShareToast(message: string) {
  shareToastEl.textContent = message;
  shareToastEl.hidden = false;
  void shareToastEl.offsetWidth; // Restart the fade-in transition.
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
  } catch { /* Fall through to the legacy copy path. */ }
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
  try { history.replaceState(null, '', url); } catch { /* Ignore unsupported origins. */ }
  const ok = await copyText(url);
  showShareToast(ok ? 'Link copied to clipboard' : 'Link is in the address bar');
});

// --- Photosensitivity guard -------------------------------------------------
// Detect the flash rate centrally so every path into rapid day-night cycling is covered.
// Trigger on a rising edge so one flashing episode prompts only once.
const FLASH_KEY = 'obliquity:flash-warning-dismissed';
const FLASH_HZ = 3; // day/night cycles per second; WCAG's general-flash threshold
const SAFE_FLASH_HZ = 2; // Safely below the warning threshold.

const flashModalEl = document.getElementById('flash-modal') as HTMLElement;
const flashDontAskEl = document.getElementById('flash-dont-ask') as HTMLInputElement;
const flashContinueBtn = document.getElementById('flash-continue') as HTMLButtonElement;
const flashSlowBtn = document.getElementById('flash-slow') as HTMLButtonElement;
const flashCancelBtn = document.getElementById('flash-cancel') as HTMLButtonElement;

let flashDontAsk = storageGet(FLASH_KEY) === '1';
let flashModalOpen = false;
let flashAcknowledged = false;
let wasFlashing = false;

/** The current Sky view solar-day length in hours, or 0 when it cannot flash (frozen/locked). */
function currentSolarDayHours(): number {
  const solar = solarDayHours(state.config, sunLongitudeDeg(state.dayOfYear), accumulatedSunLonDeg(state));
  return Number.isFinite(solar) && solar > 0 ? solar : 0;
}

/** Day/night cycles per real second the Sky view would show now (0 if it cannot flash). */
function skyFlashRate(): number {
  const rate = Math.abs(timeRate(state));
  if (state.viewMode !== 'ground' || rate <= 0) return 0;
  const solar = currentSolarDayHours();
  return solar > 0 ? rate / solar : 0;
}

/** Prompt on the rising edge, then re-arm after the flash rate falls. */
function updateFlashGuard() {
  const flashing = skyFlashRate() >= FLASH_HZ;
  if (flashing && !wasFlashing && !flashModalOpen && !flashAcknowledged && !flashDontAsk) {
    openFlashModal();
  }
  if (!flashing) flashAcknowledged = false;
  wasFlashing = flashing;
}

function openFlashModal() {
  flashModalOpen = true; // Freeze the sky behind the warning.
  flashDontAskEl.checked = false;
  flashModalEl.hidden = false;
  flashSlowBtn.focus();
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
    flashAcknowledged = true;
  } else if (choice === 'slow') {
    // Pause if even the slowest nonzero speed exceeds the safe flash rate.
    const solar = currentSolarDayHours();
    // Rewind and fast forward scale the speed, so the cap has to account for them.
    const factor = Math.abs(timeRate(state)) / Math.max(1e-9, Math.abs(state.speed));
    const safeSpeed = Math.floor((SAFE_FLASH_HZ * solar) / Math.max(1, factor));
    if (safeSpeed >= 1) {
      state.speed = Math.sign(state.speed) * Math.min(safeSpeed, Math.abs(state.speed));
      controls.refreshSpeed();
    } else {
      state.transport = 'paused';
      controls.refreshPlay();
    }
  } else {
    state.transport = 'paused';
    controls.refreshPlay();
  }
  wasFlashing = skyFlashRate() >= FLASH_HZ;
}

flashContinueBtn.addEventListener('click', () => resolveFlash('play'));
flashSlowBtn.addEventListener('click', () => resolveFlash('slow'));
flashCancelBtn.addEventListener('click', () => resolveFlash('pause'));
flashModalEl.addEventListener('click', (e) => {
  if (e.target === flashModalEl) resolveFlash('pause');
});
window.addEventListener('keydown', (e) => {
  if (flashModalOpen && e.key === 'Escape') {
    e.preventDefault();
    resolveFlash('pause');
  }
});

const bottomStrip = new BottomStrip({
  state,
  stripEl,
  plotModeToggleEl,
  locationMap,
  onLayoutChange: recomputePlots,
});
setPlotMode(state.plotMode);

window.addEventListener('resize', () => {
  setPlotsHeight(currentPlotsHeight());
});

// --- Resizable split between the simulation and the charts ------------------
const PLOTS_MIN = 120;
const SCENE_MIN = 160;
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

const savedPlots = Number(storageGet(PLOTS_STORAGE_KEY));
if (Number.isFinite(savedPlots) && savedPlots >= PLOTS_MIN) {
  appEl.style.setProperty('--plots-height', `${clampPlotsHeight(savedPlots)}px`);
}

let resizing = false;
let lastDownAt = 0;
plotsResizerEl.addEventListener('pointerdown', (e) => {
  // preventDefault suppresses selection but also suppresses native dblclick.
  e.preventDefault();
  // Detect the reset gesture manually for that reason.
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
  }
  storageSet(PLOTS_STORAGE_KEY, String(currentPlotsHeight()));
}
plotsResizerEl.addEventListener('pointerup', endResize);
plotsResizerEl.addEventListener('pointercancel', endResize);

plotsResizerEl.addEventListener('keydown', (e) => {
  const stepFor = (key: string) => (key === 'ArrowUp' ? 16 : key === 'ArrowDown' ? -16 : 0);
  const step = stepFor(e.key);
  if (step === 0) return;
  setPlotsHeight(currentPlotsHeight() + step);
  storageSet(PLOTS_STORAGE_KEY, String(currentPlotsHeight()));
  e.preventDefault();
});

// --- Scrub the simulation by dragging the "now" dot on any chart -------------
// Charts invert their displayed axes to update the shared clock.
function activePlot(p: Panel): SkyPlot | YearPlot | ClimatePlot {
  return state.plotMode === 'year' ? p.year : state.plotMode === 'climate' ? p.climate : p.day;
}

function applyTimePick(pick: TimePick) {
  if (pick.timeOfDay != null) state.timeOfDay = posMod(pick.timeOfDay, 24);
  if (pick.dayOfYear != null) state.dayOfYear = clamp(pick.dayOfYear, 1, CALENDAR_DAYS);
  if (pick.orbit != null) state.orbit = pick.orbit;
}

let scrubbing = false;
function scrubTo(pick: TimePick) {
  applyTimePick(pick);
  applyAll();
  controls.refreshTime();
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
    if (!pick) return;
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

  // Check the rising edge before time advances into the flashing state.
  updateFlashGuard();

  if (timeRate(state) !== 0 && !scrubbing && !flashModalOpen) {
    advanceTime(state, dt);
    controls.refreshTime();
    recomputePlots();
  }

  paint();
  if (state.viewMode === 'orbit') {
    scene.render();
  } else {
    skyView.render();
    updateHeading();
  }
  requestAnimationFrame(frame);
}

/**
 * Lift the loading state, once there is something real to look at.
 *
 * Called after the first frame rather than on DOMContentLoaded: the shell paints in about
 * 0.6s but the bundle cannot start for seconds after that, and revealing early just shows
 * an empty dropdown and a blank scene. index.html carries a failsafe in case this never runs.
 */
function markReady(): void {
  document.documentElement.classList.add('ready');
  const boot = document.getElementById('boot');
  if (!boot) return;
  const drop = () => boot.remove();
  boot.addEventListener('transitionend', drop, { once: true });
  setTimeout(drop, 600); // in case the transition is skipped or never fires
}

// Wait for layout so canvases have their first size.
requestAnimationFrame(() => {
  scene.resize();
  applyAll();
  last = performance.now();
  frame(last);
  markReady();
});
