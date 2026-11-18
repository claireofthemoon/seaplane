// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const P = require('../js/blocks-protocol.js');
const CONFIG_ITEMS = require('../js/config-items.js');

// A literal translation of ROLI's Packed7BitArrayBuilder::writeBits, used as an
// independent reference for our BitWriter.
function referenceWriteBits(state, value, numBits) {
  value = value >>> 0;
  while (numBits > 0) {
    if (state.bitsInCurrentByte === 0) {
      if (numBits < 7) { state.data[state.bytesWritten] = value & 0xff; state.bitsInCurrentByte = numBits; return; }
      if (numBits === 7) { state.data[state.bytesWritten++] = value & 0xff; return; }
      state.data[state.bytesWritten++] = value & 0x7f;
      value = value >>> 7;
      numBits -= 7;
    } else {
      const bitsToDo = Math.min(7 - state.bitsInCurrentByte, numBits);
      state.data[state.bytesWritten] |= ((value & ((1 << bitsToDo) - 1)) << state.bitsInCurrentByte);
      value = value >>> bitsToDo;
      numBits -= bitsToDo;
      state.bitsInCurrentByte += bitsToDo;
      if (state.bitsInCurrentByte === 7) { state.bitsInCurrentByte = 0; state.bytesWritten++; }
    }
  }
}

function referencePayload(fields) {
  const s = { data: new Array(64).fill(0), bytesWritten: 0, bitsInCurrentByte: 0 };
  for (const [v, n] of fields) referenceWriteBits(s, v, n);
  return s.data.slice(0, s.bytesWritten + (s.bitsInCurrentByte > 0 ? 1 : 0));
}

test('ping packet matches a hand-computed vector', () => {
  // type 0x01 (7 bits), command 3 (9 bits) -> 01 03 00, checksum 0x63
  assert.deepStrictEqual(P.deviceCommand(0, P.DeviceCommands.ping),
    [0xf0, 0x00, 0x21, 0x10, 0x77, 0x00, 0x01, 0x03, 0x00, 0x63, 0xf7]);
});

test('BitWriter matches ROLI reference packing for many field mixes', () => {
  const sizes = [1, 4, 5, 7, 8, 9, 12, 16, 32];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  for (let iter = 0; iter < 2000; iter++) {
    const fields = [];
    const n = 1 + (rnd() % 6);
    for (let i = 0; i < n; i++) {
      const bits = sizes[rnd() % sizes.length];
      const v = bits === 32 ? rnd() : rnd() % (2 ** bits);
      fields.push([v, bits]);
    }
    const w = new P.BitWriter();
    for (const [v, b] of fields) w.write(v, b);
    assert.deepStrictEqual(w.bytes, referencePayload(fields), JSON.stringify(fields));
    // and every byte is 7-bit clean
    assert.ok(w.bytes.every((b) => b < 0x80));
    // round trip through the reader
    const r = new P.BitReader(w.bytes);
    for (const [v, b] of fields) assert.strictEqual(r.read(b), v >>> 0 === v ? v : v >>> 0);
  }
});

test('negative 32-bit config values survive a round trip', () => {
  const w = new P.BitWriter();
  w.write(-2147483648, 32).write(-1, 32).write(48, 32);
  const r = new P.BitReader(w.bytes);
  assert.strictEqual(r.readSigned32(), -2147483648);
  assert.strictEqual(r.readSigned32(), -1);
  assert.strictEqual(r.readSigned32(), 48);
});

test('checksum matches ROLI algorithm on an empty and a long payload', () => {
  assert.strictEqual(P.checksum([]), 0);
  const bytes = Array.from({ length: 50 }, (_, i) => (i * 37) & 0x7f);
  let c = bytes.length & 0xff;
  for (const b of bytes) c = (c + (c * 2 + b)) & 0xff;
  assert.strictEqual(P.checksum(bytes), c & 0x7f);
});

test('config set and request use ROLI field order', () => {
  const set = P.configSet(0, 17, 1);
  assert.deepStrictEqual(set.slice(6, -2),
    referencePayload([[0x10, 7], [0x00, 4], [17, 8], [1, 32]]));
  const req = P.configRequest(0, 17);
  assert.deepStrictEqual(req.slice(6, -2),
    referencePayload([[0x10, 7], [0x01, 4], [0, 32], [17, 8]]));
  const sync = P.configRequestFactorySync(0);
  assert.deepStrictEqual(sync.slice(6, -2), referencePayload([[0x10, 7], [0x02, 4]]));
});

// Build a device->host packet so we can test the decoder.
function devicePacket(index, fields) {
  const w = new P.BitWriter();
  w.write(123456, 32); // timestamp
  for (const [v, b] of fields) w.write(v, b);
  const payload = w.bytes;
  return P.SYSEX_HEADER.concat([0x40 | index], payload, [P.checksum(payload), 0xf7]);
}

test('decodes a topology message with one Seaboard', () => {
  const serial = 'SBB1234567890ABC';
  const fields = [[0x01, 7], [1, 8], [1, 7], [0, 8]];
  for (const ch of serial) fields.push([ch.charCodeAt(0), 7]);
  fields.push([0, 7], [20, 5], [1, 1]);
  fields.push([0x05, 7], [1, 8]); // topology end
  const d = P.decodePacket(devicePacket(0, fields));
  assert.strictEqual(d.fromDevice, true);
  assert.strictEqual(d.timestamp, 123456);
  assert.strictEqual(d.messages[0].type, 'topology');
  assert.deepStrictEqual(d.messages[0].devices[0], { serial, index: 0, batteryLevel: 20, batteryCharging: true });
  assert.strictEqual(d.messages[1].type, 'topologyEnd');
  assert.strictEqual(P.deviceTypeFromSerial(serial), 'Seaboard Block / Seaboard M');
});

test('decodes config update, set and sync end messages', () => {
  const d = P.decodePacket(devicePacket(0, [
    [0x18, 7], [0x04, 4], [3, 8], [48, 32], [1, 32], [96, 32],
    [0x18, 7], [0x00, 4], [17, 8], [1, 32],
    [0x18, 7], [0x07, 4]
  ]));
  assert.deepStrictEqual(d.messages.map((m) => m.type), ['configUpdate', 'configSet', 'configSyncEnd']);
  assert.deepStrictEqual(d.messages[0], { type: 'configUpdate', item: 3, value: 48, min: 1, max: 96 });
  assert.deepStrictEqual(d.messages[1], { type: 'configSet', item: 17, value: 1 });
});

test('rejects a packet with a bad checksum', () => {
  const p = devicePacket(0, [[0x02, 7], [5, 10]]);
  p[p.length - 2] ^= 1;
  assert.strictEqual(P.decodePacket(p).error, 'bad checksum');
});

test('parses a serial dump reply', () => {
  const text = 'xx48:B6:20:01:02:03SBB1234567890ABCyy';
  const bytes = [0xf0, 0x00, 0x21, 0x10, 0x78].concat(Array.from(text, (c) => c.charCodeAt(0)), [0xf7]);
  assert.deepStrictEqual(P.parseSerialResponse(bytes), { mac: '48:B6:20:01:02:03', serial: 'SBB1234567890ABC' });
});

test('config table has the pitch settings we care about', () => {
  const byKey = Object.fromEntries(CONFIG_ITEMS.map((c) => [c.key, c]));
  assert.strictEqual(byKey.pianoMode.id, 17);
  assert.strictEqual(byKey.glideLock.id, 18);
  assert.strictEqual(byKey.glideLockEnable.id, 19);
  assert.strictEqual(byKey.pitchBendRange.id, 3);
  assert.strictEqual(new Set(CONFIG_ITEMS.map((c) => c.id)).size, CONFIG_ITEMS.length);
});
