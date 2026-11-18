// Talks to one BLOCKS device group over a Web MIDI input/output pair.
// Follows the same connection sequence as ROLI's ConnectedDeviceGroup:
//   serial request -> topology request -> endAPIMode + beginAPIMode -> ping loop
// then asks each device for its full config ("factory sync").
//
// Connecting only reads. Entering/leaving API mode is what ROLI Dashboard
// does on every connect and doesn't change any stored setting. Settings are
// only changed by an explicit setConfig() call.

(function (root) {
  'use strict';
  var P = root.BlocksProtocol;

  var MASTER_PING_MS = 400;
  var DNA_PING_MS = 1666;

  function BlocksSession(input, output, events) {
    this.input = input;
    this.output = output;
    this.events = events || {};
    this.devices = {}; // by topology index
    this.serial = null;
    this.timers = [];
    this.pingTimer = null;
    this.otherMidiCount = 0;
    this.lastAckAt = 0;
    this.closed = false;
    this._onMessage = this._handleMidi.bind(this);
  }

  BlocksSession.prototype._emit = function (name, payload) {
    if (this.events[name]) this.events[name](payload);
  };

  BlocksSession.prototype._send = function (bytes, label) {
    if (this.closed && label !== 'endAPIMode') return;
    try {
      this.output.send(bytes);
      this._emit('log', { dir: 'out', label: label, hex: P.toHex(bytes) });
    } catch (e) {
      this._emit('log', { dir: 'err', label: 'send failed: ' + label, hex: String(e.message || e) });
    }
  };

  BlocksSession.prototype._later = function (ms, fn) {
    var self = this;
    var t = setTimeout(function () { if (!self.closed) fn(); }, ms);
    this.timers.push(t);
    return t;
  };

  BlocksSession.prototype.start = function () {
    var self = this;
    this.input.addEventListener('midimessage', this._onMessage);

    // 1. Serial number (retry every 300 ms, up to ~2 s; not every firmware answers).
    var serialTries = 0;
    (function askSerial() {
      if (self.serial || serialTries >= 6) return;
      serialTries++;
      self._send(P.SERIAL_REQUEST, 'serial request');
      self._later(300, askSerial);
    })();

    // 2. Topology (retry every second, up to 4 times, like ROLI's host).
    this.topologyTries = 0;
    this._requestTopology();
    this._emit('status', 'Asking the keyboard what it is…');
  };

  BlocksSession.prototype._requestTopology = function () {
    var self = this;
    if (this.gotTopology) return;
    if (this.topologyTries >= 4) {
      this._emit('status', 'No reply from the keyboard. Check the MIDI port, then try again.');
      this._emit('failed', 'no topology reply');
      return;
    }
    this.topologyTries++;
    this._send(P.deviceCommand(0, P.DeviceCommands.requestTopologyMessage), 'topology request');
    this._later(1000, function () { self._requestTopology(); });
  };

  BlocksSession.prototype._handleMidi = function (event) {
    var data = event.data;
    if (!data || data.length === 0) return;
    if (data[0] !== 0xf0) {
      this.otherMidiCount++;
      if (this.otherMidiCount % 25 === 1) this._emit('playing', this.otherMidiCount);
      return;
    }
    var serial = P.parseSerialResponse(data);
    if (serial) {
      this._emit('log', { dir: 'in', label: 'serial reply', hex: P.toHex(data) });
      if (serial.serial) {
        this.serial = serial;
        this._emit('serial', serial);
      }
      return;
    }
    if (!P.isBlocksPacket(data)) {
      this._emit('log', { dir: 'in', label: 'other SysEx', hex: P.toHex(data) });
      return;
    }
    var packet = P.decodePacket(data);
    var quiet = packet.messages && packet.messages.length === 1 && packet.messages[0].type === 'ack';
    if (!quiet) {
      this._emit('log', {
        dir: 'in',
        label: packet.error ? packet.error : packet.messages.map(function (m) { return m.type; }).join(', '),
        hex: P.toHex(data)
      });
    }
    if (packet.error) return;
    for (var i = 0; i < packet.messages.length; i++) {
      this._handleMessage(packet.deviceIndex, packet.messages[i]);
    }
  };

  BlocksSession.prototype._device = function (index) {
    if (!this.devices[index]) {
      this.devices[index] = { index: index, serial: null, version: null, name: null, config: {}, syncDone: false };
    }
    return this.devices[index];
  };

  BlocksSession.prototype._handleMessage = function (fromIndex, m) {
    var self = this;
    switch (m.type) {
      case 'topology':
        this.pendingTopology = { devices: m.devices.slice(), connections: m.connections.slice() };
        // Some firmware puts the whole topology in one packet without an end message.
        this._later(500, function () { if (self.pendingTopology) self._acceptTopology(); });
        break;
      case 'topologyExtend':
        if (this.pendingTopology) {
          this.pendingTopology.devices = this.pendingTopology.devices.concat(m.devices);
          this.pendingTopology.connections = this.pendingTopology.connections.concat(m.connections);
        }
        break;
      case 'topologyEnd':
        if (this.pendingTopology) this._acceptTopology();
        break;
      case 'version':
        this._device(m.index).version = m.version.replace(/\u0000+$/, '');
        this._emit('device', this._device(m.index));
        break;
      case 'name':
        this._device(m.index).name = m.name.replace(/\u0000+$/, '');
        this._emit('device', this._device(m.index));
        break;
      case 'ack':
        this.lastAckAt = Date.now();
        this._emit('ack', fromIndex);
        break;
      case 'configUpdate':
      case 'configSet': {
        var d = this._device(fromIndex);
        var entry = d.config[m.item] || {};
        entry.value = m.value;
        delete entry.pending;
        if (m.type === 'configUpdate') { entry.min = m.min; entry.max = m.max; }
        entry.seenAt = Date.now();
        d.config[m.item] = entry;
        this._emit('config', { device: d, item: m.item });
        break;
      }
      case 'configSyncEnd':
        this._device(fromIndex).syncDone = true;
        this._emit('syncDone', this._device(fromIndex));
        break;
      case 'log':
        this._emit('deviceLog', { index: fromIndex, text: m.text });
        break;
      default:
        break;
    }
  };

  BlocksSession.prototype._acceptTopology = function () {
    var self = this;
    var topo = this.pendingTopology;
    this.pendingTopology = null;
    if (this.gotTopology || !topo || topo.devices.length === 0) return;
    this.gotTopology = true;
    this.topology = topo;

    topo.devices.forEach(function (dev) {
      var d = self._device(dev.index);
      d.serial = dev.serial;
      d.batteryLevel = dev.batteryLevel;
      d.batteryCharging = dev.batteryCharging;
      d.kind = P.deviceTypeFromSerial(dev.serial);
      self._emit('device', d);
    });

    // 3. API mode on every device, exactly as ROLI does it: end, then begin.
    topo.devices.forEach(function (dev) {
      self._send(P.deviceCommand(dev.index, P.DeviceCommands.endAPIMode), 'endAPIMode');
      self._send(P.deviceCommand(dev.index, P.DeviceCommands.beginAPIMode), 'beginAPIMode');
    });

    // 4. Keep-alive pings. The master is the device the computer is plugged into.
    // Its topology index isn't always 0 (a Seaboard M reported 23), so match it by serial.
    var masterSerial = this.serial && this.serial.serial;
    var master = topo.devices.filter(function (d) { return d.serial === masterSerial; })[0] || topo.devices[0];
    this.masterIndex = master.index;
    var lastPing = {};
    this.pingTimer = setInterval(function () {
      var now = Date.now();
      topo.devices.forEach(function (dev) {
        var every = dev.index === self.masterIndex ? MASTER_PING_MS : DNA_PING_MS;
        if (!lastPing[dev.index] || now - lastPing[dev.index] >= every) {
          lastPing[dev.index] = now;
          self._sendQuiet(P.deviceCommand(dev.index, P.DeviceCommands.ping));
        }
      });
    }, 100);

    // 5. Ask for every setting.
    this._emit('status', 'Connected. Reading settings…');
    this._later(400, function () { self.readAllConfig(); });
  };

  // Pings are not logged; there are 2.5 of them a second.
  BlocksSession.prototype._sendQuiet = function (bytes) {
    if (this.closed) return;
    try { this.output.send(bytes); } catch (e) { /* reported by the next logged send */ }
  };

  BlocksSession.prototype.readAllConfig = function () {
    var self = this;
    var indexes = Object.keys(this.devices).map(Number);
    indexes.forEach(function (i) {
      self.devices[i].syncDone = false;
      self._send(P.configRequestFactorySync(i), 'request all settings');
    });
    // If a device doesn't answer the bulk request, fall back to asking item by item.
    this._later(2500, function () {
      indexes.forEach(function (i) {
        var d = self.devices[i];
        if (Object.keys(d.config).length === 0) {
          self._emit('status', 'No bulk reply. Asking for each setting one at a time…');
          self.requestEachItem(i);
        } else {
          self._emit('status', 'Connected. Read ' + Object.keys(d.config).length + ' settings.');
        }
      });
    });
  };

  BlocksSession.prototype.requestEachItem = function (index) {
    var self = this;
    var ids = (root.CONFIG_ITEMS || []).map(function (c) { return c.id; });
    ids.forEach(function (id, n) {
      self._later(n * 25, function () { self._sendQuiet(P.configRequest(index, id)); });
    });
    this._later(ids.length * 25 + 1500, function () {
      var count = Object.keys(self.devices[index].config).length;
      self._emit('status', count ? 'Connected. Read ' + count + ' settings.' : 'The keyboard did not send any settings back.');
    });
  };

  // Change one setting. The keyboard stores it itself, as it does for ROLI Dashboard.
  BlocksSession.prototype.setConfig = function (index, item, value) {
    this._send(P.configSet(index, item, value), 'set ' + item + ' = ' + value);
    var d = this._device(index);
    var entry = d.config[item] || {};
    entry.pending = value;
    d.config[item] = entry;
  };

  // Re-read everything, quietly, to confirm what the keyboard actually holds.
  BlocksSession.prototype.refresh = function () {
    var self = this;
    Object.keys(this.devices).forEach(function (i) {
      self._send(P.configRequestFactorySync(Number(i)), 'request all settings');
    });
  };

  BlocksSession.prototype.primaryDevice = function () {
    if (this.masterIndex != null && this.devices[this.masterIndex]) return this.devices[this.masterIndex];
    var keys = Object.keys(this.devices);
    return keys.length ? this.devices[keys[0]] : null;
  };

  BlocksSession.prototype.close = function () {
    var self = this;
    if (this.closed) return;
    // Hand the keyboard back to its normal standalone behaviour.
    Object.keys(this.devices).forEach(function (i) {
      try { self.output.send(P.deviceCommand(Number(i), P.DeviceCommands.endAPIMode)); } catch (e) { /* port gone */ }
    });
    this.closed = true;
    clearInterval(this.pingTimer);
    this.timers.forEach(clearTimeout);
    this.input.removeEventListener('midimessage', this._onMessage);
    this._emit('status', 'Disconnected.');
  };

  root.BlocksSession = BlocksSession;
})(this);
