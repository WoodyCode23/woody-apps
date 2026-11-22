"""End to end: make a synthetic clip, serve a test copy of the Studio page (same files, no content policy so the
test can fetch the clip and report back), open it in headless Edge, add a piece, make the video, check the file."""
import http.server, json, os, shutil, subprocess, sys, tempfile, threading, time

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web', 'studio')
PORT = 8771
MODE = sys.argv[1] if len(sys.argv) > 1 else 'overlay'      # overlay | launch
work = tempfile.mkdtemp(prefix='studio-e2e-')
for f in ('core.js', 'app.js', 'encode.js', 'social.js'):
    shutil.copy(os.path.join(WEB, f), work)
shutil.copytree(os.path.join(WEB, 'vendor'), os.path.join(work, 'vendor'))
html = open(os.path.join(WEB, 'index.html'), encoding='utf-8').read()
a = html.index('<meta http-equiv="Content-Security-Policy"'); b = html.index('>', a) + 1
html = html[:a] + html[b:]
DRIVER = r"""
<script>
(function () {
  var say = function (o) { return fetch('/result', { method: 'POST', body: JSON.stringify(o) }); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var got = null;
  var realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var self = this;
    if (this.download && /^blob:/.test(this.href)) { fetch(this.href).then(function (r) { return r.blob(); }).then(function (bl) { got = { name: self.download, size: bl.size, type: bl.type, blob: bl }; }); return; }
    return realClick.apply(this, arguments);
  };
  var $ = function (id) { return document.getElementById(id); };
  window.addEventListener('error', function (e) { say({ error: String(e.message) }); });
  (async function () {
    try {
      var r = await fetch('/clip.mp4'), bl = await r.blob();
      var dt = new DataTransfer(); dt.items.add(new File([bl], '2026-11-14 18.41.07.mp4', { type: 'video/mp4' }));
      dt.items.add(new File([await (await fetch('/meta.json')).blob()], '2026-11-14 18.41.07.json', { type: 'application/json' }));
      dt.items.add(new File([await (await fetch('/run.json')).blob()], 'run-2026-11-14-22-41-13.json', { type: 'application/json' }));
      var inp = $('in-files'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
      await wait(2500);
      var d = $('drives').firstElementChild; if (d) d.click();
      await wait(1500);
      var runInfo = $('run-info').textContent, rowHidden = $('run-row').hidden;
      $('b-in').click(); $('b-play').click();
      await wait(7000);
      $('b-play').click(); $('b-out').click(); $('b-add').click();
      await wait(300);
      var pieces = $('pieces').children.length;
      if ('__MODE__' === 'launch') { $('t-kind').value = 'launch'; $('t-kind').onchange(); $('t-title').value = 'Private strip'; $('t-look').value = 'punchy'; }
      $('e-name').value = 'E2E test';
      $('b-video').click();
      var t0 = Date.now();
      while (!got && Date.now() - t0 < 90000) await wait(250);
      var out = { runInfo: runInfo, rowHidden: rowHidden, pieces: pieces, note: $('note').textContent, button: $('b-video').textContent, took: Date.now() - t0 };
      if (got) {
        out.name = got.name; out.size = got.size; out.type = got.type;
        /* does it play back, and how long is it */
        var v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(got.blob);
        await new Promise(function (res) { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 5000); });
        out.w = v.videoWidth; out.h = v.videoHeight; out.dur = v.duration;
        if (!isFinite(v.duration)) { v.currentTime = 1e6; await wait(800); out.dur = v.currentTime; }
        await fetch('/video', { method: 'POST', body: got.blob });
      }
      await say(out);
    } catch (e) { say({ error: String(e && e.message || e) }); }
  })();
})();
</script>
"""
html = html.replace('</body>', DRIVER.replace('__MODE__', MODE) + '</body>')
open(os.path.join(work, 'index.html'), 'w', encoding='utf-8').write(html)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x960:rate=30', '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', os.path.join(work, 'clip.mp4')], check=True)

# speed data beside the clip: stopped until 6 s, then a 0.8 g launch; and the run log the Launch app would write for it
meta = [{'vin': 'TESTVIN', 'entries': [{'date': '14.11.2026', 'time': '18:41:%02d' % (7 + i // 30), 'velocity': max(0.0, 0.8 * 9.80665 * 3.6 * (i / 30 - 6.0)), 'latitude': 1.5, 'longitude': 2.5} for i in range(600)]}]
json.dump(meta, open(os.path.join(work, 'meta.json'), 'w'))
NODE = r'''
const fs = require('fs'), path = require('path'), APP = require('__RUNLOG__');
const dir = process.argv[2], rl = new APP.RunLog(path.join(dir, 'r'));
rl.arm(0);
for (let t = 0; t <= 2000 + 9000; t += 20) { const s = (t - 2000) / 1000; rl.sample(t, { kmh: s > 0 ? 0.8 * 9.80665 * 3.6 * s : 0, rpm: s > 0 ? 3200 + 1100 * (s % 3) : 3200, gear: s < 3 ? 1 : s < 6 ? 2 : 3, gLong: s > 0 ? 0.8 : 0, gLat: 0, torque: 500 }); }
const m = rl.finish({ at: '2026-11-14T22:41:13.000Z', greenMs: 1700, moveMs: 2000, rollout: false, red: false, et: { ft60: 1.9, mph30: 1.71, mph60: 3.42, ft330: 5.0, mi8: 7.6 } });
fs.copyFileSync(path.join(dir, 'r', m.file), path.join(dir, 'run.json'));
'''
open(os.path.join(work, 'mk.js'), 'w').write(NODE.replace('__RUNLOG__', os.path.join(os.path.dirname(WEB), '..', 'apps', 'woodr_launch', 'runlog.js').replace('\\', '/')))
subprocess.run(['node', os.path.join(work, 'mk.js'), work], check=True)
result = {}
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=work, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.path == '/result': result.update(json.loads(body)); result['_done'] = True
        elif self.path == '/video': open(os.path.join(work, 'out.bin'), 'wb').write(body)
        self.send_response(200); self.end_headers()
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
edge = next(p for p in (r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', r'C:\Program Files\Microsoft\Edge\Application\msedge.exe') if os.path.exists(p))
prof = tempfile.mkdtemp(prefix='edge-e2e-')
p = subprocess.Popen([edge, '--headless=new', '--no-first-run', '--user-data-dir=' + prof, '--autoplay-policy=no-user-gesture-required', '--disable-extensions',
                      'http://127.0.0.1:%d/' % PORT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    t0 = time.time()
    while not result.get('_done') and time.time() - t0 < 150: time.sleep(0.5)
finally:
    p.terminate()
    try: p.wait(timeout=10)
    except Exception: pass
    srv.shutdown()
result.pop('_done', None)
print(json.dumps(result, indent=1))
out = os.path.join(work, 'out.bin')
if os.path.exists(out):
    r = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=format_name,duration', '-of', 'default=nw=1', out], capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    if MODE == 'launch' and ('width=1080' not in r.stdout or 'height=1920' not in r.stdout or 'nb_read_frames=539' not in r.stdout): print('FAILED: a launch clip here is 1080x1920 and 539 frames')
    keep = os.path.join(tempfile.gettempdir(), 'studio-e2e-run-out.' + ('mp4' if 'mp4' in result.get('type', '') else 'webm'))
    shutil.copy(out, keep); print('kept', keep)
shutil.rmtree(work, ignore_errors=True)
subprocess.run(['cmd', '/c', 'rmdir', '/s', '/q', prof], capture_output=True)
