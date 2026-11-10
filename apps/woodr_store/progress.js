'use strict';
/**
 * progress.js - one 0..1 progress figure for an updater job, from its phases.
 *
 * mgu-updater reports real numbers only while downloading (bytes of the package); verify, build and install
 * report a phase and nothing else, and they take most of the time. So the bar is split by phase, the
 * download part from its bytes and the rest from how long the phase has run (rising quickly, then slowing,
 * never reaching its end until the next phase starts).
 *
 *   const p = new Progress();
 *   p.of(busy)   -> { frac, phase, label } or null   (call it every time the state or the screen updates)
 */
const SPANS = {                 /* where each phase sits on the bar, and how long it usually takes on the car */
    download: { from: 0.00, to: 0.25 },
    verify:   { from: 0.25, to: 0.30, ms: 1500 },
    build:    { from: 0.30, to: 0.65, ms: 6000 },
    install:  { from: 0.65, to: 0.98, ms: 15000 },
    uninstall:{ from: 0.10, to: 0.98, ms: 8000 },
    check:    { from: 0.05, to: 0.95, ms: 10000 },
};
const NAMES = { download: 'Downloading', verify: 'Verifying', build: 'Building', install: 'Installing', uninstall: 'Removing', check: 'Checking' };

class Progress {
    constructor() { this.key = null; this.since = 0; this.top = 0; }

    of(busy) {
        if (!busy) { this.key = null; this.top = 0; return null; }
        const phase = busy.phase || 'install';
        const key = (busy.id || '') + '|' + phase;
        if (key !== this.key) { this.key = key; this.since = Date.now(); }
        if ((busy.id || '') !== (this.lastId || '')) { this.lastId = busy.id; this.top = 0; }
        const s = SPANS[phase] || SPANS.install;
        let inner;
        if (phase === 'download' && typeof busy.progress === 'number' && busy.total > 0) inner = Math.min(1, busy.progress / busy.total);
        else inner = 1 - Math.exp(-(Date.now() - this.since) / (s.ms || 5000));
        /* never go backwards (a phase repeated, a clock hiccup) */
        const frac = Math.max(this.top, s.from + (s.to - s.from) * inner);
        this.top = frac;
        return { frac: frac, phase: phase, label: (NAMES[phase] || phase) + ' ' + Math.round(frac * 100) + '%' };
    }
}

module.exports = { Progress: Progress, SPANS: SPANS };
