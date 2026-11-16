// The stand-in for CommonAPI-SomeIP's Connection::handleProxyReceive: it records what the HMI would have been given.
#include <vsomeip/vsomeip.hpp>
#include <cstring>
#include <memory>

static unsigned char g_data[64];
static unsigned g_len, g_calls;

extern "C" void _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(
    void *, const std::shared_ptr<vsomeip::message> &msg)
{
    g_calls++;
    g_len = 0;
    std::shared_ptr<vsomeip::payload> pl = msg ? msg->get_payload() : nullptr;
    if (!pl) return;
    g_len = pl->get_length() > sizeof g_data ? sizeof g_data : pl->get_length();
    memcpy(g_data, pl->get_data(), g_len);
}

extern "C" unsigned real_calls() { return g_calls; }
extern "C" unsigned real_len() { return g_len; }
extern "C" const unsigned char *real_data() { return g_data; }
