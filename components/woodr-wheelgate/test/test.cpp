// Runs the gate the way the HMI would: every call goes through the preloaded mgu-inputgate.so and then to the
// stand-in in libreal.so, which records what the HMI would have been given.
//   LD_PRELOAD=./mgu-inputgate.so LD_LIBRARY_PATH=. ./gate_test
#include <vsomeip/vsomeip.hpp>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

extern "C" void _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(
    void *, const std::shared_ptr<vsomeip::message> &);
extern "C" unsigned real_calls();
extern "C" unsigned real_len();
extern "C" const unsigned char *real_data();

using namespace vsomeip;

struct fake_payload : payload {
    std::vector<byte_t> d;
    bool operator==(const payload &o) override { return o.get_length() == d.size() && !memcmp(o.get_data(), d.data(), d.size()); }
    byte_t *get_data() override { return d.data(); }
    const byte_t *get_data() const override { return d.data(); }
    void set_data(const byte_t *p, length_t n) override { d.assign(p, p + n); }
    void set_data(const std::vector<byte_t> &v) override { d = v; }
    void set_data(std::vector<byte_t> &&v) override { d = std::move(v); }
    length_t get_length() const override { return length_t(d.size()); }
    void set_capacity(length_t n) override { d.reserve(n); }
    bool serialize(serializer *) const override { return true; }
    bool deserialize(deserializer *) override { return true; }
};

struct fake_message : message {
    service_t svc = 0; method_t meth = 0; std::shared_ptr<payload> pl;
    message_t get_message() const override { return 0; }
    void set_message(message_t) override {}
    service_t get_service() const override { return svc; }
    void set_service(service_t s) override { svc = s; }
    instance_t get_instance() const override { return 1; }
    void set_instance(instance_t) override {}
    method_t get_method() const override { return meth; }
    void set_method(method_t m) override { meth = m; }
    length_t get_length() const override { return pl ? pl->get_length() : 0; }
    request_t get_request() const override { return 0; }
    client_t get_client() const override { return 0; }
    void set_client(client_t) override {}
    session_t get_session() const override { return 0; }
    void set_session(session_t) override {}
    protocol_version_t get_protocol_version() const override { return 1; }
    interface_version_t get_interface_version() const override { return 1; }
    void set_interface_version(interface_version_t) override {}
    message_type_e get_message_type() const override { return message_type_e::MT_NOTIFICATION; }
    void set_message_type(message_type_e) override {}
    return_code_e get_return_code() const override { return return_code_e::E_OK; }
    void set_return_code(return_code_e) override {}
    bool is_reliable() const override { return false; }
    void set_reliable(bool) override {}
    bool is_initial() const override { return false; }
    void set_initial(bool) override {}
    bool is_valid_crc() const override { return true; }
    void set_is_valid_crc(bool) override {}
    std::shared_ptr<payload> get_payload() const override { return pl; }
    void set_payload(std::shared_ptr<payload> p) override { pl = p; }
    bool serialize(serializer *) const override { return true; }
    bool deserialize(deserializer *) override { return true; }
};

static int failed;
static void ok(const char *name, bool cond) { if (!cond) failed++; printf("%s %s\n", cond ? "ok  " : "FAIL", name); }

// what the HMI is given for this event
static std::vector<unsigned char> hmi(unsigned svc, unsigned ev, std::vector<unsigned char> in)
{
    auto m = std::make_shared<fake_message>();
    m->svc = service_t(svc); m->meth = method_t(ev);
    auto p = std::make_shared<fake_payload>(); p->d = in; m->pl = p;
    std::shared_ptr<vsomeip::message> base = m;
    unsigned before = real_calls();
    _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(nullptr, base);
    if (real_calls() != before + 1) { failed++; printf("FAIL the HMI was not called exactly once\n"); }
    return std::vector<unsigned char>(real_data(), real_data() + real_len());
}
static bool is(const std::vector<unsigned char> &a, std::vector<unsigned char> b) { return a == b; }
// The gate files as the HUD app would leave them: its own user id (1234 here), writable by it alone.
static const unsigned APP_UID = 1234;
static void touch_as(const char *f, unsigned uid, mode_t mode)
{
    int fd = open(f, O_CREAT | O_WRONLY, 0644);
    if (fd < 0) return;
    if (fchown(fd, uid, uid) != 0 || fchmod(fd, mode) != 0) { failed++; printf("FAIL the test could not set up %s (it must run as root)\n", f); }
    futimens(fd, nullptr);
    close(fd);
}
static void touch(const char *f) { touch_as(f, APP_UID, 0644); }
// the list of user ids allowed to close the gate, as root would write it; the gate reads it again after 5 s
static void owners(const char *text, mode_t mode)
{
    const char *f = "/var/opt/woody/wheelgate.conf";
    mkdir("/var/opt", 0755); mkdir("/var/opt/woody", 0755);
    unlink(f);
    if (text) { FILE *o = fopen(f, "w"); if (o) { fputs(text, o); fclose(o); } chmod(f, mode); }
    usleep(5200 * 1000);
}
static void settle() { usleep(70 * 1000); }      // past the gate's 50 ms look-up cache

int main()
{
    const char *MENU = "/dev/shm/woody/wheelgate.menu", *ROLL = "/dev/shm/woody/wheelgate.roll";
    const unsigned W = 0xb505, CCU = 0xb508;
    mkdir("/dev/shm/woody", 01777);
    unlink(MENU); unlink(ROLL);
    settle();

    // who may close the gate
    owners(nullptr, 0);
    touch(MENU); settle();
    ok("no list of allowed owners: a fresh gate file closes nothing", is(hmi(W, 0x8005, {1}), {1}));
    owners("# the HUD app\n1234\n", 0666);
    touch(MENU); settle();
    ok("a list that others can write is not believed", is(hmi(W, 0x8005, {1}), {1}));
    owners("0\n4321 # another app\nnot-a-number\n12x\n", 0644);
    touch(MENU); settle();
    ok("an owner that is not on the list closes nothing (and root, junk lines are never accepted)", is(hmi(W, 0x8005, {1}), {1}));
    touch_as(MENU, 0, 0644); settle();
    ok("a gate file owned by root closes nothing, even with 0 written in the list", is(hmi(W, 0x8005, {1}), {1}));
    owners("# the HUD app\n  1234\n", 0644);
    unlink(MENU);
    touch_as(MENU, APP_UID, 0666); settle();
    ok("a gate file that others can write closes nothing", is(hmi(W, 0x8005, {1}), {1}));
    touch_as(MENU, 4321, 0644); settle();
    ok("a gate file owned by another app closes nothing", is(hmi(W, 0x8005, {1}), {1}));
    unlink(MENU); settle();
    // from here the list names the HUD app (1234) and the files are its own

    ok("no gate file: the menu button reaches the HMI", is(hmi(W, 0x8005, {1}), {1}));
    ok("no gate file: the roller's steps reach the HMI", is(hmi(W, 0x8007, {130}), {130}));
    ok("no gate file: the roller's press reaches the HMI", is(hmi(W, 0x8008, {1}), {1}));

    touch(MENU); settle();
    ok("menu gate: the HMI sees the menu button as not pressed", is(hmi(W, 0x8005, {1}), {0}));
    ok("menu gate: a release is passed as it is", is(hmi(W, 0x8005, {0}), {0}));
    ok("menu gate: the roller is not affected", is(hmi(W, 0x8007, {130}), {130}) && is(hmi(W, 0x8008, {1}), {1}));

    touch(ROLL); settle();
    ok("roll gate: the HMI sees the roller at rest, both directions", is(hmi(W, 0x8007, {130}), {127}) && is(hmi(W, 0x8007, {124}), {127}));
    ok("roll gate: the HMI sees the roller as not pressed", is(hmi(W, 0x8008, {1}), {0}));
    ok("gates closed: the other wheel buttons pass (phone, volume, skip, voice)", is(hmi(W, 0x8001, {1}), {1}) && is(hmi(W, 0x8002, {2}), {2})
        && is(hmi(W, 0x8003, {1}), {1}) && is(hmi(W, 0x8004, {1}), {1}) && is(hmi(W, 0x8006, {1}), {1}));
    ok("gates closed: a payload that is not one byte is left alone", is(hmi(W, 0x8005, {1, 9}), {1, 9}) && is(hmi(W, 0x8007, {}), {}));
    ok("gates closed: a getter's answer (method 5) is left alone", is(hmi(W, 0x0005, {1}), {1}));
    ok("gates closed: another service with the same event id is left alone", is(hmi(0xb506, 0x8005, {1}), {1}));
    ok("the controller gate is open: its event passes unchanged", is(hmi(CCU, 0x8002, {7, 0, 20, 1, 2, 0}), {7, 0, 20, 1, 2, 0}));

    usleep(800 * 1000);
    ok("files not touched for 0.8 s: the HMI has the menu button and the roller back",
        is(hmi(W, 0x8005, {1}), {1}) && is(hmi(W, 0x8007, {130}), {130}) && is(hmi(W, 0x8008, {1}), {1}));

    // a link to a fresh file, a folder: neither closes the gate
    unlink(MENU); unlink(ROLL);
    touch("/dev/shm/woody/other"); symlink("/dev/shm/woody/other", MENU); mkdir(ROLL, 0755); touch("/dev/shm/woody/other"); settle();
    ok("a link or a folder in the gate file's place does not close the gate", is(hmi(W, 0x8005, {1}), {1}) && is(hmi(W, 0x8008, {1}), {1}));
    unlink(MENU); rmdir(ROLL); unlink("/dev/shm/woody/other");

    // a null message must not crash anything
    std::shared_ptr<vsomeip::message> none;
    _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(nullptr, none);
    ok("an empty message is passed on without a crash", true);

    printf(failed ? "FAILED: %d\n" : "all ok\n", failed);
    return failed ? 1 : 0;
}
