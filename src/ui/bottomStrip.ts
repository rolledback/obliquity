import type { AppState, BottomViewId } from '../state';
import { BOTTOM_VIEW_ORDER } from '../state';
import { clamp } from '../astro/vec';
import { storageGet, storageSet } from '../storage';
import type { LocationMap } from './locationmap';

const RESIZER_PX = 8;
const MIN_VIEW_PX: Record<BottomViewId, number> = { realGraph: 260, customGraph: 260, locationMap: 240 };
const BOTTOM_LAYOUT_KEY = 'obliquity:bottom-layout:v2';

export interface BottomStripDeps {
  state: AppState;
  stripEl: HTMLElement;
  plotModeToggleEl: HTMLElement;
  locationMap: LocationMap;
  onLayoutChange: () => void;
}

export class BottomStrip {
  private readonly state: AppState;
  private readonly stripEl: HTMLElement;
  private readonly plotModeToggleEl: HTMLElement;
  private readonly locationMap: LocationMap;
  private readonly onLayoutChange: () => void;
  private readonly panelEls: Record<BottomViewId, HTMLElement>;

  constructor(deps: BottomStripDeps) {
    this.state = deps.state;
    this.stripEl = deps.stripEl;
    this.plotModeToggleEl = deps.plotModeToggleEl;
    this.locationMap = deps.locationMap;
    this.onLayoutChange = deps.onLayoutChange;
    this.panelEls = {
      realGraph: this.stripEl.querySelector('[data-view-id="realGraph"]') as HTMLElement,
      customGraph: this.stripEl.querySelector('[data-view-id="customGraph"]') as HTMLElement,
      locationMap: this.stripEl.querySelector('[data-view-id="locationMap"]') as HTMLElement,
    };

    document.querySelectorAll<HTMLButtonElement>('#bottom-view-toggles .view-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.view as BottomViewId;
        this.setView(id, !this.state.bottomViews.includes(id));
      });
    });
    document.querySelectorAll<HTMLButtonElement>('.panel-close').forEach((btn) => {
      btn.addEventListener('click', () => this.setView(btn.dataset.view as BottomViewId, false));
    });

    this.load();
    this.relayout();
  }

  /** Resize views that do not size themselves during rendering. */
  resizeViews(): void {
    if (this.state.bottomViews.includes('locationMap')) this.locationMap.resize();
  }

  /** Rebuild the visible panels, resizers, and columns. */
  relayout(): void {
    const visible = this.visibleViews();
    this.stripEl.replaceChildren(); // Detach without recreating the persistent panels.
    if (visible.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'No views shown \u00B7 add one with the buttons above.';
      this.stripEl.appendChild(hint);
      this.stripEl.style.gridTemplateColumns = '1fr';
    } else {
      visible.forEach((v, i) => {
        if (i > 0) this.stripEl.appendChild(this.makeColResizer(visible[i - 1], v));
        this.stripEl.appendChild(this.panelEls[v]);
      });
      this.applyColumns();
    }
    document.querySelectorAll<HTMLButtonElement>('#bottom-view-toggles .view-chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', String(this.state.bottomViews.includes(chip.dataset.view as BottomViewId)));
    });
    const hasGraph =
      this.state.bottomViews.includes('realGraph') || this.state.bottomViews.includes('customGraph');
    this.plotModeToggleEl.classList.toggle('disabled', !hasGraph);
    this.resizeViews();
    this.onLayoutChange();
  }

  private visibleViews(): BottomViewId[] {
    return BOTTOM_VIEW_ORDER.filter((v) => this.state.bottomViews.includes(v));
  }

  private stripColumns(visible: BottomViewId[]): string {
    const cols: string[] = [];
    visible.forEach((v, i) => {
      if (i > 0) cols.push(`${RESIZER_PX}px`);
      cols.push(`minmax(${MIN_VIEW_PX[v]}px, ${this.state.bottomViewWeights[v]}fr)`);
    });
    return cols.join(' ');
  }

  private applyColumns(): void {
    this.stripEl.style.gridTemplateColumns = this.stripColumns(this.visibleViews());
  }

  private refreshSizing(persist = false): void {
    this.applyColumns();
    this.resizeViews();
    this.onLayoutChange();
    if (persist) this.save();
  }

  private setView(id: BottomViewId, on: boolean): void {
    if (on === this.state.bottomViews.includes(id)) return;
    this.state.bottomViews = on
      ? BOTTOM_VIEW_ORDER.filter((v) => v === id || this.state.bottomViews.includes(v))
      : this.state.bottomViews.filter((v) => v !== id);
    this.relayout();
    this.save();
  }

  // Preserve the two neighboring columns' total weight while dragging.
  private makeColResizer(leftId: BottomViewId, rightId: BottomViewId): HTMLElement {
    const el = document.createElement('div');
    el.className = 'plot-col-resizer';
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'vertical');
    el.tabIndex = 0;
    const weights = this.state.bottomViewWeights;
    let startX = 0, startPxL = 0, startPxR = 0, startWL = 0, startWR = 0, raf = 0;

    const onMove = (e: PointerEvent) => {
      const total = startPxL + startPxR;
      const newPxL = clamp(startPxL + (e.clientX - startX), MIN_VIEW_PX[leftId], total - MIN_VIEW_PX[rightId]);
      const wSum = startWL + startWR;
      const wL = (newPxL / total) * wSum;
      weights[leftId] = wL;
      weights[rightId] = wSum - wL;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.refreshSizing(); });
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startPxL = this.panelEls[leftId].offsetWidth;
      startPxR = this.panelEls[rightId].offsetWidth;
      startWL = weights[leftId];
      startWR = weights[rightId];
      el.classList.add('dragging');
      el.setPointerCapture(e.pointerId);
      el.addEventListener('pointermove', onMove);
    });
    const end = (e: PointerEvent) => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', onMove);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      this.save();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => this.resetWidths());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.resetWidths(); return; }
      const wSum = weights[leftId] + weights[rightId];
      const stepFrac = (e.shiftKey ? 0.1 : 0.03) * wSum;
      let wL = weights[leftId];
      if (e.key === 'ArrowLeft') wL = Math.max(0.1, wL - stepFrac);
      else if (e.key === 'ArrowRight') wL = Math.min(wSum - 0.1, wL + stepFrac);
      else return;
      e.preventDefault();
      weights[leftId] = wL;
      weights[rightId] = wSum - wL;
      this.refreshSizing(true);
    });
    return el;
  }

  private resetWidths(): void {
    this.visibleViews().forEach((v) => (this.state.bottomViewWeights[v] = 1));
    this.refreshSizing(true);
  }

  private save(): void {
    storageSet(
      BOTTOM_LAYOUT_KEY,
      JSON.stringify({ views: this.state.bottomViews, weights: this.state.bottomViewWeights }),
    );
  }

  private load(): void {
    const raw = storageGet(BOTTOM_LAYOUT_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { views?: unknown; weights?: unknown };
      if (Array.isArray(parsed.views)) {
        // Filtering through the canonical order also rejects unknown saved IDs.
        this.state.bottomViews = BOTTOM_VIEW_ORDER.filter((v) => (parsed.views as unknown[]).includes(v));
      }
      if (parsed.weights && typeof parsed.weights === 'object') {
        const w = parsed.weights as Record<string, unknown>;
        for (const v of BOTTOM_VIEW_ORDER) {
          const n = Number(w[v]);
          if (Number.isFinite(n) && n > 0) this.state.bottomViewWeights[v] = n;
        }
      }
    } catch {
    }
  }
}
