// Virtual network for the browser build; see web_vnet.h. The room protocol (big-endian fields):
//
//   client -> room                                   room -> client
//   0x01 UDP     srcPort dstIp dstPort data          0x80 WELCOME  ip
//   0x02 OPEN    conn dstIp dstPort srcPort          0x81 UDP      srcIp srcPort dstPort data
//   0x03 DATA    conn data                           0x82 OPENED   conn
//   0x04 CLOSE   conn                                0x83 DATA     conn data
//   0x05 NAME    UTF-8 display name                   0x84 CLOSE    conn refused(1 byte)
//                                                    0x85 ROSTER   UTF-8 JSON
//
// TCP is only carried to the room itself (kServerIp); players only exchange UDP, as on the Wii.

#if defined(__EMSCRIPTEN__)

#include "web_vnet.h"

#include <emscripten/em_js.h>
#include <emscripten/em_asm.h>
#include <emscripten/emscripten.h>

#include <arpa/inet.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fcntl.h>
#include <string>
#include <sys/time.h>
#include <vector>

// The WebSocket lives in the JavaScript of the worker that runs the game. Incoming messages wait in
// a queue until Pump() takes them, so nothing calls into the game from an event handler.
EM_JS(void, vnet_js_open, (const char* url), {
    const state = { ws: null, inbox: [], inboxHead: 0, inboxBytes: 0, status: 0 };
    globalThis.__mkwVnet = state;
    try {
        state.ws = new WebSocket(UTF8ToString(url));
    } catch (e) {
        console.error('[vnet] cannot open the room connection: ' + e);
        state.status = 3;
        return;
    }
    state.ws.binaryType = 'arraybuffer';
    state.ws.onopen = () => { state.status = 1; };
    state.ws.onclose = (e) => {
        state.status = 3;
        console.log('[vnet] room connection closed (' + e.code + (e.reason ? ' ' + e.reason : '') + ')');
    };
    state.ws.onerror = () => { state.status = 3; };
    state.ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        if (e.data.byteLength > 70000 || state.inbox.length - state.inboxHead >= 8192 ||
            state.inboxBytes + e.data.byteLength > 16 * 1024 * 1024) {
            state.status = 3;
            state.ws.close(1009, 'Room receive queue full');
            return;
        }
        state.inboxBytes += e.data.byteLength;
        const message = new Uint8Array(e.data);
        if (globalThis.__mkwBenchmarkActive && message[0] === 0x81) state.benchUdpReceived = (state.benchUdpReceived || 0) + 1;
        state.inbox.push(message);
    };
});

EM_JS(int, vnet_js_status, (void), {
    const state = globalThis.__mkwVnet;
    return state ? state.status : 3;
});

EM_JS(void, vnet_js_send, (const uint8_t* data, int size), {
    const state = globalThis.__mkwVnet;
    if (state && state.status === 1) {
        try {
            if (state.ws.bufferedAmount + size > 16 * 1024 * 1024) {
                state.status = 3;
                state.ws.close(1013, 'Room send queue full');
                return;
            }
            state.ws.send(HEAPU8.slice(data, data + size));
            if (globalThis.__mkwBenchmarkActive && HEAPU8[data] === 1) state.benchUdpSent = (state.benchUdpSent || 0) + 1;
        } catch (e) {
            state.status = 3;
        }
    }
});

// Copies the next message into data; returns its size, -1 when there is none.
EM_JS(int, vnet_js_take, (uint8_t* data, int capacity), {
    const state = globalThis.__mkwVnet;
    if (!state || state.inboxHead >= state.inbox.length) return -1;
    const message = state.inbox[state.inboxHead];
    state.inbox[state.inboxHead++] = undefined; // release consumed payloads immediately
    state.inboxBytes -= message.length;
    const size = Math.min(message.length, capacity);
    HEAPU8.set(message.subarray(0, size), data);
    if (state.inboxHead === state.inbox.length) {
        state.inbox.length = 0;
        state.inboxHead = 0;
    } else if (state.inboxHead >= 1024 && state.inboxHead * 2 >= state.inbox.length) {
        // Amortised constant-cost removal; no repeated shifting of a burst's remaining packets.
        state.inbox = state.inbox.slice(state.inboxHead);
        state.inboxHead = 0;
    }
    return size;
});

namespace {

constexpr int kFdBase = 1000;
constexpr int kMaxSockets = 64;
constexpr size_t kMaxQueuedDatagrams = 256;

enum class TcpState { Idle, Connecting, Connected, Closed };

struct Datagram {
    uint32_t ip = 0;
    uint16_t port = 0;
    std::vector<uint8_t> data;
};

struct VSocket {
    bool used = false;
    int type = SOCK_DGRAM;
    bool nonblocking = false;
    uint16_t localPort = 0;
    uint32_t peerIp = 0;
    uint16_t peerPort = 0;
    bool hasPeer = false;
    int recvTimeoutMs = -1;
    // UDP
    std::deque<Datagram> datagrams;
    // TCP
    TcpState tcp = TcpState::Idle;
    uint32_t conn = 0;
    std::deque<uint8_t> stream;
    int pendingError = 0; // reported once by SO_ERROR, like a real connect failure
};

std::string g_url;
bool g_started = false;
uint32_t g_localIp = 0;
bool g_disconnected = false;
std::atomic<bool> g_nameDirty{true};
uint16_t g_nextPort = 49152;
uint32_t g_nextConn = 1;
VSocket g_sockets[kMaxSockets];
std::vector<std::vector<uint8_t>> g_outbox;

void Put16(std::vector<uint8_t>& out, uint16_t v) {
    out.push_back(static_cast<uint8_t>(v >> 8));
    out.push_back(static_cast<uint8_t>(v));
}
void Put32(std::vector<uint8_t>& out, uint32_t v) {
    Put16(out, static_cast<uint16_t>(v >> 16));
    Put16(out, static_cast<uint16_t>(v));
}
uint16_t Get16(const uint8_t* p) { return static_cast<uint16_t>(p[0] << 8 | p[1]); }
uint32_t Get32(const uint8_t* p) { return static_cast<uint32_t>(Get16(p)) << 16 | Get16(p + 2); }

VSocket* Lookup(int fd) {
    const int index = fd - kFdBase;
    if (index < 0 || index >= kMaxSockets || !g_sockets[index].used) {
        errno = EBADF;
        return nullptr;
    }
    return &g_sockets[index];
}

uint16_t EphemeralPort() {
    for (;;) {
        const uint16_t port = g_nextPort++;
        if (g_nextPort < 49152) g_nextPort = 49152;
        bool taken = false;
        for (const VSocket& s : g_sockets) taken |= s.used && s.localPort == port;
        if (!taken) return port;
    }
}

void Queue(std::vector<uint8_t> frame) { g_outbox.push_back(std::move(frame)); }

// "?netlog" on the page traces socket activity to the console.
bool Trace() {
    static const bool enabled = [] {
        const char* v = std::getenv("MKW_WEB_NETLOG");
        return v && *v == '1';
    }();
    return enabled;
}

std::string IpText(uint32_t ip) {
    char text[16];
    std::snprintf(text, sizeof(text), "%u.%u.%u.%u", ip >> 24, ip >> 16 & 255, ip >> 8 & 255, ip & 255);
    return text;
}

void Deliver(const uint8_t* msg, size_t size) {
    if (size < 1) return;
    switch (msg[0]) {
    case 0x80:
        if (size >= 5) {
            g_localIp = Get32(msg + 1);
            std::printf("[vnet] joined the room as %u.%u.%u.%u\n", g_localIp >> 24, g_localIp >> 16 & 255,
                        g_localIp >> 8 & 255, g_localIp & 255);
            MAIN_THREAD_EM_ASM({ if (window.mkwSetGameConnection) window.mkwSetGameConnection('connected'); });
        }
        break;
    case 0x85:
        if (size > 1 && size <= 4096) {
            MAIN_THREAD_EM_ASM({
                if (!window.mkwRoomToken && window.mkwSetRoomPlayers) {
                    window.mkwSetRoomPlayers(UTF8ToString($0, $1), $2 >>> 0);
                }
            }, msg + 1, size - 1, g_localIp);
        }
        break;
    case 0x81: {
        if (size < 9) return;
        const uint16_t dstPort = Get16(msg + 7);
        for (VSocket& s : g_sockets) {
            if (s.used && s.type == SOCK_DGRAM && s.localPort == dstPort) {
                if (s.datagrams.size() >= kMaxQueuedDatagrams) s.datagrams.pop_front();
                s.datagrams.push_back({Get32(msg + 1), Get16(msg + 5), std::vector<uint8_t>(msg + 9, msg + size)});
                break;
            }
        }
        break;
    }
    case 0x82:
    case 0x83:
    case 0x84: {
        if (size < 5) return;
        const uint32_t conn = Get32(msg + 1);
        for (VSocket& s : g_sockets) {
            if (!s.used || s.type != SOCK_STREAM || s.conn != conn) continue;
            if (Trace() && msg[0] != 0x83) std::printf("[vnet] conn %u: %s\n", conn, msg[0] == 0x82 ? "open" : "closed by the room");
            if (msg[0] == 0x82) {
                s.tcp = TcpState::Connected;
            } else if (msg[0] == 0x83) {
                s.stream.insert(s.stream.end(), msg + 5, msg + size);
            } else {
                const bool refused = size > 5 && msg[5] != 0;
                if (s.tcp == TcpState::Connecting) s.pendingError = refused ? ECONNREFUSED : ECONNRESET;
                s.tcp = TcpState::Closed;
            }
            break;
        }
        break;
    }
    default:
        break;
    }
}

void Start() {
    if (g_started) return;
    g_started = true;
    const char* room = std::getenv("MKW_WEB_ROOM");
    if (!room || !*room) return;
    g_url = room;
    char token[65]{};
    MAIN_THREAD_EM_ASM({ stringToUTF8(window.mkwRoomToken || '', $0, $1); }, token, sizeof(token));
    if (*token) g_url += (g_url.find('?') == std::string::npos ? "?token=" : "&token=") + std::string(token);
    std::printf("[vnet] connecting to the online room\n");
    MAIN_THREAD_EM_ASM({ if (window.mkwSetGameConnection) window.mkwSetGameConnection('connecting'); });
    vnet_js_open(g_url.c_str());
}

void PumpNow() {
    Start();
    if (g_url.empty()) return;
    if (vnet_js_status() == 1) {
        if (g_nameDirty.exchange(false, std::memory_order_relaxed)) {
            char name[129]{};
            MAIN_THREAD_EM_ASM({ stringToUTF8(window.mkwRoomName || '', $0, $1); }, name, sizeof(name));
            std::vector<uint8_t> message{0x05};
            message.insert(message.end(), name, name + std::strlen(name));
            vnet_js_send(message.data(), static_cast<int>(message.size()));
        }
        for (const auto& frame : g_outbox) vnet_js_send(frame.data(), static_cast<int>(frame.size()));
        g_outbox.clear();
    }
    static std::vector<uint8_t> buffer(70000);
    // Bound each pump so a single queue drain cannot monopolize the game thread. Socket calls
    // and the per-frame pump continue servicing the FIFO; this budget does not drop or reorder packets.
    // After closure, drain the existing bounded queue before marking native sockets disconnected,
    // preserving the previous delivery/EOF behaviour for their final data and control messages.
    const bool connected = vnet_js_status() == 1;
    const int packetBudget = connected ? 128 : 8192;
    const size_t byteBudget = connected ? 256 * 1024 : 16 * 1024 * 1024;
    size_t deliveredBytes = 0;
    for (int packets = 0; packets < packetBudget && deliveredBytes < byteBudget; ++packets) {
        const int size = vnet_js_take(buffer.data(), static_cast<int>(buffer.size()));
        if (size < 0) break;
        Deliver(buffer.data(), static_cast<size_t>(size));
        deliveredBytes += static_cast<size_t>(size);
    }
    if (vnet_js_status() == 3 && !g_disconnected) {
        g_disconnected = true;
        MAIN_THREAD_EM_ASM({ if (window.mkwSetGameConnection) window.mkwSetGameConnection('disconnected'); });
        g_outbox.clear();
        for (VSocket& s : g_sockets) {
            if (!s.used) continue;
            s.pendingError = ENETDOWN;
            if (s.type == SOCK_STREAM) s.tcp = TcpState::Closed;
        }
    }
}

// Waits (yielding to the browser, which delivers WebSocket messages) until done() or the timeout.
// A negative timeout waits until the room connection closes.
template <typename Done>
bool WaitFor(int timeoutMs, Done done) {
    const auto start = std::chrono::steady_clock::now();
    for (;;) {
        PumpNow();
        if (done()) return true;
        if (vnet_js_status() == 3 && g_url.size()) return done();
        const auto elapsed = std::chrono::steady_clock::now() - start;
        if (timeoutMs >= 0 && elapsed >= std::chrono::milliseconds(timeoutMs)) return false;
        emscripten_sleep(1);
    }
}

bool RoomReady() {
    Start();
    if (g_url.empty()) return false;
    if (g_localIp == 0) WaitFor(10000, [] { return g_localIp != 0; });
    return g_localIp != 0 && vnet_js_status() == 1;
}

sockaddr_in MakeAddr(uint32_t ip, uint16_t port) {
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(ip);
    addr.sin_port = htons(port);
    return addr;
}

void CopyAddr(const sockaddr_in& addr, sockaddr* out, socklen_t* len) {
    if (!out || !len) return;
    const socklen_t size = std::min<socklen_t>(*len, sizeof(addr));
    std::memcpy(out, &addr, size);
    *len = sizeof(addr);
}

bool Readable(const VSocket& s) {
    if (s.pendingError) return true;
    if (s.type == SOCK_DGRAM) return !s.datagrams.empty();
    return !s.stream.empty() || s.tcp == TcpState::Closed;
}

ssize_t SendDatagram(VSocket& s, const void* data, size_t size, uint32_t ip, uint16_t port) {
    if (!RoomReady()) {
        errno = ENETUNREACH;
        return -1;
    }
    if (s.localPort == 0) s.localPort = EphemeralPort();
    if (Trace()) std::printf("[vnet] UDP %u -> %s:%u (%zu bytes)\n", s.localPort, IpText(ip).c_str(), port, size);
    if (ip == 0xFFFFFFFF) return static_cast<ssize_t>(size); // no LAN broadcast between rooms
    if (ip == g_localIp || ip >> 24 == 127) {
        for (VSocket& other : g_sockets) {
            if (other.used && other.type == SOCK_DGRAM && other.localPort == port) {
                const auto* bytes = static_cast<const uint8_t*>(data);
                other.datagrams.push_back({g_localIp, s.localPort, std::vector<uint8_t>(bytes, bytes + size)});
                break;
            }
        }
        return static_cast<ssize_t>(size);
    }
    std::vector<uint8_t> frame{0x01};
    Put16(frame, s.localPort);
    Put32(frame, ip);
    Put16(frame, port);
    const auto* bytes = static_cast<const uint8_t*>(data);
    frame.insert(frame.end(), bytes, bytes + size);
    Queue(std::move(frame));
    PumpNow();
    return static_cast<ssize_t>(size);
}

} // namespace

namespace WebVnet {
bool Enabled() {
    Start();
    return !g_url.empty();
}

void Pump() {
    if (g_started) PumpNow();
}
} // namespace WebVnet

extern "C" {

EMSCRIPTEN_KEEPALIVE void mkw_web_room_name() {
    g_nameDirty.store(true, std::memory_order_relaxed);
}

int vnet_socket(int domain, int type, int) {
    type &= ~(SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (domain != AF_INET || (type != SOCK_STREAM && type != SOCK_DGRAM)) {
        errno = EAFNOSUPPORT;
        return -1;
    }
    for (int i = 0; i < kMaxSockets; ++i) {
        if (!g_sockets[i].used) {
            g_sockets[i] = VSocket{};
            g_sockets[i].used = true;
            g_sockets[i].type = type;
            if (Trace()) std::printf("[vnet] fd %d: new %s socket\n", kFdBase + i, type == SOCK_STREAM ? "TCP" : "UDP");
            return kFdBase + i;
        }
    }
    errno = EMFILE;
    return -1;
}

int vnet_close(int fd) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (Trace()) std::printf("[vnet] fd %d: close\n", fd);
    if (s->type == SOCK_STREAM && (s->tcp == TcpState::Connecting || s->tcp == TcpState::Connected)) {
        std::vector<uint8_t> frame{0x04};
        Put32(frame, s->conn);
        Queue(std::move(frame));
        PumpNow();
    }
    *s = VSocket{};
    return 0;
}

int vnet_fcntl(int fd, int cmd, ...) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (cmd == F_GETFL) return s->nonblocking ? O_NONBLOCK : 0;
    if (cmd == F_SETFL) {
        va_list args;
        va_start(args, cmd);
        const int flags = va_arg(args, int);
        va_end(args);
        s->nonblocking = (flags & O_NONBLOCK) != 0;
        return 0;
    }
    return 0;
}

int vnet_bind(int fd, const sockaddr* addr, socklen_t len) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (!addr || len < static_cast<socklen_t>(sizeof(sockaddr_in))) {
        errno = EINVAL;
        return -1;
    }
    const uint16_t port = ntohs(reinterpret_cast<const sockaddr_in*>(addr)->sin_port);
    if (port != 0) {
        for (const VSocket& other : g_sockets) {
            if (&other != s && other.used && other.type == s->type && other.localPort == port) {
                errno = EADDRINUSE;
                return -1;
            }
        }
    }
    s->localPort = port ? port : EphemeralPort();
    return 0;
}

int vnet_connect(int fd, const sockaddr* addr, socklen_t len) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (!addr || len < static_cast<socklen_t>(sizeof(sockaddr_in))) {
        errno = EINVAL;
        return -1;
    }
    const auto* in = reinterpret_cast<const sockaddr_in*>(addr);
    const uint32_t ip = ntohl(in->sin_addr.s_addr);
    const uint16_t port = ntohs(in->sin_port);
    if (s->type == SOCK_DGRAM) {
        s->peerIp = ip;
        s->peerPort = port;
        s->hasPeer = true;
        if (s->localPort == 0) s->localPort = EphemeralPort();
        return 0;
    }
    if (s->tcp == TcpState::Connecting) {
        errno = EALREADY;
        return -1;
    }
    if (s->tcp == TcpState::Connected) {
        errno = EISCONN;
        return -1;
    }
    if (!RoomReady()) {
        errno = ENETUNREACH;
        return -1;
    }
    if (ip != WebVnet::kServerIp) {
        errno = ECONNREFUSED;
        return -1;
    }
    if (s->localPort == 0) s->localPort = EphemeralPort();
    s->peerIp = ip;
    s->peerPort = port;
    s->hasPeer = true;
    s->conn = g_nextConn++;
    s->tcp = TcpState::Connecting;
    if (Trace()) std::printf("[vnet] fd %d: TCP connect to port %u\n", fd, port);
    std::vector<uint8_t> frame{0x02};
    Put32(frame, s->conn);
    Put32(frame, ip);
    Put16(frame, port);
    Put16(frame, s->localPort);
    Queue(std::move(frame));
    PumpNow();
    if (s->nonblocking) {
        errno = EINPROGRESS;
        return -1;
    }
    WaitFor(15000, [s] { return s->tcp != TcpState::Connecting; });
    if (s->tcp == TcpState::Connected) return 0;
    errno = s->pendingError ? s->pendingError : ETIMEDOUT;
    s->pendingError = 0;
    return -1;
}

int vnet_listen(int fd, int) {
    if (!Lookup(fd)) return -1;
    errno = EOPNOTSUPP;
    return -1;
}

int vnet_shutdown(int fd, int) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (s->type == SOCK_STREAM && s->tcp == TcpState::Connected) {
        std::vector<uint8_t> frame{0x04};
        Put32(frame, s->conn);
        Queue(std::move(frame));
        PumpNow();
        s->tcp = TcpState::Closed;
    }
    return 0;
}

ssize_t vnet_sendto(int fd, const void* data, size_t size, int flags, const sockaddr* to, socklen_t toLen) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (s->type == SOCK_DGRAM) {
        if (to && toLen >= static_cast<socklen_t>(sizeof(sockaddr_in))) {
            const auto* in = reinterpret_cast<const sockaddr_in*>(to);
            return SendDatagram(*s, data, size, ntohl(in->sin_addr.s_addr), ntohs(in->sin_port));
        }
        if (!s->hasPeer) {
            errno = EDESTADDRREQ;
            return -1;
        }
        return SendDatagram(*s, data, size, s->peerIp, s->peerPort);
    }
    (void)flags;
    if (s->tcp == TcpState::Connecting) {
        errno = EAGAIN;
        return -1;
    }
    if (s->tcp != TcpState::Connected) {
        errno = s->tcp == TcpState::Closed ? EPIPE : ENOTCONN;
        return -1;
    }
    if (Trace()) std::printf("[vnet] fd %d: TCP write %zu bytes\n", fd, size);
    const auto* bytes = static_cast<const uint8_t*>(data);
    for (size_t offset = 0; offset < size; offset += 60000) {
        std::vector<uint8_t> frame{0x03};
        Put32(frame, s->conn);
        frame.insert(frame.end(), bytes + offset, bytes + std::min(size, offset + 60000));
        Queue(std::move(frame));
    }
    PumpNow();
    return static_cast<ssize_t>(size);
}

ssize_t vnet_send(int fd, const void* data, size_t size, int flags) {
    return vnet_sendto(fd, data, size, flags, nullptr, 0);
}

ssize_t vnet_recvfrom(int fd, void* data, size_t size, int flags, sockaddr* from, socklen_t* fromLen) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    PumpNow();
    if (s->pendingError) {
        errno = s->pendingError;
        s->pendingError = 0;
        return -1;
    }
    if (!Readable(*s)) {
        if (s->nonblocking || (flags & MSG_DONTWAIT)) {
            errno = EAGAIN;
            return -1;
        }
        if (!WaitFor(s->recvTimeoutMs, [s] { return Readable(*s); })) {
            errno = EAGAIN;
            return -1;
        }
    }
    if (s->pendingError) {
        errno = s->pendingError;
        s->pendingError = 0;
        return -1;
    }
    const bool peek = (flags & MSG_PEEK) != 0;
    if (s->type == SOCK_DGRAM) {
        Datagram& d = s->datagrams.front();
        if (Trace() && !peek) std::printf("[vnet] fd %d: UDP from %s:%u (%zu bytes)\n", fd, IpText(d.ip).c_str(), d.port, d.data.size());
        const size_t n = std::min(size, d.data.size());
        std::memcpy(data, d.data.data(), n);
        CopyAddr(MakeAddr(d.ip, d.port), from, fromLen);
        if (!peek) s->datagrams.pop_front();
        return static_cast<ssize_t>(n);
    }
    if (s->stream.empty()) return 0; // closed by the room
    const size_t n = std::min(size, s->stream.size());
    if (Trace() && !peek) std::printf("[vnet] fd %d: TCP read %zu bytes\n", fd, n);
    std::copy_n(s->stream.begin(), n, static_cast<uint8_t*>(data));
    if (!peek) s->stream.erase(s->stream.begin(), s->stream.begin() + static_cast<std::ptrdiff_t>(n));
    CopyAddr(MakeAddr(s->peerIp, s->peerPort), from, fromLen);
    return static_cast<ssize_t>(n);
}

ssize_t vnet_recv(int fd, void* data, size_t size, int flags) {
    return vnet_recvfrom(fd, data, size, flags, nullptr, nullptr);
}

int vnet_poll(pollfd* fds, nfds_t count, int timeoutMs) {
    const auto check = [&] {
        int ready = 0;
        for (nfds_t i = 0; i < count; ++i) {
            fds[i].revents = 0;
            const int index = fds[i].fd - kFdBase;
            if (index < 0 || index >= kMaxSockets || !g_sockets[index].used) {
                if (fds[i].fd >= 0) fds[i].revents = POLLNVAL;
            } else {
                const VSocket& s = g_sockets[index];
                // The HLE asks for POLLRDNORM/POLLWRNORM (the Wii's flags), not POLLIN/POLLOUT.
                constexpr short kRead = POLLIN | POLLRDNORM | POLLRDBAND;
                constexpr short kWrite = POLLOUT | POLLWRNORM | POLLWRBAND;
                if (Readable(s)) fds[i].revents |= fds[i].events & kRead;
                const bool writable = s.type == SOCK_DGRAM || s.tcp == TcpState::Connected;
                if (writable) fds[i].revents |= fds[i].events & kWrite;
                if (s.type == SOCK_STREAM && s.tcp == TcpState::Closed) fds[i].revents |= POLLHUP;
                if (s.pendingError) fds[i].revents |= POLLERR;
            }
            ready += fds[i].revents != 0;
        }
        return ready;
    };
    PumpNow();
    int ready = check();
    if (ready == 0 && timeoutMs != 0) {
        WaitFor(timeoutMs, [&] { return (ready = check()) != 0; });
    }
    return ready;
}

int vnet_getsockname(int fd, sockaddr* addr, socklen_t* len) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    RoomReady();
    CopyAddr(MakeAddr(g_localIp, s->localPort), addr, len);
    return 0;
}

int vnet_getpeername(int fd, sockaddr* addr, socklen_t* len) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (!s->hasPeer || (s->type == SOCK_STREAM && s->tcp != TcpState::Connected)) {
        errno = ENOTCONN;
        return -1;
    }
    CopyAddr(MakeAddr(s->peerIp, s->peerPort), addr, len);
    return 0;
}

int vnet_setsockopt(int fd, int level, int name, const void* value, socklen_t len) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (level == SOL_SOCKET && name == SO_RCVTIMEO && value && len >= static_cast<socklen_t>(sizeof(timeval))) {
        const auto* tv = static_cast<const timeval*>(value);
        const int ms = static_cast<int>(tv->tv_sec * 1000 + tv->tv_usec / 1000);
        s->recvTimeoutMs = ms > 0 ? ms : -1;
    }
    return 0; // everything else (buffers, broadcast, reuse, linger) has no meaning here
}

int vnet_getsockopt(int fd, int level, int name, void* value, socklen_t* len) {
    VSocket* s = Lookup(fd);
    if (!s) return -1;
    if (!value || !len || *len < static_cast<socklen_t>(sizeof(int))) {
        errno = EINVAL;
        return -1;
    }
    int result = 0;
    if (level == SOL_SOCKET && name == SO_ERROR) {
        PumpNow();
        result = s->pendingError;
        s->pendingError = 0;
    } else if (level == SOL_SOCKET && name == SO_TYPE) {
        result = s->type;
    }
    std::memcpy(value, &result, sizeof(result));
    *len = sizeof(result);
    return 0;
}

// Every name resolves to the room's service address; numeric addresses stay as they are. Pure
// computation, so the resolver threads may call it.
int vnet_getaddrinfo(const char* node, const char* service, const addrinfo* hints, addrinfo** result) {
    if (!result) return EAI_FAIL;
    *result = nullptr;
    if (hints && hints->ai_family != AF_UNSPEC && hints->ai_family != AF_INET) return EAI_FAMILY;
    const char* room = std::getenv("MKW_WEB_ROOM"); // not Start(): the socket belongs to the game thread
    if (!room || !*room) return EAI_NONAME;          // offline: nothing to reach
    if (Trace()) std::printf("[vnet] resolve %s\n", node ? node : "(null)");
    uint32_t ip = WebVnet::kServerIp;
    in_addr numeric{};
    if (node && inet_pton(AF_INET, node, &numeric) == 1) ip = ntohl(numeric.s_addr);
    const uint16_t port = service ? static_cast<uint16_t>(std::strtoul(service, nullptr, 10)) : 0;

    auto* info = static_cast<addrinfo*>(std::calloc(1, sizeof(addrinfo) + sizeof(sockaddr_in)));
    if (!info) return EAI_MEMORY;
    auto* addr = reinterpret_cast<sockaddr_in*>(info + 1);
    *addr = MakeAddr(ip, port);
    info->ai_family = AF_INET;
    info->ai_socktype = hints && hints->ai_socktype ? hints->ai_socktype : SOCK_STREAM;
    info->ai_protocol = hints ? hints->ai_protocol : 0;
    info->ai_addrlen = sizeof(sockaddr_in);
    info->ai_addr = reinterpret_cast<sockaddr*>(addr);
    if (hints && (hints->ai_flags & AI_CANONNAME) && node) info->ai_canonname = strdup(node);
    *result = info;
    return 0;
}

void vnet_freeaddrinfo(addrinfo* info) {
    while (info) {
        addrinfo* next = info->ai_next;
        std::free(info->ai_canonname);
        std::free(info);
        info = next;
    }
}

} // extern "C"

#endif // __EMSCRIPTEN__
