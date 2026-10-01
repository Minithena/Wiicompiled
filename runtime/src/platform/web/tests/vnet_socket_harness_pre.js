globalThis.window = {mkwRoomToken: '', mkwRoomName: 'Transport test'};
globalThis.WebSocket = class {
  constructor(url) { this.url = url; this.bufferedAmount = 0; }
  close() {}
  send(payload) {
    const data = new Uint8Array(payload);
    if (data[0] !== 0x02) return;
    const conn = new DataView(data.buffer).getUint32(1);
    globalThis.__vnetTestConn = conn;
    const opened = new Uint8Array(5);
    opened[0] = 0x82;
    new DataView(opened.buffer).setUint32(1, conn);
    this.onmessage({data: opened.buffer});
  }
};
