'use strict';
/**
 * The updater's state shaped for Woody Apps: components grouped by developer (their source),
 * yours first, with what each one needs and what it is doing.
 */
const MINE = 'woody-apps';
const MY_OWNER = 'WoodyCode23';          /* every repo of this owner (the new one and the old fork) is "Woody" */

/** the developer a source belongs to: its owner on GitHub, else its label */
function developerOf(src) {
    if (!src) return 'Other';
    /* a USB stick the updater found under /media: its own folder, named for the stick */
    if (src.type === 'usb' || src.usb === true) return 'USB · ' + (src.label || src.id);
    const label = src.label || src.id || '';
    const m = /^([^/]+)\//.exec(label);
    return m ? m[1] : label || 'Other';
}

/** what the row should say and offer */
function action(c) {
    if (c.busy) return { label: 'Working...', can: false };
    if (c.queued || c.sent) return { label: 'Queued', can: false };
    if (c.pendingReboot) return { label: 'After restart', can: false };
    if (c.compat === 'no') return { label: 'Not for this car', can: false };
    if (c.blocked) return { label: 'Blocked', can: false };
    if (c.status === 'update') return { label: 'Update', can: true, op: 'install' };
    if (!c.installed) return { label: 'Install', can: true, op: 'install' };
    return { label: 'Installed', can: false };
}

/* ids pressed here that the updater has not reported queued or busy yet: id -> when */
const sent = {};
function markSent(id) { sent[id] = Date.now(); }

function group(state) {
    const sources = {};
    (state.sources || []).forEach((s) => { sources[s.id] = s; });
    const groups = {};
    (state.components || []).forEach((c) => {
        const src = sources[c.source];
        const mine = c.source === MINE || developerOf(src) === MY_OWNER;
        const dev = mine ? 'Woody' : developerOf(src);
        const g = groups[dev] || (groups[dev] = { dev: dev, mine: mine, items: [], sources: [] });
        if (src && g.sources.indexOf(src) < 0) g.sources.push(src);
        /* busy names the id it installs under, which is the row's installAs when two sources share an id */
        const busy = state.busy && (state.busy.id === c.id || state.busy.id === c.installAs) ? state.busy : null;
        /* a press counts as queued until the updater says so itself, or for 20 s at most */
        if (sent[c.id] && (c.queued || busy || Date.now() - sent[c.id] > 20000)) delete sent[c.id];
        g.items.push(Object.assign({}, c, { busy: busy, sent: !!sent[c.id], act: null }));
    });
    const list = Object.keys(groups).map((k) => groups[k]);
    list.forEach((g) => {
        g.items.forEach((c) => { c.act = action(c); });
        /* updates first, then installed, then the rest; apps before tools */
        const rank = (c) => (c.busy || c.queued || c.sent ? -1 : c.status === 'update' ? 0 : c.installed ? 1 : 2) * 10 + (c.kind === 'tool' ? 1 : 0);
        g.items.sort((a, b) => rank(a) - rank(b) || String(a.title || a.id).localeCompare(String(b.title || b.id)));
        g.updates = g.items.filter((c) => c.status === 'update').length;
        g.queued = g.items.filter((c) => c.busy || c.queued || c.sent).length;
        g.installed = g.items.filter((c) => c.installed).length;
    });
    /* yours first, then USB sticks, then everyone else by name */
    const usbFirst = (g) => (/^USB · /.test(g.dev) ? 1 : 0);
    list.sort((a, b) => (b.mine - a.mine) || (usbFirst(b) - usbFirst(a)) || a.dev.localeCompare(b.dev));
    return list;
}

/**
 * The rows the cursor walks. Folders: one row per developer. A folder open: a way back, then its apps.
 *   open = null        -> [{ folder: g }, ...]
 *   open = 'Woody'     -> [{ back: g }, { item, dev }, ...]
 */
function rows(groups, open) {
    const g = open ? groups.filter((x) => x.dev === open)[0] : null;
    const updatable = (items) => items.filter((c) => c.status === 'update' && c.act && c.act.can);
    if (!g) {
        const all = updatable([].concat.apply([], groups.map((x) => x.items)));
        return (all.length ? [{ updateAll: all, scope: 'everything' }] : []).concat(groups.map((x) => ({ folder: x })));
    }
    const mine = updatable(g.items);
    return [{ back: g }].concat(mine.length ? [{ updateAll: mine, scope: g.mine ? 'my apps' : g.dev }] : [])
        .concat(g.items.map((c) => ({ item: c, dev: g.dev })));
}

/* a believable state for the desktop preview, where there is no updater */
const DEMO = {
    type: 'state', online: true,
    uplink: { state: 'online', device: { kind: 'wifi', name: 'HomeNet' }, usbPhone: { on: false },
        wifi: { enabled: true, ssid: 'HomeNet', ip: '192.168.1.40', signal: -62, networks: [
            { ssid: 'HomeNet', signal: -62, secure: true, saved: true, current: true },
            { ssid: 'Phone hotspot', signal: -70, secure: true, saved: true },
            { ssid: 'Neighbour', signal: -82, secure: true, saved: false }] } },
    web: { enabled: false, urls: [] }, updater: { version: '0.8.35' }, unit: { hmi: 'ID7', firmware: 'BMW MGU P18_23w44.2-1-3 mgu-high' },
    catalog: { checkedAt: Date.now() - 120000, checking: false, error: null },
    sources: [
        { id: 'woody-apps', label: 'WoodyCode23/woody-apps', channel: 'branch:main', status: 'ok', components: 5 },
        { id: 'idrive7-apps', label: 'cauliflowermossgrape/idrive7-apps', channel: 'branch:main', status: 'ok', components: 17 },
        { id: 'idrive-apps', label: 'robertnisipeanu/idrive-apps', channel: 'releases', status: 'ok', components: 3 },
    ],
    busy: { id: 'woodr_hass', phase: 'build', progress: 3, total: 5 },
    components: [
        { id: 'woodr_warmhud', kind: 'app', title: 'Warm-Up HUD', version: '0.6.0', installed: '0.5.0', status: 'update', source: 'woody-apps', compat: 'yes', description: 'Warm-up on the head-up display: oil, then the gearbox, then the tyres, then it turns itself off.', requiredAlone: [], provides: null },
        { id: 'woodr_screenlab', kind: 'app', title: 'Screen Lab', version: '0.2.1', installed: '0.2.1', status: 'installed', source: 'woody-apps', compat: 'yes', description: 'Calibration grids for the HUD and cluster.', requiredAlone: [] },
        { id: 'woodr_hass', kind: 'app', title: 'Home Assistant', version: '0.1.0', installed: null, status: 'available', source: 'woody-apps', compat: 'yes', description: 'Home Assistant dashboard and car-to-HA push.', requiredAlone: [] },
        { id: 'woodr_ambientlab', kind: 'app', title: 'Ambient Lab', version: '0.1.0', installed: null, status: 'available', source: 'woody-apps', compat: 'yes', queued: true, description: 'What does the ambient light accept?', requiredAlone: [] },
        { id: 'redline', kind: 'app', title: 'Redline', version: '1.16.9', installed: '1.16.8', status: 'update', source: 'idrive7-apps', compat: 'yes', description: 'Rev tach with shift lights and a HUD.', requiredAlone: [] },
        { id: 'idrive7-renderd', kind: 'tool', title: 'GPU renderer', version: '2.1.7', installed: '2.1.7', status: 'installed', source: 'idrive7-apps', compat: 'yes', description: 'The apps\' own GPU renderer.', provides: 'renderer', requiredAlone: [] },
        { id: 'robertn_waze_cluster', kind: 'app', title: 'Waze on cluster', version: '0.6.4', installed: null, status: 'available', source: 'idrive-apps', compat: 'yes', description: 'CarPlay or Android Auto map on the cluster and HUD.', requiredAlone: ['waze-on-cluster'] },
    ],
};

module.exports = { markSent: markSent, group: group, rows: rows, developerOf: developerOf, action: action, DEMO: DEMO, MINE: MINE };
