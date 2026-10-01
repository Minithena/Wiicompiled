#include "web_vnet.h"
#include <emscripten.h>
#include <arpa/inet.h>
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <vector>

static void Inject(int count, int payloadBytes) {
  EM_ASM({
    const state = globalThis.__mkwVnet;
    for (let i = 0; i < $0; i++) {
      const bytes = new Uint8Array(5 + $1);
      const view = new DataView(bytes.buffer);
      bytes[0] = 0x83;
      view.setUint32(1, globalThis.__vnetTestConn);
      view.setUint32(5, i);
      state.ws.onmessage({data: bytes.buffer});
    }
  }, count, payloadBytes);
}

static int Pending() {
  return EM_ASM_INT({ return __mkwVnet.inbox.length - (__mkwVnet.inboxHead || 0); });
}

static std::vector<uint8_t> Read(int fd, size_t wanted) {
  std::vector<uint8_t> result(wanted);
  size_t offset = 0;
  while (offset < wanted) {
    const ssize_t count = vnet_recv(fd, result.data() + offset, wanted - offset, MSG_DONTWAIT);
    assert(count > 0);
    offset += static_cast<size_t>(count);
  }
  return result;
}

static void CheckSequence(const std::vector<uint8_t>& bytes, int count, size_t stride) {
  for (int i = 0; i < count; i++) {
    const uint8_t* value = bytes.data() + i * stride;
    const uint32_t actual = (uint32_t(value[0]) << 24) | (uint32_t(value[1]) << 16) |
                            (uint32_t(value[2]) << 8) | value[3];
    assert(actual == static_cast<uint32_t>(i));
  }
}

int main() {
  setenv("MKW_WEB_ROOM", "wss://transport.test/room", 1);
  assert(WebVnet::Enabled());
  EM_ASM({
    __mkwVnet.ws.onopen();
    __mkwVnet.ws.onmessage({data: Uint8Array.of(0x80, 10, 77, 0, 1).buffer});
  });
  WebVnet::Pump();
  const int fd = vnet_socket(AF_INET, SOCK_STREAM, 0);
  assert(fd >= 0);
  sockaddr_in server{};
  server.sin_family = AF_INET;
  server.sin_addr.s_addr = htonl(WebVnet::kServerIp);
  server.sin_port = htons(29900);
  assert(vnet_connect(fd, reinterpret_cast<sockaddr*>(&server), sizeof(server)) == 0);

  Inject(1000, 4);
  WebVnet::Pump();
  const int packetRemainder = Pending();
  assert(packetRemainder == 872);
  CheckSequence(Read(fd, 4000), 1000, 4);
  assert(Pending() == 0);

  Inject(10, 65535);
  WebVnet::Pump();
  const int byteRemainder = Pending();
  assert(byteRemainder == 6);
  CheckSequence(Read(fd, 10 * 65535), 10, 65535);
  assert(Pending() == 0);

  // Closing preserves the previous full-drain-then-disconnect behaviour, including final data.
  Inject(300, 4);
  EM_ASM({ __mkwVnet.ws.onclose({code: 1000, reason: 'test finished'}); });
  WebVnet::Pump();
  assert(Pending() == 0);
  uint8_t byte = 0;
  assert(vnet_recv(fd, &byte, 1, MSG_DONTWAIT) == -1 && errno == ENETDOWN);
  CheckSequence(Read(fd, 1200), 300, 4);
  assert(vnet_close(fd) == 0);
  std::printf("VNET_HARNESS_OK packets_remaining=%d large_packets_remaining=%d ordered_payloads=1310\n",
              packetRemainder, byteRemainder);
}
