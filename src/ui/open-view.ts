/**
 * The agreed copy stays whole. The review count line belongs above the title.
 * Completion never changes the view or removes controls.
 * Mike, 2026-09-24, yfbqrau4 point 9; count line from P5.
 */
import { emptyAccordHeader, type AccordHeader, type AccordView, type OpenView } from '../shared/open-view';
import type { LineMarksUI } from './line-marks';
import type { FoldingUI } from './folding';
import { FOLDED_VIEW_POLICY } from '../shared/folded-view';
import './open-view.css';

export interface OpenViewHost {
  lineMarks(): LineMarksUI;
  folding(): FoldingUI | null;
  changed(): void;
}
export class OpenViewUI {
  readonly headerEl = document.createElement('div');
  private readonly headerText = document.createElement('p');
  private readonly wholeControl = document.createElement('button');
  private unsubscribeFolds: (() => void) | null = null;
  private view: AccordView = 'open';
  private chosen = false;
  private started = false;
  private lastOpen: OpenView = { items: [], lines: [], count: 0 };
  private lastHeader: AccordHeader = emptyAccordHeader();
  private unsubscribe: (() => void) | null = null;
  readonly changes: AccordView[] = [];
  constructor(private readonly host: OpenViewHost) {
    this.headerEl.className = 'aov-header';
    this.headerText.className = 'aov-header-text';
    this.wholeControl.type = 'button';
    this.wholeControl.className = 'aov-whole-toggle';
    this.wholeControl.dataset.accordWholeToggle = '';
    this.wholeControl.onclick = () => this.host.folding()?.toggleWhole();
    this.headerEl.append(this.headerText, this.wholeControl);
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    this.unsubscribeFolds = this.host.folding()?.subscribe(() => this.sync()) ?? null;
    this.sync();
  }
  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribeFolds?.();
    document.body.classList.remove('aov-on', 'aov-in-accord');
    this.headerEl.remove();
  }
  current(): AccordView { return this.view; }
  setView(view: AccordView): void {
    if (view === 'accord' && !this.host.lineMarks().agreedCopyOffer().enabled) return;
    this.view = view;
    this.chosen = true;
    this.changes.push(view);
    this.sync();
    this.host.changed();
  }
  private compute(): { open: OpenView; header: AccordHeader } {
    const lm = this.host.lineMarks();
    const summary = lm.issueSummary();
    if (!summary || !lm.isLoaded()) {
      return { open: { items: [], lines: [], count: 0 }, header: emptyAccordHeader() };
    }
    const open = lm.reviewViews()['needs-you'];
    const header = emptyAccordHeader();
    header.text = this.host.folding()?.countText() ?? 'Loading open items…';
    header.settled = lm.reviewViews()['all-open'].lines.length === 0;
    return { open, header };
  }

  sync(): void {
    if (!this.started) return;
    const { open, header } = this.compute();
    this.lastOpen = open;
    this.lastHeader = header;
    const clean = this.chosen && this.view === 'accord';
    document.body.classList.add('aov-on');
    document.body.classList.toggle('aov-in-accord', clean);
    this.host.folding()?.setClean(clean);
    this.headerText.textContent = this.host.folding()?.countText() ?? 'Loading open items…';
    this.wholeControl.textContent = this.host.folding()?.toggleLabel() ?? 'Show the whole Accord';
    this.wholeControl.disabled = !this.host.folding()?.debugState().ready;
    this.headerText.hidden = clean || !FOLDED_VIEW_POLICY.countLine;
    this.headerEl.hidden = clean || !FOLDED_VIEW_POLICY.countLine;
    this.headerEl.dataset.view = this.view;
  }
  openItems(): OpenView { return this.lastOpen; }
  header(): AccordHeader { return this.lastHeader; }
  debugState(): Record<string, unknown> {
    const lm = this.host.lineMarks();
    return {
      view: this.view, clean: this.chosen && this.view === 'accord', chosen: this.chosen ? this.view : null,
      open: this.lastOpen,
      pill: Number(document.querySelector<HTMLElement>('.plm-issues-count')?.dataset.viewerCount ?? -1),
      dots: [...document.querySelectorAll<HTMLElement>('.plm-open-dot[data-needs-you="true"]')].map(d => Number(d.dataset.line)).sort((a,b) => a-b),
      navigator: [...document.querySelectorAll<HTMLElement>('.anv-issue[data-settled="false"]')].map(b => Number(b.dataset.line)).sort((a,b) => a-b),
      amberFromLineMarks: [...lm.needsYouLines()],
      header: { text: this.lastHeader.text, settled: this.lastHeader.settled, hidden: this.headerText.hidden },
      zero: { forViewer: this.lastOpen.count === 0, forEveryone: lm.reviewViews()['all-open'].count === 0,
        text: this.host.folding()?.countText() ?? '', view: this.view, clean: this.chosen && this.view === 'accord' },
      hiddenLines: [...(this.host.folding()?.hiddenLines() ?? [])].sort((a,b) => a-b),
    };
  }
}
