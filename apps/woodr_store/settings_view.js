'use strict';
/**
 * settings_view.js - the "Wi-Fi, sources and restart" page of Woody Apps: everything the stock Store's
 * settings do, so Woody Apps can take its place (phase 2: updater.local.conf store_app = woodr_store).
 *
 * Rows from the updater's state. Every action is one of the updater's privileged requests (they need the
 * secret it writes into the Store app's data folder); without it the rows still show, and say so.
 *   Wi-Fi     on/off, the networks seen (connect to a saved or open one, press twice), scan, forget,
 *             USB phone tethering
 *   Sources   each source (remove, press twice; the built-in one stays), the known ones not added yet
 *   Head unit the phone page (type Wi-Fi passwords and repo names on your phone), restart (press twice)
 *
 *   rows(state, ctx) -> [{ header } | { label, value, colour, act: { op, ...fields } | null, confirm, key, info }]
 */
const KNOWN_SOURCES = [
    { repo: 'WoodyCode23/woody-apps', channel: 'branch:main', note: 'your apps' },
    { repo: 'cauliflowermossgrape/idrive7-apps', channel: 'branch:main', note: 'Redline, Drag Timer, Doom, ...' },
    { repo: 'robertnisipeanu/idrive-apps', channel: 'releases', note: 'Waze on the cluster' },
    { repo: 'IterioDev/car-apps', channel: 'tags', note: 'comfort, overlays, Tailscale' },
];
const GREEN = '#2fd27a', AMBER = '#ffd34d', ORANGE = '#ff9d3b';

function bars(dbm) {
    if (typeof dbm !== 'number') return '';
    return dbm >= -55 ? 'strong' : dbm >= -67 ? 'good' : dbm >= -75 ? 'fair' : 'weak';
}

function rows(s) {
    const out = [];
    const up = s.uplink || {}, w = up.wifi || {};
    out.push({ header: 'Wi-Fi and internet' });
    out.push({ label: 'Wi-Fi', value: w.enabled ? 'ON' : 'off', colour: w.enabled ? GREEN : ORANGE,
        act: { op: 'wifi-enable', on: !w.enabled }, confirm: !!w.enabled, key: 'wifi',
        info: w.enabled ? 'Turning Wi-Fi off takes the car offline: no Store, no Home Assistant.' : 'Turn the car\'s Wi-Fi on.' });
    out.push({ label: 'Online through', value: up.state === 'online' && up.device ? (up.device.kind + ' ' + (up.device.name || '')) : (up.state || 'offline'),
        colour: up.state === 'online' ? GREEN : ORANGE, act: null, key: 'via',
        info: w.ssid ? w.ssid + '  ·  ' + (w.ip || '') + '  ·  ' + bars(w.signal) + ' (' + w.signal + ' dBm)' : 'Not connected.' });
    (w.networks || []).slice(0, 6).forEach((n) => {
        const can = !n.current && (n.saved || !n.secure);
        out.push({ label: '   ' + n.ssid, value: n.current ? 'connected' : n.saved ? 'saved · ' + bars(n.signal) : (n.secure ? 'needs password' : 'open') + ' · ' + bars(n.signal),
            colour: n.current ? GREEN : can ? '#ffffff' : '#9a9a9a',
            act: can ? { op: 'wifi-connect', ssid: n.ssid } : null, confirm: true, key: 'net' + n.ssid,
            info: n.current ? 'The network the car is on.' : can ? 'Press twice to connect.' : 'New password: turn on the phone page below and type it there.' });
    });
    out.push({ label: 'Scan for networks', value: w.scanning ? 'scanning...' : '', colour: AMBER, act: { op: 'wifi-scan' }, key: 'scan', info: 'Look for Wi-Fi networks around the car.' });
    if (w.ssid) out.push({ label: 'Forget ' + w.ssid, value: '', colour: ORANGE, act: { op: 'wifi-forget', ssid: w.ssid }, confirm: true, key: 'forget', info: 'Removes the saved password. Press twice.' });
    out.push({ label: 'Phone over USB (tethering)', value: up.usbPhone && up.usbPhone.on ? 'ON' : 'off', colour: up.usbPhone && up.usbPhone.on ? GREEN : '#9a9a9a',
        act: { op: 'usb-phone', on: !(up.usbPhone && up.usbPhone.on) }, key: 'usb', info: 'Use a phone tethered over USB as the car\'s internet when there is no Wi-Fi.' });

    out.push({ header: 'Sources' });
    const have = {};
    (s.sources || []).forEach((src) => {
        have[(src.label || '').toLowerCase()] = true;
        out.push({ label: src.label || src.id, value: (src.channel || '') + ' · ' + (src.status || '') + (src.components ? ' · ' + src.components : ''),
            colour: src.status === 'ok' ? GREEN : AMBER, act: src.builtin ? null : { op: 'source-remove', id: src.id }, confirm: true, key: 'src' + src.id,
            info: src.builtin ? 'Built in: the Store\'s own tools.' : 'Press twice to remove this source (installed apps stay installed).' });
    });
    KNOWN_SOURCES.filter((k) => !have[k.repo.toLowerCase()]).forEach((k) => {
        out.push({ label: '+ ' + k.repo, value: k.note, colour: AMBER, act: { op: 'source-add', type: 'github', repo: k.repo, channel: k.channel },
            key: 'add' + k.repo, info: 'Add this source (' + k.channel + ').' });
    });

    out.push({ header: 'Head unit' });
    const web = s.web || {};
    out.push({ label: 'Phone page', value: web.enabled ? 'ON' : 'off', colour: web.enabled ? GREEN : '#9a9a9a', act: { op: 'web', enable: !web.enabled }, key: 'web',
        info: 'A page on your phone (connected to the car\'s Wi-Fi hotspot) to type Wi-Fi passwords and add any source.', web: true });
    out.push({ label: 'Restart head unit', value: s.rebooting ? 'restarting...' : '', colour: ORANGE, act: { op: 'reboot' }, confirm: true, key: 'reboot',
        info: 'Restarts the centre screen, HUD and apps (about 1-2 minutes). Driving functions are not affected. Press twice.' });
    return out;
}

module.exports = { rows: rows, KNOWN_SOURCES: KNOWN_SOURCES };
