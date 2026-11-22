"""End to end: make a synthetic clip, serve a test copy of the Studio page (same files, no content policy so the
test can fetch the clip and report back), open it in headless Edge, add a piece, make the video, check the file."""
import http.server, json, os, shutil, subprocess, sys, tempfile, threading, time

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web', 'studio')
PORT = 8769
MODE = (sys.argv[1] if len(sys.argv) > 1 else 'video')      # video | music | badmusic | moment | montage
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
      var inp = $('in-files'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
      await wait(2500);
      var d = $('drives').firstElementChild; if (d) d.click();
      await wait(1500);
      /* a piece of exactly three seconds: mark the start, step on three times one second, mark the end */
      $('b-in').click();
      for (var k = 0; k < ('__MODE__' === 'moment' ? 4 : 3); k++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await wait(700); }
      $('b-out').click(); $('b-add').click();
      var MODE = '__MODE__';
      if (MODE === 'montage') {
        /* two more pieces of three seconds, further on in the clip */
        for (var q = 0; q < 2; q++) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await wait(700);
          $('b-in').click();
          for (var k2 = 0; k2 < 3; k2++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await wait(700); }
          $('b-out').click(); $('b-add').click();
        }
        $('t-kind').value = 'montage'; $('t-kind').onchange();
        $('t-title').value = 'Sunday drive'; $('t-look').value = 'punchy';
      }
      if (MODE === 'moment') {
        $('t-kind').value = 'moment'; $('t-kind').onchange();
        $('t-title').value = 'Cold start'; $('t-caption').value = 'First pull of the morning at the track'; $('t-look').value = 'punchy';
      }
      if (MODE !== 'video') {
        var mb = await (await fetch(MODE === 'montage' ? '/beat.m4a' : MODE !== 'badmusic' ? '/music.m4a' : '/bad.mp3')).blob();
        var md = new DataTransfer(); md.items.add(new File([mb], MODE !== 'badmusic' ? 'song.m4a' : 'song.mp3', { type: MODE !== 'badmusic' ? 'audio/mp4' : 'audio/mpeg' }));
        $('m-file').files = md.files;
      }
      await wait(300);
      var pieces = $('pieces').children.length;
      $('e-name').value = 'E2E test';
      $('b-video').click();
      var t0 = Date.now();
      while (!got && Date.now() - t0 < 60000) await wait(250);
      var out = { engine: !!(window.StudioEncode && StudioEncode.supported().video), info: $('e-info').textContent, pieces: pieces, note: $('note').textContent, button: $('b-video').textContent, took: Date.now() - t0 };
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
# a white mark on a black band moves four pixels every frame, so every frame of the result says which source frame it is
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x960:rate=30', '-f', 'lavfi', '-i', 'color=black:s=1280x40:r=30', '-f', 'lavfi', '-i', 'color=white:s=10x40:r=30',
                '-filter_complex', "[0][1]overlay=0:100[d];[d][2]overlay=x='n*4':y=100", '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', os.path.join(work, 'clip.mp4')], check=True)

subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-ac', '2', '-c:a', 'aac', os.path.join(work, 'music.m4a')], check=True)
# music with a beat: a low thump twice a second (120 a minute) over a quiet note
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.7*sin(2*PI*80*t)*exp(-25*mod(t,0.5))+0.04*sin(2*PI*440*t)':s=48000:d=20", '-ac', '2', '-c:a', 'aac', '-b:a', '160k', os.path.join(work, 'beat.m4a')], check=True)
open(os.path.join(work, 'bad.mp3'), 'w').write('this is not music\n' * 50)
SRC_COPY = os.path.join(tempfile.gettempdir(), 'studio-e2e-src.mp4')
shutil.copy(os.path.join(work, 'clip.mp4'), SRC_COPY)
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
    while not result.get('_done') and time.time() - t0 < 75: time.sleep(0.5)
finally:
    p.terminate()
    try: p.wait(timeout=10)
    except Exception: pass
    srv.shutdown()
result.pop('_done', None)
print(json.dumps(result, indent=1))
fails = []
secs = 4.0 if MODE == 'moment' else 7.5 if MODE == 'montage' else 3.0
out = os.path.join(work, 'out.bin')
if os.path.exists(out):
    r = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=format_name,duration', '-of', 'default=nw=1', out], capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    got = dict(l.split('=', 1) for l in r.stdout.strip().splitlines() if '=' in l)
    if got.get('codec_name') != 'h264': fails.append('not H.264')
    if MODE == 'montage':
        # its length depends on where the driver's key presses put the pieces: taken from the file, and held to what three pieces on a half-second beat can give
        secs = round(int(got.get('nb_read_frames', 0)) / 30.0, 4)
        if not 6.0 <= secs <= 9.1 or abs(secs * 2 - round(secs * 2)) > 0.08: fails.append('a montage of three pieces on a half-second beat cannot be %s s long' % secs)
    a = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,duration,sample_rate,channels', '-of', 'default=nw=1', out], capture_output=True, text=True).stdout.strip()
    print('audio:', a.replace('\n', ' ') or 'none')
    aud = dict(l.split('=', 1) for l in a.splitlines() if '=' in l)
    def level(ss, t):
        r2 = subprocess.run(['ffmpeg', '-v', 'info', '-ss', str(ss), '-t', str(t), '-i', out, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True).stderr
        m = [l for l in r2.splitlines() if 'mean_volume' in l]
        return float(m[0].split('mean_volume:')[1].split('dB')[0]) if m else None
    if MODE in ('music', 'moment', 'montage'):
        if aud.get('codec_name') != 'aac': fails.append('no AAC sound track')
        else:
            if abs(float(aud.get('duration', 0)) - secs) > 0.1: fails.append('sound is ' + aud.get('duration') + ' s long')
            start, mid, end = level(0, 0.2), level(secs / 2 - 0.2, 0.4), level(secs - 0.2, 0.2)
            print('levels dB: start', start, 'middle', mid, 'end', end)
            if start is None or mid is None or mid - start < 10: fails.append('the music does not fade in')
            if end is None or mid - end < 10: fails.append('the music does not fade out')
        if 'silent' in result.get('note', ''): fails.append('the note says silent')
    if MODE == 'badmusic':
        if aud: fails.append('a sound track from a file that is not music')
        if 'could not be read' not in result.get('note', ''): fails.append('no word about the unreadable music: ' + result.get('note', ''))
    if MODE == 'video' and aud: fails.append('a sound track nobody asked for')
    if MODE == 'montage' and 'Cut on the beat (120 a minute)' not in result.get('note', ''): fails.append('the montage was not cut on the beat: ' + result.get('note', ''))
    if MODE not in ('moment', 'montage') and result.get('engine'):
        # which source frame is each frame of the result: the mark's place in the band, read from the pixels
        def marks(path):
            raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-frames:v', '90', '-vf', 'crop=1280:20:0:110,format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
            got = []
            for i in range(len(raw) // (1280 * 20)):
                row = raw[i * 1280 * 20 + 10 * 1280: i * 1280 * 20 + 11 * 1280]
                xs = [x for x in range(1280) if row[x] > 128]
                got.append(round((xs[0] + xs[-1]) / 2) if xs else -1)
            return got
        want, seen = marks(SRC_COPY), marks(out)       # the source's own first 90 frames, and the result's
        n = len(seen)
        wrong = [(i, seen[i], want[i]) for i in range(min(n, len(want))) if abs(seen[i] - want[i]) > 1]
        print('frames checked by their picture:', n, '| wrong:', wrong[:8], '| marks move', want[1] - want[0], 'px a frame')
        if n != 90 or wrong: fails.append('frames out of place: ' + str(wrong[:8]))
    if result.get('engine') and got.get('nb_read_frames') != str(int(round(secs * 30))): fails.append('a %g second piece should be exactly %d frames, got %s' % (secs, secs * 30, got.get('nb_read_frames')))
    if result.get('engine') and abs(float(got.get('duration', 0)) - secs) > 0.05: fails.append('duration ' + str(got.get('duration')))
    if MODE in ('moment', 'montage') and (got.get('width'), got.get('height')) != ('1080', '1920'): fails.append('a Moment is 1080x1920, got %sx%s' % (got.get('width'), got.get('height')))
    keep = os.path.join(tempfile.gettempdir(), 'studio-e2e-out.' + ('mp4' if 'mp4' in result.get('type', '') else 'webm'))
    shutil.copy(out, keep); print('kept', keep)
else:
    fails.append('no video came out')
shutil.rmtree(work, ignore_errors=True)
subprocess.run(['cmd', '/c', 'rmdir', '/s', '/q', prof], capture_output=True)
print('FAILED: ' + '; '.join(fails) if fails else 'export e2e: ok')
sys.exit(1 if fails else 0)
