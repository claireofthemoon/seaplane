// A fake Web MIDI Seaboard for browser tests. Injected before the page loads.
// It answers serial, topology, ping and config-sync requests like a real device would.
(function () {
  var listeners = [];
  var sent = [];
  window.__sent = sent;
  function P() { return window.BlocksProtocol; }
  function reply(fields) {
    var w = new (P().BitWriter)();
    w.write(1000, 32);
    fields.forEach(function (f) { w.write(f[0], f[1]); });
    var payload = w.bytes;
    var bytes = P().SYSEX_HEADER.concat([0x40 | 23], payload, [P().checksum(payload), 0xf7]);
    setTimeout(function () {
      listeners.forEach(function (l) { l({ data: new Uint8Array(bytes) }); });
    }, 5);
  }
  function raw(bytes) { setTimeout(function () { listeners.forEach(function (l) { l({ data: new Uint8Array(bytes) }); }); }, 5); }
  var config = { 2: [1, 0, 2], 3: [48, 0, 96], 4: [0, -4, 5], 5: [0, -11, 11], 10: [127, 0, 127], 11: [102, 0, 127], 17: [0, 0, 1], 18: [0, 0, 127], 19: [0, 0, 1], 30: [1, 1, 4], 32: [1, 0, 5], 58: [0, 0, 1] };
  window.__config = config;
  var input = {
    id: 'in1', name: 'Seaboard M Bluetooth', manufacturer: 'ROLI Ltd.',
    open: function () { return Promise.resolve(); },
    addEventListener: function (t, f) { listeners.push(f); },
    removeEventListener: function (t, f) { listeners = listeners.filter(function (x) { return x !== f; }); }
  };
  var output = {
    id: 'out1', name: 'Seaboard M Bluetooth', manufacturer: 'ROLI Ltd.',
    open: function () { return Promise.resolve(); },
    send: function (data) {
      data = Array.from(data);
      sent.push(P().toHex(data));
      if (data[4] === 0x78) {
        var txt = 'xxxx48:B6:20:AA:BB:CCSBB2309123456789';
        raw([0xf0, 0, 0x21, 0x10, 0x78].concat(Array.from(txt, function (c) { return c.charCodeAt(0); }), [0xf7]));
        return;
      }
      var r = new (P().BitReader)(data.slice(6, -2));
      var type = r.read(7);
      if (type === 1) {
        var cmd = r.read(9);
        if (cmd === 1) {
          var f = [[1, 7], [1, 8], [1, 7], [0, 8]];
          Array.from('SBB2309123456789').forEach(function (c) { f.push([c.charCodeAt(0), 7]); });
          f.push([23, 7], [11, 5], [1, 1], [5, 7], [1, 8], [6, 7], [23, 7], [7, 7]);
          Array.from('M1.4.3\u0000').forEach(function (c) { f.push([c.charCodeAt(0), 7]); });
          reply(f);
        } else if (cmd === 3) {
          reply([[2, 7], [1, 10]]);
        }
      } else if (type === 0x10) {
        var c = r.read(4);
        if (c === 0) {
          var item = r.read(8), val = r.read(32);
          if (val >= 2147483648) val -= 4294967296;
          if (config[item]) config[item][0] = val;
        } else if (c === 2) {
          var fields = [];
          Object.keys(config).forEach(function (id) {
            var v = config[id];
            fields.push([0x18, 7], [4, 4], [Number(id), 8], [v[0], 32], [v[1], 32], [v[2], 32]);
          });
          fields.push([0x18, 7], [7, 4]);
          reply(fields);
        }
      }
    }
  };
  navigator.requestMIDIAccess = function () {
    return Promise.resolve({
      inputs: new Map([['in1', input]]),
      outputs: new Map([['out1', output]]),
      onstatechange: null
    });
  };
})();
