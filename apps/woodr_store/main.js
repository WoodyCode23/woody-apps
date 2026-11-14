'use strict';
/**
 * BimmerApps Hub - a store for this car, on top of mgu-updater and mgu-deploy.
 *
 * The updater and the deploy tool stay as they are: fetching, building on the head unit, installing,
 * snapshots, rollback and boot recovery. This app is only a front end on the updater's socket.
 *
 * Phase 1 (now): browse every source grouped by developer (yours first), see versions, what each
 * component needs and what the updater is doing, check for updates, install and update.
 * Phase 2: once the updater's local config names this app as `store_app`, the updater writes its
 * secret into this app's data folder and uninstall / rollback / logs light up by themselves.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { UpdaterClient } = require('./updater_client');
const M = require('./model');
const SV = require('./settings_view');
const qrcode = require('./qrcode');
const CAR = '__car';                  /* the "Wi-Fi, sources, restart" page, opened like a folder */
const { Progress } = require('./progress');

const W = 1600, H = 520;
const APP_ID = 'woodr_store';
/* The version said to the updater must be the installed one: after an update the updater waits for the Store to
 * say hello with the new version and goes back to the old one if it does not. So it is read from the build's
 * spec (written from app.json), never typed here. */
const VERSION = (() => { try { return String(require('./kit/app-spec.json').version); } catch (e) { return '0'; } })();
/* Said as soon as the process runs, before any screen: the first start after an update is a start without screens
 * (the app manager's set-up start), and the updater gives the new version only two minutes to say hello. */
(() => {
    try {
        const sock = require('net').connect(process.env.MGU_UPDATER_SOCK || '/dev/shm/mgu-updater/updater.sock');
        sock.on('connect', () => { sock.write(JSON.stringify({ op: 'hello', id: APP_ID, version: VERSION }) + '\n'); setTimeout(() => sock.destroy(), 2000).unref(); });
        sock.on('error', () => {});
        sock.on('data', () => {});
        sock.unref();
    } catch (e) { /* off the car */ }
})();
const ROW = 58, HEAD = 44;
const GREEN = '#2fd27a', AMBER = '#ffd34d', ORANGE = '#ff9d3b';

function wrap(cv, text, size, width, maxLines) {
    const words = String(text || '').split(/\s+/), lines = [];
    let cur = '';
    words.forEach((w) => {
        const next = cur ? cur + ' ' + w : w;
        if (cv.textWidth(next, size) <= width || !cur) cur = next; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (maxLines && lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += ' ...'; }
    return lines;
}

function ago(ms) {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let state = null, live = false, demo = false, note = '', noteAt = 0;
        let sel = 0, scrollY = 0, armed = null, armedAt = 0;
        let followSel = true;              /* keep the selected row in view (buttons) or not (finger / knob scrolling) */
        let maxScrollNow = 0;
        let open = null;                   /* the developer folder shown, or null for the folder list */
        let rebootArmedAt = 0;
        let allArmedAt = 0;                /* update all: first press arms, a second within 5 s queues them */
        const progress = new Progress();             /* restart: first press arms, a second within 5 s restarts */
        const t0 = Date.now();

        const client = new UpdaterClient({ hello: { id: APP_ID, version: VERSION } });
        let launchChecked = false;
        client.on('state', (s) => {
            state = s; live = true; demo = false;
            /* check every source once per launch, unless one is running or ran in the last 2 minutes */
            if (!launchChecked) {
                launchChecked = true;
                const cat = s.catalog || {};
                if (!cat.checking && (!cat.checkedAt || Date.now() - cat.checkedAt > 120000)) {
                    client.check(); note = 'Checking for updates...'; noteAt = Date.now();
                }
            }
            render().catch(() => {});
        });
        client.on('down', (why) => { live = false; log.info('updater: ' + why); render().catch(() => {}); });
        client.on('reply-error', (err, op) => { note = (op || 'request') + ': ' + err; noteAt = Date.now(); render().catch(() => {}); });
        client.connect();

        /* the secret, if the updater has made this app the Store (phase 2); rewritten at each updater start */
        const readSecret = () => {
            try { client.secret = fs.readFileSync(path.join(ctx.dataDir, 'updater-secret'), 'utf8').trim() || null; } catch (e) { client.secret = null; }
        };
        readSecret();
        const secretTimer = setInterval(readSecret, 30000);
        let lastPoll = 0;
        const poll = setInterval(() => {
            const s = state || {};
            const active = !!s.busy || !!(s.catalog && s.catalog.checking) || Object.keys(s).length === 0;
            if (Date.now() - lastPoll >= (active ? 3000 : 15000)) { lastPoll = Date.now(); client.status(); }
            if (active) render().catch(() => {});
        }, 1000);
        process.on('exit', () => { clearInterval(secretTimer); clearInterval(poll); client.close(); });

        const current = () => {
            /* the desktop preview has no updater: show a sample after 3 s, clearly marked */
            if (!state && !live && Date.now() - t0 > 3000) { demo = true; return M.DEMO; }
            return state;
        };
        const listRows = () => {
            const s = current();
            if (!s) return [];
            if (open === CAR) return [{ back: { dev: CAR } }].concat(SV.rows(s).map((x) => (x.header ? { header: x.header } : { setting: x })));
            return M.rows(M.group(s), open).concat(open ? [] : [{ carEntry: true }]);
        };
        let setArmed = null, setArmedAt = 0;
        function pressSetting(x) {
            if (!x.act) { note = x.info || ''; noteAt = Date.now(); return; }
            if (demo) { note = 'Preview: nothing changes'; noteAt = Date.now(); return; }
            if (!client.secret) { note = 'Needs Store powers: phase 2 makes BimmerApps Hub the Store'; noteAt = Date.now(); return; }
            if (x.confirm && (setArmed !== x.key || Date.now() - setArmedAt > 5000)) { setArmed = x.key; setArmedAt = Date.now(); note = 'Press again: ' + x.label.trim(); noteAt = Date.now(); return; }
            setArmed = null;
            client._priv(Object.assign({}, x.act));
            note = x.label.trim() + ': sent'; noteAt = Date.now();
        }
        const selectedRow = () => listRows()[sel] || null;
        const selected = () => { const r = selectedRow(); return r && r.item ? r.item : null; };

        function updateAll(row) {
            if (demo) { note = 'Preview: nothing installed'; noteAt = Date.now(); return; }
            if (Date.now() - allArmedAt > 5000) { allArmedAt = Date.now(); note = 'Press again to update ' + row.updateAll.length + ' apps'; noteAt = Date.now(); return; }
            allArmedAt = 0;
            let n = 0;
            /* the updater queues them and runs one at a time */
            row.updateAll.forEach((c) => { if (client.install(c.id)) { M.markSent(c.id); n++; } });
            note = 'Queued ' + n + ' update' + (n === 1 ? '' : 's'); noteAt = Date.now();
        }

        /* into a folder, or back out to the list of folders (the cursor lands on the folder left) */
        function enter(row) {
            if (!row) return;
            if (row.updateAll) { updateAll(row); return; }
            if (row.carEntry) { open = CAR; scrollY = 0; armed = null; sel = 1; return; }
            if (row.setting) { pressSetting(row.setting); return; }
            if (row.folder) {
                open = row.folder.dev; scrollY = 0; armed = null;
                const r = listRows(); sel = Math.max(0, r.findIndex((x) => x.item)); return;
            }
            if (row.back) {
                const left = open;
                open = null; scrollY = 0; armed = null;
                const r = listRows();
                sel = Math.max(0, r.findIndex((x) => (x.folder && x.folder.dev === left) || (left === CAR && x.carEntry)));
            }
        }

        function move(d) {
            const r = listRows(); if (!r.length) return;
            let i = sel;
            i = (i + d + r.length) % r.length;
            sel = i; armed = null; followSel = true;
        }

        function act(c) {
            if (!c || !c.act.can) return;
            if (demo) { note = 'Preview: nothing installed'; noteAt = Date.now(); return; }
            /* one press arms, a second within 5 s does it */
            if (armed !== c.id || Date.now() - armedAt > 5000) { armed = c.id; armedAt = Date.now(); return; }
            armed = null;
            if (client.install(c.id)) M.markSent(c.id);
            note = (c.act.op === 'install' && c.installed ? 'Updating ' : 'Installing ') + (c.title || c.id); noteAt = Date.now();
        }

        function drawList(cv, t) {
            const p = { x: 24, y: 44, w: 860, h: 468 };
            G.panel(cv, t, p.x, p.y, p.w, p.h, open === CAR ? 'Wi-Fi, sources and restart' : open ? (open === 'Woody' ? 'My apps' : open) : 'Developers');
            const r = listRows();
            if (!r.length) { cv.text(live ? 'The updater lists nothing yet' : 'Connecting to the updater...', 48, 130, 24, t.dim); return; }
            if (open && !r[0].back) open = null;          /* the folder went away (its source removed) */
            if (sel >= r.length) sel = r.length - 1;
            const top = p.y + 52, bottom = p.y + p.h - 10, viewH = bottom - top;
            /* where each row sits, and keep the cursor in view */
            let y = 0; const ys = r.map((row) => { const at = y; y += row.header ? HEAD : ROW; return at; });
            const total = y, maxScroll = Math.max(0, total - viewH);
            if (followSel) {
                if (ys[sel] < scrollY) scrollY = ys[sel] - (sel > 0 && r[sel - 1].header ? HEAD : 0);
                if (ys[sel] + ROW > scrollY + viewH) scrollY = ys[sel] + ROW - viewH;
            }
            scrollY = Math.max(0, Math.min(scrollY, maxScroll));
            maxScrollNow = maxScroll;
            /* a real scrolling list for the kit: finger drags and the knob scroll it (onScroll below) */
            if (maxScroll > 0) {
                const bh = Math.max(30, Math.round(viewH * viewH / total)), by = top + Math.round((viewH - bh) * scrollY / maxScroll);
                const bar = { x: p.x + p.w - 12, y: by, w: 6, h: bh };
                cv.roundRect(bar.x, top, bar.w, viewH, 3, withAlpha(t.text, 0.08));
                cv.roundRect(bar.x, bar.y, bar.w, bar.h, 3, withAlpha(t.text, 0.4));
                cv.scroll = { y: top, bar: bar };
            }
            cv.clip(p.x, top, p.w, viewH);
            r.forEach((row, i) => {
                const ry = top + ys[i] - scrollY;
                if (ry > bottom || ry + ROW < top) return;
                if (row.header) {
                    cv.text(row.header.toUpperCase(), 48, ry + 30, 18, AMBER, { font: 'bold', spacing: 1.5 });
                    return;
                }
                if (row.carEntry || row.setting) {
                    const on = i === sel, x = row.setting;
                    if (on) cv.roundRect(40, ry + 2, p.w - 32, ROW - 6, 10, withAlpha(t.accent, 0.18));
                    if (row.carEntry) {
                        cv.text('Wi-Fi, sources and restart', 60, ry + 26, 24, t.text, { font: 'bold' });
                        cv.text('everything the stock Store\'s settings do', 60, ry + 48, 18, t.dim);
                        cv.text('Open  >', p.x + p.w - 30, ry + 36, 20, t.dim, { font: 'bold', align: 'right' });
                    } else {
                        const armedNow = setArmed === x.key && Date.now() - setArmedAt < 5000;
                        cv.text(x.label, 60, ry + 36, 22, x.act ? t.text : t.dim, { font: on ? 'bold' : undefined });
                        cv.text(armedNow ? 'press again' : x.value || '', p.x + p.w - 30, ry + 36, 20, armedNow ? ORANGE : x.colour || t.dim, { font: 'bold', align: 'right' });
                    }
                    if (cv.own) cv.target(40, Math.max(ry, top), p.w - 32, Math.min(ry + ROW - 6, bottom) - Math.max(ry, top), () => { sel = i; followSel = false; enter(row); return render(); }, 's' + i + (open || ''), 10);
                    return;
                }
                if (row.updateAll) {
                    const on = i === sel, armedNow = Date.now() - allArmedAt < 5000;
                    cv.roundRect(40, ry + 2, p.w - 32, ROW - 6, 10, withAlpha(armedNow ? ORANGE : AMBER, on ? 0.38 : 0.2));
                    cv.text(armedNow ? 'Press again to update ' + row.updateAll.length : 'Update all  (' + row.updateAll.length + ')', 60, ry + 36, 24, t.text, { font: 'bold' });
                    cv.text(row.scope, p.x + p.w - 30, ry + 36, 20, t.dim, { align: 'right' });
                    if (cv.own) cv.target(40, Math.max(ry, top), p.w - 32, Math.min(ry + ROW - 6, bottom) - Math.max(ry, top), () => { sel = i; updateAll(row); return render(); }, 'ua' + (open || ''), 10);
                    return;
                }
                if (row.folder || row.back) {
                    const g = row.folder || row.back, on = i === sel;
                    if (on) cv.roundRect(40, ry + 2, p.w - 32, ROW - 6, 10, withAlpha(t.accent, 0.18));
                    if (row.back) {
                        cv.text('<  All developers', 60, ry + 36, 24, t.text, { font: on ? 'bold' : undefined });
                    } else {
                        cv.text(g.mine ? 'BimmerApps  (my apps)' : g.dev, 60, ry + 26, 24, g.mine ? AMBER : t.text, { font: 'bold' });
                        cv.text(g.items.length + (g.items.length === 1 ? ' app' : ' apps') + '  ·  ' + g.installed + ' installed', 60, ry + 48, 18, t.dim);
                        const tags = [g.queued ? g.queued + ' queued' : '', g.updates ? g.updates + (g.updates > 1 ? ' updates' : ' update') : ''].filter((x) => x);
                        cv.text(tags.length ? tags.join('  ·  ') : 'Open  >', p.x + p.w - 30, ry + 36, 20, tags.length ? AMBER : t.dim, { font: 'bold', align: 'right' });
                    }
                    if (cv.own) cv.target(40, Math.max(ry, top), p.w - 32, Math.min(ry + ROW - 6, bottom) - Math.max(ry, top), () => { sel = i; followSel = false; enter(row); return render(); }, 'f' + i + (open || ''), 10);
                    return;
                }
                const c = row.item, on = i === sel;
                if (on) cv.roundRect(40, ry + 2, p.w - 32, ROW - 6, 10, withAlpha(t.accent, 0.18));
                cv.text(c.title || c.id, 60, ry + 26, 24, t.text, { font: on ? 'bold' : undefined });
                if (!c.busy) cv.text((c.kind === 'tool' ? 'tool · ' : '') + (c.installed ? c.installed + (c.status === 'update' ? ' > ' + c.version : '') : c.version), 60, ry + 48, 18, t.dim);
                const col = c.busy || c.act.label === 'Queued' ? AMBER : c.error ? ORANGE : c.act.op ? (c.status === 'update' ? AMBER : GREEN) : t.dim;
                const pr = c.busy ? progress.of(c.busy) : null;
                const label = pr ? pr.label : c.act.label;
                cv.text(label, p.x + p.w - 30, ry + 36, 20, col, { font: 'bold', align: 'right' });
                if (pr) {
                    /* a real bar under the row */
                    cv.roundRect(60, ry + 38, p.w - 280, 8, 4, withAlpha(t.text, 0.15));
                    cv.roundRect(60, ry + 38, Math.max(8, Math.round((p.w - 280) * pr.frac)), 8, 4, AMBER);
                }
                if (cv.own) cv.target(40, Math.max(ry, top), p.w - 32, Math.min(ry + ROW - 6, bottom) - Math.max(ry, top), () => { sel = i; armed = null; followSel = false; return render(); }, 'row' + c.id, 10);
            });
            cv.noclip();
        }

        function drawDetail(cv, t) {
            const p = { x: 904, y: 44, w: 672, h: 468 };
            const s = current();
            G.panel(cv, t, p.x, p.y, p.w, p.h, demo ? 'Details  (PREVIEW - sample data)' : 'Details');
            const c = selected();
            const row = selectedRow();
            if (!c && row && (row.setting || row.carEntry)) {
                const x = row.setting;
                let sy = p.y + 92;
                cv.text(x ? x.label.trim() : 'Wi-Fi, sources and restart', p.x + 24, sy, 30, t.text, { font: 'bold' }); sy += 40;
                const info = x ? x.info : 'Wi-Fi on/off and networks, USB tethering, sources, the phone page and restart. These need Store powers: they work once BimmerApps Hub is the Store (phase 2).';
                wrap(cv, info, 20, p.w - 48, 4).forEach((l) => { cv.text(l, p.x + 24, sy, 20, t.dim); sy += 28; });
                if (!client.secret) { sy += 10; cv.text('Store powers: not yet (phase 2)', p.x + 24, sy, 20, AMBER, { font: 'bold' }); sy += 30; }
                /* the phone page's address as a QR code, from the file the updater writes for the Store */
                if (x && x.web) {
                    let url = '';
                    try { url = fs.readFileSync(path.join(ctx.dataDir, 'web-url'), 'utf8').trim(); } catch (e) { url = ''; }
                    if (url) {
                        const q = qrcode(0, 'M'); q.addData(url); q.make();
                        const n = q.getModuleCount(), cell = Math.max(3, Math.floor(200 / (n + 8))), size = (n + 8) * cell;
                        const qx = p.x + 24, qy = sy + 6;
                        cv.fillRect(qx, qy, size, size, '#ffffff');
                        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (q.isDark(a, b)) cv.fillRect(qx + (b + 4) * cell, qy + (a + 4) * cell, cell, cell, '#000000');
                        cv.text('Join the car\'s Wi-Fi hotspot, then scan', qx + size + 20, qy + 40, 20, t.text);
                    } else if ((current() || {}).web && current().web.enabled) cv.text('Waiting for the page address...', p.x + 24, sy + 30, 20, t.dim);
                }
                return;
            }
            if (!c && row && row.updateAll) {
                let uy = p.y + 92;
                cv.text('Update all', p.x + 24, uy, 32, AMBER, { font: 'bold' }); uy += 38;
                cv.text(row.updateAll.length + ' updates in ' + row.scope + ', installed one after another', p.x + 24, uy, 20, t.text); uy += 36;
                row.updateAll.slice(0, 9).forEach((u) => {
                    cv.text(u.title || u.id, p.x + 24, uy, 20, t.text);
                    cv.text((u.installed || '?') + ' > ' + u.version, p.x + p.w - 24, uy, 18, t.dim, { align: 'right' });
                    uy += 28;
                });
                if (row.updateAll.length > 9) cv.text('+ ' + (row.updateAll.length - 9) + ' more', p.x + 24, uy, 18, t.dim);
                cv.text('Press twice to queue them all', p.x + 24, p.y + p.h - 40, 20, t.dim);
                return;
            }
            if (!c && row && (row.folder || row.back)) {
                /* a folder: who it is and where its apps come from */
                const g = row.folder || row.back;
                let fy = p.y + 92;
                cv.text(g.mine ? 'BimmerApps (my apps)' : g.dev, p.x + 24, fy, 32, g.mine ? AMBER : t.text, { font: 'bold' }); fy += 40;
                cv.text(g.items.length + ' apps, ' + g.installed + ' installed' + (g.updates ? ', ' + g.updates + ' to update' : ''), p.x + 24, fy, 20, t.text); fy += 40;
                cv.text('Sources', p.x + 24, fy, 20, t.dim); fy += 30;
                g.sources.forEach((src) => {
                    cv.text(src.label || src.id, p.x + 24, fy, 20, t.text);
                    cv.text((src.channel || '') + '  ·  ' + (src.status || ''), p.x + p.w - 24, fy, 18, src.status === 'ok' ? GREEN : AMBER, { align: 'right' });
                    fy += 28;
                });
                cv.text(row.back ? 'Press to go back to all developers' : 'Press to open', p.x + 24, p.y + p.h - 40, 20, t.dim);
                return;
            }
            if (!c) {
                cv.text(live ? 'Pick an app' : 'Waiting for mgu-updater...', p.x + 24, p.y + 90, 24, t.dim);
                return;
            }
            let y = p.y + 92;
            cv.text(c.title || c.id, p.x + 24, y, 32, t.text, { font: 'bold' }); y += 30;
            cv.text(c.id + '  ·  ' + (c.source || '?'), p.x + 24, y, 18, t.dim); y += 34;
            wrap(cv, c.description, 20, p.w - 48, 3).forEach((l) => { cv.text(l, p.x + 24, y, 20, t.text); y += 26; });
            y += 8;
            const kv = (k, v, col) => { if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return; cv.text(k, p.x + 24, y, 20, t.dim); cv.text(Array.isArray(v) ? v.join(', ') : String(v), p.x + 210, y, 20, col || t.text); y += 28; };
            kv('Version', (c.installed ? 'installed ' + c.installed : 'not installed') + (c.version && c.version !== c.installed ? ', offered ' + c.version : ''));
            kv('Provides', c.provides);
            kv('Brings along', c.requiredAlone, AMBER);
            kv('Problem', c.problem || c.error || c.blocked, ORANGE);
            if (c.busy) {
                const pr = progress.of(c.busy);
                kv('Status', pr.label, AMBER);
                cv.roundRect(p.x + 24, y, p.w - 48, 10, 4, withAlpha(t.text, 0.15));
                cv.roundRect(p.x + 24, y, Math.max(10, Math.round((p.w - 48) * pr.frac)), 10, 4, AMBER);
                y += 24;
            } else if (c.queued || c.sent) kv('Status', 'queued: it starts when the job before it is done', AMBER);
            if (c.revision) kv('Built from', String(c.revision).slice(0, 10));

            /* the action, pressed twice */
            const can = c.act.can, isArmed = armed === c.id && Date.now() - armedAt < 5000;
            const label = !can ? c.act.label : isArmed ? 'Press again to ' + c.act.label.toLowerCase() : c.act.label;
            const by = p.y + p.h - 70;
            cv.roundRect(p.x + 24, by, 300, 50, 12, can ? withAlpha(isArmed ? ORANGE : GREEN, isArmed ? 0.5 : 0.3) : withAlpha(t.dim, 0.15));
            cv.text(label, p.x + 174, by + 33, 22, can ? t.text : t.dim, { font: 'bold', align: 'center' });
            if (cv.own && can) cv.target(p.x + 24, by, 300, 50, () => { act(c); return render(); }, 'act', 12);

            const priv = !!client.secret;
            cv.text(priv ? 'Store powers: ON' : 'Uninstall / rollback: phase 2', p.x + p.w - 24, by + 33, 18, priv ? GREEN : t.dim, { align: 'right' });
        }

        /* installed apps that only take effect after a restart of the head unit */
        const waitingOnRestart = () => {
            const s = current() || {};
            return (s.components || []).filter((c) => c.pendingReboot || c.nextStart || c.tileHidden);
        };

        function restart() {
            if (demo) { note = 'Preview: nothing restarts'; noteAt = Date.now(); return; }
            if (!client.secret) {
                note = 'Restart needs Store powers (phase 2): use the stock Store > Settings for now';
                noteAt = Date.now(); return;
            }
            if (Date.now() - rebootArmedAt > 5000) { rebootArmedAt = Date.now(); note = 'Press Restart again to restart the head unit'; noteAt = Date.now(); return; }
            rebootArmedAt = 0;
            client.reboot();
            note = 'Restarting the head unit...'; noteAt = Date.now();
        }

        function drawStatus(cv, t) {
            const s = current() || {};
            const wait = waitingOnRestart();
            if (wait.length || s.rebooting) {
                const names = wait.slice(0, 3).map((c) => c.title || c.id).join(', ') + (wait.length > 3 ? ' +' + (wait.length - 3) : '');
                const msg = s.rebooting ? 'Restarting...' : 'Restart to finish: ' + names;
                cv.roundRect(220, 8, 660, 30, 8, withAlpha(AMBER, 0.22));
                cv.text(msg, 236, 30, 18, AMBER, { font: 'bold' });
            }
            if (s.rebootError) cv.text('Restart failed: ' + s.rebootError, 236, 30, 18, ORANGE);
            const online = s.online ? 'online' : 'offline';
            const cat = s.catalog || {};
            const bits = [live ? 'updater ' + ((s.updater && s.updater.version) || '') : demo ? 'PREVIEW' : 'updater not reachable',
                online, cat.checking ? 'checking...' : 'checked ' + ago(cat.checkedAt)];
            cv.text(bits.join('   ·   '), W - 24, 32, 18, live ? t.dim : AMBER, { align: 'right' });
            if (note && Date.now() - noteAt < 6000 && !(waitingOnRestart().length)) cv.text(note, 236, 32, 18, AMBER);
            else if (note && Date.now() - noteAt < 6000) cv.text(note, 900, 32, 18, AMBER);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            drawList(cv, t);
            drawDetail(cv, t);
            G.frame(cv, t, ['BimmerApps Hub'], 0, []);
            drawStatus(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        ctx.onScroll((dy) => {
            const before = scrollY;
            followSel = false;
            scrollY = Math.max(0, Math.min(scrollY + dy, maxScrollNow));
            render().catch(() => {});
            return scrollY !== before;
        });
        ui.onClick('BTN_ACTION', () => { const row = selectedRow(); if (row && (row.folder || row.back || row.updateAll || row.carEntry || row.setting)) enter(row); else act(selected()); return render(); });
        ui.onClick('BTN_PAGE', () => { move(1); return render(); });
        ui.onClick('BTN_PREV', () => { move(-1); return render(); });
        ui.onClick('BTN_RESTART', () => { restart(); return render(); });
        ui.onClick('BTN_CHECK', () => { if (!demo) client.check(); note = 'Checking every source...'; noteAt = Date.now(); return render(); });

        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
