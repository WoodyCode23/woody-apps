const { Recorder } = require('../apps/woodr_dashcam/recorder.js');
const assert = require('assert');
const calls = [];
const ctx = { log: { info() {}, warn(m) { calls.push('WARN ' + m); } }, signals: {
  watch: async (i, inst, f) => { ctx['f_' + i.split('.').pop()] = f; return { proxy: i.split('.').pop() }; },
  call: async (p, m, a) => { calls.push(p + '.' + m); if (m === 'clientAttach') return { cookie: 7 }; return {}; } } };
(async () => {
  const r = new Recorder(ctx); await r.start();
  ctx.f_VideoBuffer.currentStatus(0);
  assert(!r.canWake(0), 'no rpm: never');
  ctx.f_CDS.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 65535 }); assert(!r.canWake(0), 'invalid rpm');
  ctx.f_CDS.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 0 }); assert(!r.canWake(0), 'engine off');
  ctx.f_CDS.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 3200 }); assert(r.canWake(0), 'running 800 rpm');
  assert(!r.canWake(60000), 'not idle long enough');
  assert(await r.wake());
  assert.deepStrictEqual(calls, ['ICAM2Proxy.clientAttach', 'ICAM2Proxy.changeState', 'VideoBuffer.startRecording']);
  assert(!r.canWake(0), 'paced');
  ctx.f_VideoBuffer.currentStatus(2); assert(!r.canWake(0), 'recording'); assert.strictEqual(r.wakes, 0);
  console.log('wake: all ok');
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
