'use strict';
/**
 * Woody Apps - a store for this car, on top of mgu-updater and mgu-deploy.
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

const W = 1600, H = 520;
const APP_ID = 'woodr_store', VERSION = '0.1.0';
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
        let sel = 1, scrollY = 0, armed = null, armedAt = 0;
        const t0 = Date.now();

        const client = new UpdaterClient({ hello: { id: APP_ID, version: VERSION } });
        client.on('state', (s) => { state = s; live = true; demo = false; render().catch(() => {}); });
        client.on('down', (why) => { live = false; log.info('updater: ' + why); render().catch(() => {}); });
        client.on('reply-error', (err, op) => { note = (op || 'request') + ': ' + err; noteAt = Date.now(); render().catch(() => {}); });
        client.connect();

        /* the secret, if the updater has made this app the Store (phase 2); rewritten at each updater start */
        const readSecret = () => {
            try { client.secret = fs.readFileSync(path.join(ctx.dataDir, 'updater-secret'), 'utf8').trim() || null; } catch (e) { client.secret = null; }
        };
        readSecret();
        const secretTimer = setInterval(readSecret, 30000);
        process.on('exit', () => { clearInterval(secretTimer); client.close(); });

        const current = () => {
            /* the desktop preview has no updater: show a sample after 3 s, clearly marked */
            if (!state && !live && Date.now() - t0 > 3000) { demo = true; return M.DEMO; }
            return state;
        };
        const listRows = () => { const s = current(); return s ? M.rows(M.group(s)) : []; };
        const selected = () => { const r = listRows()[sel]; return r && r.item ? r.item : null; };

        function move(d) {
            const r = listRows(); if (!r.length) return;
            let i = sel;
            for (let n = 0; n < r.length; n++) { i = (i + d + r.length) % r.length; if (r[i].item) break; }
            sel = i; armed = null;
        }

        function act(c) {
            if (!c || !c.act.can) return;
            if (demo) { note = 'Preview: nothing installed'; noteAt = Date.now(); return; }
            /* one press arms, a second within 5 s does it */
            if (armed !== c.id || Date.now() - armedAt > 5000) { armed = c.id; armedAt = Date.now(); return; }
            armed = null;
            client.install(c.id);
            note = (c.act.op === 'install' && c.installed ? 'Updating ' : 'Installing ') + (c.title || c.id); noteAt = Date.now();
        }

        function drawList(cv, t) {
            const p = { x: 24, y: 44, w: 860, h: 468 };
            G.panel(cv, t, p.x, p.y, p.w, p.h, 'Apps');
            const r = listRows();
            if (!r.length) { cv.text(live ? 'The updater lists nothing yet' : 'Connecting to the updater...', 48, 130, 24, t.dim); return; }
            if (sel >= r.length || !r[sel].item) move(1);
            const top = p.y + 52, bottom = p.y + p.h - 10, viewH = bottom - top;
            /* where each row sits, and keep the cursor in view */
            let y = 0; const ys = r.map((row) => { const at = y; y += row.header ? HEAD : ROW; return at; });
            const total = y, maxScroll = Math.max(0, total - viewH);
            if (ys[sel] < scrollY) scrollY = ys[sel] - (sel > 0 && r[sel - 1].header ? HEAD : 0);
            if (ys[sel] + ROW > scrollY + viewH) scrollY = ys[sel] + ROW - viewH;
            scrollY = Math.max(0, Math.min(scrollY, maxScroll));
            cv.clip(p.x, top, p.w, viewH);
            r.forEach((row, i) => {
                const ry = top + ys[i] - scrollY;
                if (ry > bottom || ry + ROW < top) return;
                if (row.header) {
                    const g = row.header;
                    cv.text((g.mine ? 'MY APPS  ' : '') + g.dev, 48, ry + 30, 24, g.mine ? AMBER : t.text, { font: 'bold' });
                    if (g.updates) cv.text(g.updates + (g.updates > 1 ? ' updates' : ' update'), p.x + p.w - 24, ry + 30, 20, AMBER, { align: 'right' });
                    return;
                }
                const c = row.item, on = i === sel;
                if (on) cv.roundRect(40, ry + 2, p.w - 32, ROW - 6, 10, withAlpha(t.accent, 0.18));
                cv.text(c.title || c.id, 60, ry + 26, 24, t.text, { font: on ? 'bold' : undefined });
                cv.text((c.kind === 'tool' ? 'tool · ' : '') + (c.installed ? c.installed + (c.status === 'update' ? ' > ' + c.version : '') : c.version), 60, ry + 48, 18, t.dim);
                const col = c.busy ? AMBER : c.act.op ? (c.status === 'update' ? AMBER : GREEN) : t.dim;
                const label = c.busy ? (c.busy.phase || 'busy') + (c.busy.total ? ' ' + Math.round(100 * (c.busy.progress || 0) / c.busy.total) + '%' : '') : c.act.label;
                cv.text(label, p.x + p.w - 30, ry + 36, 20, col, { font: 'bold', align: 'right' });
                if (cv.own) cv.target(40, Math.max(ry, top), p.w - 32, Math.min(ry + ROW - 6, bottom) - Math.max(ry, top), () => { sel = i; armed = null; return render(); }, 'row' + c.id, 10);
            });
            cv.noclip();
        }

        function drawDetail(cv, t) {
            const p = { x: 904, y: 44, w: 672, h: 468 };
            const s = current();
            G.panel(cv, t, p.x, p.y, p.w, p.h, demo ? 'Details  (PREVIEW - sample data)' : 'Details');
            const c = selected();
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

        function drawStatus(cv, t) {
            const s = current() || {};
            const online = s.online ? 'online' : 'offline';
            const cat = s.catalog || {};
            const bits = [live ? 'updater ' + ((s.updater && s.updater.version) || '') : demo ? 'PREVIEW' : 'updater not reachable',
                online, cat.checking ? 'checking...' : 'checked ' + ago(cat.checkedAt)];
            cv.text(bits.join('   ·   '), W - 24, 32, 18, live ? t.dim : AMBER, { align: 'right' });
            if (note && Date.now() - noteAt < 6000) cv.text(note, 300, 32, 18, AMBER);
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            drawList(cv, t);
            drawDetail(cv, t);
            G.frame(cv, t, ['Woody Apps'], 0, []);
            drawStatus(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        ctx.onScroll((dy) => { const before = sel; move(dy > 0 ? 1 : -1); render().catch(() => {}); return before !== sel; });
        ui.onClick('BTN_ACTION', () => { act(selected()); return render(); });
        ui.onClick('BTN_PAGE', () => { move(1); return render(); });
        ui.onClick('BTN_PREV', () => { move(-1); return render(); });
        ui.onClick('BTN_CHECK', () => { if (!demo) client.check(); note = 'Checking every source...'; noteAt = Date.now(); return render(); });

        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
