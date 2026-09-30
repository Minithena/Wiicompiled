#pragma once

// Virtual network for the browser build. Browsers cannot open TCP or UDP sockets, so the /dev/net
// HLE (runtime/src/hle/net) talks to this instead: every socket is carried over one WebSocket to an
// online room (tools/cloudflare/rooms). The room gives this player a private IPv4 address,
// forwards UDP between the players in it, and answers TCP and UDP sent to kServerIp with its
// stand-in for Nintendo's online service. Every host name resolves to kServerIp.
//
// The network HLE defines WEB_VNET_REDIRECT before including this, after the system headers, so the
// macros at the end send its plain BSD socket calls here. All calls except vnet_getaddrinfo/freeaddrinfo must be made on the
// thread that runs the game (the one that owns the WebSocket).

#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>

#include <cstdint>

namespace WebVnet {
constexpr uint32_t kServerIp = 0x0A4DFF01; // 10.77.255.1, host order

// Room address from the page (?room=...), or empty when this is an offline session.
bool Enabled();
// Services the WebSocket: sends queued frames and hands incoming ones to their sockets.
// Called by every socket call and once per frame (settings_overlay Draw).
void Pump();
} // namespace WebVnet

extern "C" {
int vnet_socket(int domain, int type, int protocol);
int vnet_close(int fd);
int vnet_fcntl(int fd, int cmd, ...);
int vnet_bind(int fd, const sockaddr* addr, socklen_t len);
int vnet_connect(int fd, const sockaddr* addr, socklen_t len);
int vnet_listen(int fd, int backlog);
int vnet_shutdown(int fd, int how);
ssize_t vnet_send(int fd, const void* data, size_t size, int flags);
ssize_t vnet_recv(int fd, void* data, size_t size, int flags);
ssize_t vnet_sendto(int fd, const void* data, size_t size, int flags, const sockaddr* to, socklen_t toLen);
ssize_t vnet_recvfrom(int fd, void* data, size_t size, int flags, sockaddr* from, socklen_t* fromLen);
int vnet_poll(pollfd* fds, nfds_t count, int timeoutMs);
int vnet_getsockname(int fd, sockaddr* addr, socklen_t* len);
int vnet_getpeername(int fd, sockaddr* addr, socklen_t* len);
int vnet_setsockopt(int fd, int level, int name, const void* value, socklen_t len);
int vnet_getsockopt(int fd, int level, int name, void* value, socklen_t* len);
int vnet_getaddrinfo(const char* node, const char* service, const addrinfo* hints, addrinfo** result);
void vnet_freeaddrinfo(addrinfo* info);
}

#ifdef WEB_VNET_REDIRECT
#define socket(...) vnet_socket(__VA_ARGS__)
#define close(...) vnet_close(__VA_ARGS__)
#define fcntl(...) vnet_fcntl(__VA_ARGS__)
#define bind(...) vnet_bind(__VA_ARGS__)
#define connect(...) vnet_connect(__VA_ARGS__)
#define listen(...) vnet_listen(__VA_ARGS__)
#define shutdown(...) vnet_shutdown(__VA_ARGS__)
#define send(...) vnet_send(__VA_ARGS__)
#define recv(...) vnet_recv(__VA_ARGS__)
#define sendto(...) vnet_sendto(__VA_ARGS__)
#define recvfrom(...) vnet_recvfrom(__VA_ARGS__)
#define poll(...) vnet_poll(__VA_ARGS__)
#define getsockname(...) vnet_getsockname(__VA_ARGS__)
#define getpeername(...) vnet_getpeername(__VA_ARGS__)
#define setsockopt(...) vnet_setsockopt(__VA_ARGS__)
#define getsockopt(...) vnet_getsockopt(__VA_ARGS__)
#define getaddrinfo(...) vnet_getaddrinfo(__VA_ARGS__)
#define freeaddrinfo(...) vnet_freeaddrinfo(__VA_ARGS__)
#endif
