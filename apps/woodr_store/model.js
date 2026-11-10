'use strict';
/**
 * The updater's state shaped for Woody Apps: components grouped by developer (their source),
 * yours first, with what each one needs and what it is doing.
 */
const MINE = 'woody-apps';

/** the developer a source belongs to: its owner on GitHub, else its label */
function developerOf(src) {
    if (!src) return 'Other';
    const label = src.label || src.id || '';
    const m = /^([^/]+)\//.exec(label);
    return m ? m[1] : label || 'Other';
}

/** what the row should say and offer */
function action(c) {
    if (c.busy) return { label: 'Working...', can: false };
    if (c.compat === 'no') return { label: 'Not for this car', can: false };
    if (c.blocked) return { label: 'Blocked', can: false };
    if (c.status === 'update') return { label: 'Update', can: true, op: 'install' };
    if (!c.installed) return { label: 'Install', can: true, op: 'install' };
    return { label: 'Installed', can: false };
}

function group(state) {
    const sources = {};
    (state.sources || []).forEach((s) => { sources[s.id] = s; });
    const groups = {};
    (state.components || []).forEach((c) => {
        const src = sources[c.source];
        const dev = c.source === MINE ? 'Woody' : developerOf(src);
        const g = groups[dev] || (groups[dev] = { dev: dev, mine: c.source === MINE, items: [] });
        const busy = state.busy && state.busy.id === c.id ? state.busy : null;
        g.items.push(Object.assign({}, c, { busy: busy, act: null }));
    });
    const list = Object.keys(groups).map((k) => groups[k]);
    list.forEach((g) => {
        g.items.forEach((c) => { c.act = action(c); });
        /* updates first, then installed, then the rest; apps before tools */
        const rank = (c) => (c.status === 'update' ? 0 : c.installed ? 1 : 2) * 10 + (c.kind === 'tool' ? 1 : 0);
        g.items.sort((a, b) => rank(a) - rank(b) || String(a.title || a.id).localeCompare(String(b.title || b.id)));
        g.updates = g.items.filter((c) => c.status === 'update').length;
    });
    list.sort((a, b) => (b.mine - a.mine) || a.dev.localeCompare(b.dev));
    return list;
}

/** the flat order the cursor walks: [{ header }, { item }, ...] */
function rows(groups) {
    const out = [];
    groups.forEach((g) => { out.push({ header: g }); g.items.forEach((c) => out.push({ item: c, dev: g.dev })); });
    return out;
}

/* a believable state for the desktop preview, where there is no updater */
const DEMO = {
    type: 'state', online: true, updater: { version: '0.8.35' }, unit: { hmi: 'ID7', firmware: 'BMW MGU P18_23w44.2-1-3 mgu-high' },
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
        { id: 'woodr_ambientlab', kind: 'app', title: 'Ambient Lab', version: '0.1.0', installed: null, status: 'available', source: 'woody-apps', compat: 'yes', description: 'What does the ambient light accept?', requiredAlone: [] },
        { id: 'redline', kind: 'app', title: 'Redline', version: '1.16.8', installed: '1.16.8', status: 'installed', source: 'idrive7-apps', compat: 'yes', description: 'Rev tach with shift lights and a HUD.', requiredAlone: [] },
        { id: 'idrive7-renderd', kind: 'tool', title: 'GPU renderer', version: '2.1.7', installed: '2.1.7', status: 'installed', source: 'idrive7-apps', compat: 'yes', description: 'The apps\' own GPU renderer.', provides: 'renderer', requiredAlone: [] },
        { id: 'robertn_waze_cluster', kind: 'app', title: 'Waze on cluster', version: '0.6.4', installed: null, status: 'available', source: 'idrive-apps', compat: 'yes', description: 'CarPlay or Android Auto map on the cluster and HUD.', requiredAlone: ['waze-on-cluster'] },
    ],
};

module.exports = { group: group, rows: rows, developerOf: developerOf, action: action, DEMO: DEMO, MINE: MINE };
