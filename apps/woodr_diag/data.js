'use strict';
/**
 * Diagnostics - where the numbers come from. READ-ONLY, all of it.
 *
 *   signals (subscribed, as Live and Warm-Up HUD do): engine speed, road speed, coolant, oil, gear,
 *       12 V state of charge, tyre pressures / temperatures / targets (tyres.js, polled every 10 s there)
 *   diagnostics, ONLY on demand (a button), ONLY through kit/readonly-diag.js:
 *       units()    22 F1 50 to all units: which control units answer, and their SGBD index
 *       gearbox()  22 6000 / DA12 to the gearbox unit (0x18): oil temperature, the same read as Warm-Up HUD
 *       service()  22 1001 to the instrument cluster (0x60): its service records (item ids only, see below)
 *
 * Fault codes: read by dtc.js (one fixed read request), not by the read-only link. An older note follows.
 * What was not here at first: fault codes. Reading the fault memory is UDS service 19, and the read-only link
 * refuses every service but 22 / 01 / 09. The raw link (kit/diag.js Diag) could send it, but it can also send
 * clears and writes, so this app never makes one. Until the kit's read-only link allows 19, units show
 * faults: null ("not read") on the car. docs/diagnostics-scope.md has the whole picture.
 *
 * Nothing here polls diagnostics on a timer, and nothing throws: every method resolves, with the reason in
 * .error / .why. With no car (PC preview, demo drive) the same shapes are filled with made-up DEMO values.
 */
const Car = require('./kit/car');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { FaultReader } = require('./dtc');
const { DidReader } = require('./kit/dids');
const { ECU } = require('./kit/ecus');
const { Tyres } = require('./tyres');

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const GEARBOX = 0x18, CLUSTER = 0x60;
/* the gearbox oil temperature candidates of apps/woodr_warmhud/gearbox.js (6000 answered on this car) */
const EGS = [
    { ecu: GEARBOX, did: '6000', bytes: 1, at: 0, factor: 1, offset: -40, min: -40, max: 160 },
    { ecu: GEARBOX, did: 'DA12', bytes: 1, at: 0, factor: 1, offset: -48, min: -40, max: 160 },
];
const SCAN_GAP_MS = 10000;      /* the transport turns a second scan away for a few seconds (kit/diag.js) */
const READ_GAP_MS = 5000;       /* never faster than Warm-Up HUD asks the gearbox */
const CBS_RECORD = 12;          /* bytes per service record in the 22 1001 reply (kit/tools/test_service.js) */
/* service item names by id: only the ids the kit's own test names; the rest show as "Service item N" */
const CBS_NAMES = { 1: 'Engine oil', 3: 'Brake fluid', 33: 'Exhaust emissions test', 100: 'Vehicle check' };

const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const why = (e) => String((e && e.message) || e);

/* ---------------- demo data: made up, never from a car, shown with a DEMO DATA note ---------------- */

const DEMO_FAULT = (code, status, text) => ({ code: code, status: status, text: 'Demo fault: ' + text });
const DEMO_UNITS = [
    { addr: 0x12, sgbd: 'DEMO12', faults: [DEMO_FAULT('D00121', 0x09, 'charge pressure sensor, signal implausible'), DEMO_FAULT('D00122', 0x08, 'ambient pressure, value too low')] },
    { addr: 0x63, sgbd: 'DEMO63', faults: [
        DEMO_FAULT('D00631', 0x08, 'no message from the telematics unit'), DEMO_FAULT('D00632', 0x08, 'USB port, short circuit to ground'),
        DEMO_FAULT('D00633', 0x04, 'software update interrupted'), DEMO_FAULT('D00634', 0x00, 'touch screen, calibration lost'),
        DEMO_FAULT('D00635', 0x00, 'antenna 2 not connected'), DEMO_FAULT('D00636', 0x00, 'microphone 1, line break'),
        DEMO_FAULT('D00637', 0x00, 'under-voltage seen at start-up')] },
    { addr: 0x29, sgbd: 'DEMO29', faults: [DEMO_FAULT('D00291', 0x08, 'wheel speed sensor rear left, signal lost')] },
    { addr: 0x01, sgbd: 'DEMO01', faults: [] }, { addr: 0x10, sgbd: 'DEMO10', faults: [] },
    { addr: 0x18, sgbd: 'DEMO18', faults: [] }, { addr: 0x30, sgbd: 'DEMO30', faults: [] },
    { addr: 0x40, sgbd: 'DEMO40', faults: [] }, { addr: 0x56, sgbd: 'DEMO56', faults: [] },
    { addr: 0x5D, sgbd: 'DEMO5D', faults: [] }, { addr: 0x60, sgbd: 'DEMO60', faults: [] },
    { addr: 0x76, sgbd: 'DEMO76', faults: [] }, { addr: 0x78, sgbd: 'DEMO78', faults: [] },
];
const DEMO_SERVICE = [
    { id: 1, way: '6,200 mi', date: '09/2027', due: false }, { id: 3, way: '', date: '01/2027', due: true },
    { id: 100, way: '21,000 mi', date: '03/2028', due: false }, { id: 33, way: '', date: '05/2028', due: false },
    { id: 2, way: '18,400 mi', date: '', due: false }, { id: 6, way: '24,900 mi', date: '', due: false },
];
const DEMO_TYRES = { FLH: [2.21, 2.2, 24], FRH: [2.23, 2.2, 25], RLH: [2.24, 2.5, 23], RRH: [2.48, 2.5, 23] };   /* bar, target, C */

function unitName(addr) { return ECU[addr] || 'ECU 0x' + hex2(addr); }
function serviceName(id) { return CBS_NAMES[id] || 'Service item ' + id; }

class Sources {
    constructor(ctx) {
        this.ctx = ctx; this.log = ctx.log;
        this.batt = null;                       /* 12 V state of charge in %, or null */
        this.link = null; this.rd = null; this.linkUp = null;
        this.unitScan = { state: 'idle', at: 0, error: '', list: [], demo: false };
        this.box = { state: 'idle', at: 0, why: '', value: null, demo: false };
        this.cbs = { state: 'idle', at: 0, error: '', items: [], demo: false };
        this.onChange = () => {};               /* main.js draws again when a read ends */

        this.car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear'], {
            [CDS]: {
                statusBattery2: (v) => {
                    try {
                        const p = v && v.conditionBatteryChargingCondition;
                        this.batt = (typeof p === 'number' && p >= 0 && p <= 100) ? p : null;      /* 151 = no value */
                    } catch (e) { /* never throw from a signal */ }
                },
            },
        });
        this.tyres = new Tyres(ctx);
        try { Promise.resolve(this.tyres.start()).catch((e) => this.log.warn('tyres: ' + why(e))); } catch (e) { this.log.warn('tyres: ' + why(e)); }
    }

    /** true while the kit's demo drive stands in for the car (PC preview, or no car answering) */
    demo() { try { return !!this.car.data().demo; } catch (e) { return false; } }
    carPresent() { try { return this.car.carPresent(); } catch (e) { return false; } }
    drive() { try { return this.car.data(); } catch (e) { return {}; } }

    /** Demo values must not stay on the screen once the car answers (and the other way round). */
    sync() {
        const d = this.demo();
        if (this.unitScan.state !== 'reading' && this.unitScan.state !== 'idle' && this.unitScan.demo !== d) this.unitScan = { state: 'idle', at: 0, error: '', list: [], demo: d };
        if (this.box.state !== 'reading' && this.box.state !== 'idle' && this.box.demo !== d) this.box = { state: 'idle', at: 0, why: '', value: null, demo: d };
        if (this.cbs.state !== 'reading' && this.cbs.state !== 'idle' && this.cbs.demo !== d) this.cbs = { state: 'idle', at: 0, error: '', items: [], demo: d };
    }

    battery() { return this.demo() ? 82 : this.batt; }

    /** { corners: [{ c, p, t, target }], lowest: { corner, p, target }, minT } in bar / deg C, {} when there is nothing fresh */
    tyreData() {
        try {
            if (!this.demo()) return this.tyres.snapshot() || {};
            const corners = Object.keys(DEMO_TYRES).map((c) => ({ c: c, p: DEMO_TYRES[c][0], target: DEMO_TYRES[c][1], t: DEMO_TYRES[c][2] }));
            return { corners: corners, lowest: { corner: 'RLH', p: 2.24, target: 2.5 }, minT: 23, minCorner: 'RLH' };
        } catch (e) { return {}; }
    }
    tyreUnits() { return this.demo() ? { press: 'PSI', temp: 'F' } : this.tyres.units; }

    /* ---------------- the read-only diagnostic link, made on first use ---------------- */

    _diag() {
        if (!this.linkUp) {
            this.link = new ReadOnlyDiag(this.ctx.signals, this.log);
            this.rd = new DidReader(this.link, { ecu: GEARBOX });
            this.linkUp = Promise.resolve().then(() => this.link.init()).catch((e) => this.log.warn('diag link: ' + why(e)));
        }
        return this.linkUp.then(() => {
            if (!this.link.ready) throw new Error('no diagnostic link (' + (this.link.error || 'not available') + ')');
            return this.link;
        });
    }

    /** 'not used yet' | 'ready' | 'not available' and the link's own counters, for the Live page */
    linkInfo() {
        if (this.demo()) return { text: 'DEMO', stats: null };
        if (!this.link) return { text: 'NOT USED YET', stats: null };
        return { text: this.link.ready ? 'READY' : 'NOT AVAILABLE', stats: this.link.stats, busy: this.link.busy, error: this.link.error };
    }

    /* ---------------- control units (and, in demo only, their faults) ---------------- */

    /** Which control units answer. On the car each unit's faults stay null: the read-only link reads no fault memory. */
    async readUnits() {
        const s = this.unitScan;
        if (s.state === 'reading') return false;
        if (s.at && Date.now() - s.at < SCAN_GAP_MS) return false;
        const demo = this.demo();
        s.state = 'reading'; s.error = ''; s.demo = demo;
        try {
            let list;
            if (demo) {
                await sleep(500);
                list = DEMO_UNITS.map((u) => ({ addr: u.addr, name: unitName(u.addr), sgbd: u.sgbd, faults: u.faults.slice() }));
            } else {
                const link = await this._diag();
                link.wake();                                    /* a new scan: units that slept get another try */
                const found = await link.discover();            /* Map(address -> SGBD index) */
                if (!found) throw new Error('the scan was cancelled');
                list = [];
                found.forEach((sgbd, addr) => list.push({ addr: addr, name: unitName(addr), sgbd: sgbd || '', faults: null }));
                list.sort((a, b) => a.addr - b.addr);
                this.log.info('units: ' + list.length + ' answered (' + list.map((u) => hex2(u.addr)).join(' ') + ')');
                /* each unit's fault memory, one unit at a time (dtc.js: the single read request 19 02 0C). A unit
                 * that refuses or stays silent keeps faults: null, shown as "not read". */
                if (!this.dtc) this.dtc = new FaultReader(this.ctx.signals, this.log);
                s.list = list;
                for (let i = 0; i < list.length; i++) {
                    s.progress = (i + 1) + ' / ' + list.length;
                    const r = await this.dtc.read(list[i].addr);
                    if (r.ok) list[i].faults = r.faults; else list[i].why = r.why;
                    this._changed();
                    await sleep(120);
                }
                s.progress = '';
                this.log.info('faults: ' + list.map((u) => hex2(u.addr) + ':' + (u.faults ? u.faults.length : '-')).join(' '));
            }
            s.list = list; s.state = 'done';
        } catch (e) {
            s.state = 'error'; s.error = why(e);
            this.log.warn('units: ' + s.error);
        }
        s.at = Date.now();
        this._changed();
        return true;
    }

    /** Fault total over all units, or null when any unit's faults were not read. */
    faultTotal() {
        const l = this.unitScan.list;
        if (this.unitScan.state !== 'done' || !l.length) return null;
        let n = 0;
        for (let i = 0; i < l.length; i++) { if (!l[i].faults) return null; n += l[i].faults.length; }
        return n;
    }

    /* ---------------- gearbox oil temperature ---------------- */

    async readGearbox() {
        const s = this.box;
        if (s.state === 'reading') return false;
        if (s.at && Date.now() - s.at < READ_GAP_MS) return false;
        const demo = this.demo();
        s.state = 'reading'; s.why = ''; s.demo = demo;
        try {
            let v;
            if (demo) { await sleep(300); v = 64; } else {
                const link = await this._diag();
                link.wake(GEARBOX);
                v = await this.rd.value('egs', EGS);
                if (v === null) {
                    const r = this.rd.raws;
                    s.why = EGS.map((c) => c.did + ': ' + ((r[this.rd.key(c)] || {}).why || '?')).join(', ');
                }
            }
            s.value = v; s.state = v === null ? 'error' : 'done';
        } catch (e) {
            s.value = null; s.state = 'error'; s.why = why(e);
            this.log.warn('gearbox: ' + s.why);
        }
        s.at = Date.now();
        this._changed();
        return true;
    }

    /* ---------------- service records ---------------- */

    /**
     * The instrument cluster's service records (22 1001, 12 bytes each). The kit names their first byte (the
     * item id) and nothing else, so on the car an item is { id, name, raw } with no distance or date yet.
     */
    async readService() {
        const s = this.cbs;
        if (s.state === 'reading') return false;
        if (s.at && Date.now() - s.at < READ_GAP_MS) return false;
        const demo = this.demo();
        s.state = 'reading'; s.error = ''; s.demo = demo;
        try {
            let items;
            if (demo) {
                await sleep(400);
                items = DEMO_SERVICE.map((x) => ({ id: x.id, name: serviceName(x.id), way: x.way, date: x.date, due: x.due, raw: '' }));
            } else {
                const link = await this._diag();
                link.wake(CLUSTER);
                const uds = await link.read(CLUSTER, 0x1001);
                if (!uds) throw new Error('the instrument cluster did not answer');
                if (uds[0] !== 0x62) throw new Error('the instrument cluster refused (' + uds.map(hex2).join(' ') + ')');
                items = [];
                for (let i = 3; i + CBS_RECORD <= uds.length; i += CBS_RECORD) {
                    const rec = uds.slice(i, i + CBS_RECORD);
                    if (!rec[0]) continue;                       /* an empty slot */
                    items.push({ id: rec[0], name: serviceName(rec[0]), way: null, date: null, due: null, raw: rec.map(hex2).join(' ') });
                }
                this.log.info('service: ' + items.length + ' records: ' + items.map((x) => x.raw).join(' | '));
            }
            s.items = items; s.state = 'done';
        } catch (e) {
            s.state = 'error'; s.error = why(e);
            this.log.warn('service: ' + s.error);
        }
        s.at = Date.now();
        this._changed();
        return true;
    }

    /** Everything that is read on demand, one after the other (the link sends one request at a time anyway). */
    async readAll() {
        await this.readUnits();
        await this.readGearbox();
        await this.readService();
    }

    busy() { return this.unitScan.state === 'reading' || this.box.state === 'reading' || this.cbs.state === 'reading'; }

    _changed() { try { this.onChange(); } catch (e) { this.log.warn('change: ' + why(e)); } }
}

module.exports = { Sources: Sources, unitName: unitName, hex2: hex2 };
