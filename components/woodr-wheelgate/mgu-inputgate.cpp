// mgu-inputgate.so - lets a full-screen app (Doom) have the iDrive controller to itself.
//
// BimmerApps addition (the WHEEL GATE, marked "wheel gate" below; everything else is the kit's file unchanged):
// the steering wheel's menu button and right roller can be hidden from the HMI as well, so an app's menu on the
// head-up display can use them without the car opening its own list or picking in it. The HMI gets them as
// notifications of service 0xb505 (SteeringWheelPushButton), one byte each: 0x8005 the menu button (0 none,
// 1 pressed), 0x8007 the roller's steps (rests at 127), 0x8008 the roller's press (0 none, 1 pressed).
//   /dev/shm/woody/wheelgate.menu  fresh -> the HMI sees the menu button as never pressed
//   /dev/shm/woody/wheelgate.roll  fresh -> the HMI sees the roller at rest and not pressed
// WHO MAY CLOSE IT: /dev/shm/woody is a folder every app can write to, so a gate file counts only when its owner
// is a user id listed in /var/opt/woody/wheelgate.conf (one number per line, "#" comments), and that list counts
// only when root owns it and nobody else can write it. No list, a list that is not root's, a gate file of another
// user or one that group or others can write: the gate stays open. Root writes the list when the HUD app is
// installed (its user id), so no other app on the unit can take the buttons away from the car.
// "Fresh" is the same rule as the controller gate: a regular file touched within GATE_MS. The app that wants the
// buttons touches its file a few times a second; app closed or crashed -> the file goes stale and the HMI has
// the buttons back within GATE_MS. Apps read the wheel over their own SOME/IP connection and are not affected.
// Only a payload of exactly one byte is ever changed; anything else passes untouched.
//
// Loaded into the HMI (HmiMain3D) with LD_PRELOAD (systemd drop-in, deploy-car.sh). The HMI gets
// the controller as SOME/IP notifications of service 0xb508 (FrontCCU), event 0x8002
// (RotaryEncoderStateFront: [0] sequence, [1..2] knob position u16 BE, [3] press, [4] tilt, ...).
// While the gate is closed, this shim rewrites that event for the HMI only: the knob stands
// still, not pressed, centred. Apps read the controller over their own SOME/IP connection and
// still get the real values. The buttons (BACK, MENU, ... event 0x8001) and the touchscreen are
// never touched, so BACK always gets you out.
//
// The gate is closed only while /run/mgu-renderd/inputgate is fresh: mgu-renderd (root) touches
// it every ~200 ms while a connected app asks for the controller (M_GRAB). App closed, crashed or
// renderer gone -> the file goes stale and the HMI has the controller back within GATE_MS.
// Afterwards the knob position carries on from where the HMI last saw it (no focus jump).
// While closed, the real event goes on to mgu-renderd (abstract unix datagram socket
// "@mgu-renderd-ccu"), which hands it to the app holding the controller: the app gets exactly
// what the HMI would have got, even where its own SOME/IP copy doesn't arrive (the VM).
//
// The hook: CommonAPI-SomeIP's Connection::handleProxyReceive (every notification for the HMI's
// proxies passes there; called through the PLT, so the preloaded definition is the one used).
#include <vsomeip/vsomeip.hpp>   // compat (v2) API, as used by CommonAPI-SomeIP 3.1.12

#include <dlfcn.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <time.h>

#include <atomic>
#include <memory>
#include <mutex>

namespace {

const char *GATE_FILE = "/run/mgu-renderd/inputgate";
const long GATE_MS = 700;           // file older than this: gate open (HMI has the controller)
const uint16_t SVC_CCU = 0xb508, EVT_ROTARY = 0x8002;
// wheel gate
const char *WHEEL_MENU_FILE = "/dev/shm/woody/wheelgate.menu";
const char *WHEEL_ROLL_FILE = "/dev/shm/woody/wheelgate.roll";
const uint16_t SVC_WHEEL = 0xb505, EVT_WHEEL_MENU = 0x8005, EVT_WHEEL_STEPS = 0x8007, EVT_WHEEL_PRESS = 0x8008;
const uint8_t WHEEL_STEPS_REST = 127;
const char *WHEEL_OWNERS_FILE = "/var/opt/woody/wheelgate.conf";
const long OWNERS_MS = 5000;          // the list of allowed owners is read again at most this often
const int MAX_OWNERS = 8;

typedef void (*handle_proxy_receive_t)(void *self, const std::shared_ptr<vsomeip::message> &);
handle_proxy_receive_t g_real;

long mono_ms()
{
    timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}

// gate state, looked up at most every 50 ms
bool gate_closed()
{
    static std::atomic<long> checked{-1000};
    static std::atomic<bool> closed{false};
    long now = mono_ms();
    if (now - checked.load() < 50) return closed.load();
    checked.store(now);
    struct stat st;
    bool c = false;
    if (stat(GATE_FILE, &st) == 0) {
        timespec rt; clock_gettime(CLOCK_REALTIME, &rt);
        long age = (rt.tv_sec - st.st_mtim.tv_sec) * 1000L + (rt.tv_nsec - st.st_mtim.tv_nsec) / 1000000L;
        c = age >= 0 && age < GATE_MS;          // a clock jump backwards opens it (safe side)
    }
    closed.store(c);
    return c;
}

// wheel gate: the user ids whose gate files count. Read from a file only root can have written.
std::mutex g_owners_mu;
uid_t g_owners[MAX_OWNERS];
int g_owner_count;
long g_owners_checked = -100000;

bool owner_allowed(uid_t uid)
{
    std::lock_guard<std::mutex> lk(g_owners_mu);
    long now = mono_ms();
    if (now - g_owners_checked >= OWNERS_MS) {
        g_owners_checked = now;
        g_owner_count = 0;
        int fd = open(WHEEL_OWNERS_FILE, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        if (fd >= 0) {
            struct stat st;
            char buf[512];
            // judged by what was opened: a regular file, root's, that nobody else can write, and small
            if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == 0 && !(st.st_mode & 022) && st.st_size < off_t(sizeof buf)) {
                ssize_t n = read(fd, buf, sizeof buf - 1);
                if (n > 0) {
                    buf[n] = 0;
                    for (char *p = buf; *p && g_owner_count < MAX_OWNERS;) {
                        while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
                        if (*p >= '0' && *p <= '9') {
                            unsigned long v = 0;
                            int digits = 0;
                            while (*p >= '0' && *p <= '9' && digits < 10) { v = v * 10 + (unsigned long)(*p - '0'); p++; digits++; }
                            // a whole number on its own, and never root: root is not an app
                            if ((*p == 0 || *p == '\n' || *p == '\r' || *p == ' ' || *p == '\t' || *p == '#') && v > 0 && v < 0xffffffffUL) g_owners[g_owner_count++] = uid_t(v);
                        }
                        while (*p && *p != '\n') p++;      // the rest of the line (a comment, or something that is not a number)
                    }
                }
            }
            close(fd);
        }
    }
    for (int i = 0; i < g_owner_count; i++) if (g_owners[i] == uid) return true;
    return false;
}

// wheel gate: is `file` a regular file touched within GATE_MS? Looked up at most every 50 ms per file.
struct fresh_cache { std::atomic<long> checked{-1000}; std::atomic<bool> fresh{false}; };
bool file_fresh(const char *file, fresh_cache &c)
{
    long now = mono_ms();
    if (now - c.checked.load() < 50) return c.fresh.load();
    c.checked.store(now);
    struct stat st;
    bool f = false;
    // not a link, a pipe or a folder; writable by its owner only; and that owner is on root's list
    if (lstat(file, &st) == 0 && S_ISREG(st.st_mode) && !(st.st_mode & 022) && owner_allowed(st.st_uid)) {
        timespec rt; clock_gettime(CLOCK_REALTIME, &rt);
        long age = (rt.tv_sec - st.st_mtim.tv_sec) * 1000L + (rt.tv_nsec - st.st_mtim.tv_nsec) / 1000000L;
        f = age >= 0 && age < GATE_MS;                      // a clock jump backwards opens it (safe side)
    }
    c.fresh.store(f);
    return f;
}
fresh_cache g_wheel_menu, g_wheel_roll;

// wheel gate: the menu button and the roller as the HMI sees them while an app holds them: never pressed, at rest
void filter_wheel(const std::shared_ptr<vsomeip::message> &msg)
{
    uint16_t ev = msg->get_method();
    if (ev != EVT_WHEEL_MENU && ev != EVT_WHEEL_STEPS && ev != EVT_WHEEL_PRESS) return;
    if (!(ev == EVT_WHEEL_MENU ? file_fresh(WHEEL_MENU_FILE, g_wheel_menu) : file_fresh(WHEEL_ROLL_FILE, g_wheel_roll))) return;
    std::shared_ptr<vsomeip::payload> pl = msg->get_payload();
    if (!pl || pl->get_length() != 1) return;                // not the one-byte form this was written for: leave it
    uint8_t d[1] = { ev == EVT_WHEEL_STEPS ? WHEEL_STEPS_REST : uint8_t(0) };
    if (pl->get_data()[0] == d[0]) return;                   // already "nothing"
    pl->set_data(d, 1);
}

// the real event -> mgu-renderd (best effort, never blocks)
void forward(const uint8_t *d, uint32_t n)
{
    static int fd = -1;
    if (fd < 0) fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return;
    sockaddr_un a{};
    a.sun_family = AF_UNIX;
    static const char name[] = "\0mgu-renderd-ccu";
    memcpy(a.sun_path, name, sizeof name - 1);
    sendto(fd, d, n, MSG_DONTWAIT | MSG_NOSIGNAL, reinterpret_cast<sockaddr *>(&a),
           socklen_t(offsetof(sockaddr_un, sun_path) + sizeof name - 1));
}

// knob position as the HMI sees it: real position - offset; frozen while the gate is closed
std::mutex g_mu;
uint16_t g_offset, g_hmi_pos;
bool g_have_pos, g_was_closed;

void filter(const std::shared_ptr<vsomeip::message> &msg)
{
    if (!msg) return;
    if (msg->get_service() == SVC_WHEEL) { filter_wheel(msg); return; }      // wheel gate
    if (msg->get_service() != SVC_CCU || msg->get_method() != EVT_ROTARY) return;
    std::shared_ptr<vsomeip::payload> pl = msg->get_payload();
    if (!pl || pl->get_length() < 5) return;
    uint8_t d[64];
    uint32_t n = pl->get_length();
    if (n > sizeof d) return;
    memcpy(d, pl->get_data(), n);
    uint16_t pos = uint16_t(d[1] << 8 | d[2]);
    bool closed = gate_closed();
    std::lock_guard<std::mutex> lk(g_mu);
    if (pos == 0xffff) {                        // "invalid": pass on as it is, unless closed
        if (!closed) return;
    } else if (!closed) {
        if (g_was_closed && g_have_pos) g_offset = uint16_t(pos - g_hmi_pos);   // carry on
        g_was_closed = false;
        g_hmi_pos = uint16_t(pos - g_offset);
        g_have_pos = true;
        if (!g_offset) return;                  // nothing to change
        d[1] = uint8_t(g_hmi_pos >> 8); d[2] = uint8_t(g_hmi_pos);
        pl->set_data(d, n);
        return;
    }
    // closed: the app gets the real event; the HMI: knob still, not pressed, centred
    forward(d, n);
    g_was_closed = true;
    if (g_have_pos) { d[1] = uint8_t(g_hmi_pos >> 8); d[2] = uint8_t(g_hmi_pos); }
    d[3] = 0;                                   // not pressed
    d[4] = 0;                                   // centre
    pl->set_data(d, n);
}

}  // namespace

extern "C" void _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(
    void *self, const std::shared_ptr<vsomeip::message> &msg)
{
    if (!g_real)
        g_real = reinterpret_cast<handle_proxy_receive_t>(dlsym(RTLD_NEXT,
            "_ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE"));
    try { filter(msg); } catch (...) { /* never break the HMI */ }
    if (g_real) g_real(self, msg);
}

__attribute__((constructor)) static void init()
{
    g_real = reinterpret_cast<handle_proxy_receive_t>(dlsym(RTLD_NEXT,
        "_ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE"));
}
