'use strict';
/**
 * dtc.js - reading a control unit's fault memory, and nothing else.
 *
 * The kit's read-only link (kit/readonly-diag.js) allows service 22 only, so fault codes need the
 * plain diagnostic link (kit/diag.js), which can send anything. This file is the one place in the
 * app that holds that link, and it can send exactly one request with it:
 *
 *     19 02 0C      ReadDTCInformation, report by status mask, confirmed or pending
 *
 * to one control unit at a time. It is a read: the unit answers with its stored codes and changes
 * nothing. Clearing fault memory is a different service (14), and no function here can send it or
 * any other request: read() takes an address and nothing else, and the bytes are constants.
 *
 *   const dtc = new FaultReader(ctx.signals, log);
 *   await dtc.read(0x12)  -> { ok: true, faults: [{ code: '10AF02', status: 0x09 }] }
 *                            { ok: false, why: 'the unit refused (7F 19 11)' }   // or no answer
 */
const { Diag, parseDtcReply, hex } = require('./kit/diag');

const REQUEST = Object.freeze([0x02, 0x0C]);      /* sub-function 02, status mask: pending (04) or confirmed (08) */
const SID = 0x19;
const LINK = new WeakMap();                       /* FaultReader -> its Diag, out of reach of the rest of the app */

class FaultReader {
    constructor(signals, log) {
        const diag = new Diag(signals, log);
        diag.quiet = true;
        LINK.set(this, diag);
        this.log = log;
        this.up = null;
    }

    _init() {
        if (!this.up) this.up = Promise.resolve().then(() => LINK.get(this).init());
        return this.up;
    }

    /** One unit's stored faults. Never throws: a unit that does not answer or refuses gives ok: false. */
    async read(addr) {
        if (!Number.isInteger(addr) || addr < 0 || addr > 0xFE) return { ok: false, why: 'bad address' };
        try {
            await this._init();
            const diag = LINK.get(this);
            if (!diag.p) return { ok: false, why: 'no diagnostic link' };
            const uds = await diag.physical(addr, SID, REQUEST.slice(), 2500);
            if (!uds) return { ok: false, why: 'no answer' };
            const r = parseDtcReply(uds, REQUEST);
            if (!r.ok) return { ok: false, why: r.nrc !== null ? 'the unit refused (7F 19 ' + hex(r.nrc) + ')' : 'an answer that was not a fault list' };
            return { ok: true, faults: r.dtcs.map((d) => ({ code: d.code, status: d.status, text: '' })) };
        } catch (e) {
            return { ok: false, why: String((e && e.message) || e) };
        }
    }
}

module.exports = { FaultReader };
