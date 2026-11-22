// woodr-wheelgate.so - keeps the steering wheel's menu button and right roller from the car's own interface
// while an app's menu on the head-up display uses them. A library of its own (MIT, as the kit's controller gate it
// grew out of): it does not replace mgu-inputgate.so and shares no file with it, so an update of either leaves
// the other alone. Both can be loaded together, in either order: each passes every call on to the next.
//
// The HMI gets the wheel's buttons as notifications of service 0xb505 (SteeringWheelPushButton), one byte each:
// 0x8005 the menu button (0 none, 1 pressed), 0x8007 the roller's steps (rests at 127), 0x8008 the roller's press
// (0 none, 1 pressed).
//   /dev/shm/woody/wheelgate.menu  fresh -> the HMI sees the menu button as never pressed
//   /dev/shm/woody/wheelgate.roll  fresh -> the HMI sees the roller at rest and not pressed
// "Fresh" is touched within the last 0.7 s; an app that stops touching its file gives the wheel back by itself.
// WHO MAY CLOSE IT: /dev/shm/woody is a folder every app can write to, so a gate file counts only when its owner
// is a user id listed in /var/opt/woody/wheelgate.conf (one number per line, "#" comments), and that list counts
// only when root owns it and nobody else can write it. No list, a list that is not root's, a gate file of another
// user, a link or a folder in its place: the wheel stays the car's.
// Nothing else is touched: every other message, and every other button on the wheel, passes as it came.
//
// The hook: CommonAPI-SomeIP's Connection::handleProxyReceive (every notification for the HMI's proxies passes
// there; called through the PLT, so a preloaded definition is the one used). The next definition in line (the
// controller gate's when it is loaded after this one, or the real one) is found with RTLD_NEXT and always called.
#include <vsomeip/vsomeip.hpp>   // compat (v2) API, as used by CommonAPI-SomeIP 3.1.12

#include <dlfcn.h>
#include <fcntl.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <time.h>

#include <atomic>
#include <memory>
#include <mutex>

namespace {

const long GATE_MS = 700;             // a gate file older than this: the wheel is the HMI's
const char *WHEEL_MENU_FILE = "/dev/shm/woody/wheelgate.menu";
const char *WHEEL_ROLL_FILE = "/dev/shm/woody/wheelgate.roll";
const uint16_t SVC_WHEEL = 0xb505, EVT_WHEEL_MENU = 0x8005, EVT_WHEEL_STEPS = 0x8007, EVT_WHEEL_PRESS = 0x8008;
const uint8_t WHEEL_STEPS_REST = 127;
const char *WHEEL_OWNERS_FILE = "/var/opt/woody/wheelgate.conf";
const long OWNERS_MS = 5000;          // the list of allowed owners is read again at most this often
const int MAX_OWNERS = 8;
// found by tools that want to know this library is the one loaded
__attribute__((used)) const char MARK[] = "woodr-wheelgate: 1";

typedef void (*handle_proxy_receive_t)(void *self, const std::shared_ptr<vsomeip::message> &);
handle_proxy_receive_t g_real;
const char HOOK[] = "_ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE";

long mono_ms()
{
    timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
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

}  // namespace

extern "C" void _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(
    void *self, const std::shared_ptr<vsomeip::message> &msg)
{
    if (!g_real) g_real = reinterpret_cast<handle_proxy_receive_t>(dlsym(RTLD_NEXT, HOOK));
    try { if (msg && msg->get_service() == SVC_WHEEL) filter_wheel(msg); } catch (...) { /* never break the HMI */ }
    if (g_real) g_real(self, msg);
}

__attribute__((constructor)) static void init()
{
    g_real = reinterpret_cast<handle_proxy_receive_t>(dlsym(RTLD_NEXT, HOOK));
}
