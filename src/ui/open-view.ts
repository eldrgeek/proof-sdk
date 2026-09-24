/**
 * The agreed copy is an explicit View menu action. Review always shows the full document.
 * Completion never changes the view or removes controls.
 * Mike, 2026-09-23 (usability brief).
 */
import { accordHeader, emptyAccordHeader, zeroMoment, type AccordHeader, type AccordView, type OpenView } from '../shared/open-view';
import type { LineMarksUI } from './line-marks';
import type { FoldingUI } from './folding';
import './open-view.css';

export interface OpenViewHost {
  lineMarks(): LineMarksUI;
  folding(): FoldingUI | null;
  slug(): string | null;
  go(index: number): void;
  changed(): void;
}
export class OpenViewUI {
  readonly headerEl = document.createElement('div');
  private readonly headerText = document.createElement('p');
  private view: AccordView = 'open';
  private chosen = false;
  private started = false;
  private headerSignature = '';
  private lastOpen: OpenView = { items: [], lines: [], count: 0 };
  private lastHeader: AccordHeader = emptyAccordHeader();
  private unsubscribe: (() => void) | null = null;
  readonly changes: AccordView[] = [];
  constructor(private readonly host: OpenViewHost) {
    this.headerEl.className = 'aov-header';
    this.headerText.className = 'aov-header-text';
    this.headerEl.append(this.headerText);
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    this.sync();
  }
  stop(): void {
    this.started = false;
    this.unsubscribe?.();
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
    const header = accordHeader({
      status: lm.participantStatus(),
      states: lm.lineStates(),
      team: summary.team,
      viewer: lm.me(),
      name: actor => lm.displayName(actor),
      objections: summary.issues.flatMap(issue => (issue.type === 'objection'
        ? [{ by: issue.by, reason: issue.reason, condition: issue.condition, lineIndices: issue.lineIndices }]
        : [])),
    });
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
    const offer = this.host.lineMarks().agreedCopyOffer();
    const signature = JSON.stringify([header.clauses, clean, offer.detail]);
    if (signature !== this.headerSignature) {
      this.headerSignature = signature;
      this.paintHeader(header);
      if (clean && offer.enabled) this.headerText.textContent = offer.detail;
    }
    this.headerText.hidden = clean ? !this.headerText.textContent : header.settled || !header.text;
    this.headerEl.hidden = this.headerText.hidden;
    this.headerEl.dataset.view = this.view;
  }
  private paintHeader(header: AccordHeader): void {
    this.headerText.replaceChildren();
    if (header.clauses.length === 0) {
      this.headerText.textContent = header.text;
      return;
    }
    header.clauses.forEach((clause, index) => {
      if (index > 0) this.headerText.append(' ');
      if (clause.lines.length === 0) {
        this.headerText.append(clause.text);
        return;
      }
      const link = document.createElement('a');
      link.className = 'aov-header-link';
      link.href = `#line-${clause.lines[0] + 1}`;
      link.dataset.lines = clause.lines.join(',');
      link.textContent = clause.text;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const line = clause.lines[0];
        this.host.lineMarks().revealLine(line);
        const walk = (window as unknown as { __proofReadingWalk?: { focusLine?: (index: number) => boolean } }).__proofReadingWalk;
        if (walk?.focusLine) walk.focusLine(line);
        else document.querySelector<HTMLElement>(`.plm-open-dot[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
      });
      this.headerText.append(link);
    });
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
      zero: zeroMoment(this.lastOpen, this.lastHeader, this.view, this.chosen),
      hiddenLines: [...(this.host.folding()?.hiddenLines() ?? [])].sort((a,b) => a-b),
    };
  }
}
