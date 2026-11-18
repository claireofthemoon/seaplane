// BLOCKS host protocol, ported to JavaScript from ROLI's open-source
// roli_blocks_basics (ISC licence): protocol/roli_BitPackingUtilities.h,
// roli_HostPacketBuilder.h, roli_HostPacketDecoder.h and
// roli_BlocksProtocolDefinitions.h.
//
// Packets look like: F0 00 21 10 77 <deviceIndex> <7-bit packed payload> <checksum> F7
// The payload is a bit stream written least-significant-bit first into 7-bit bytes.
// Host->device packets carry no timestamp. Device->host packets start with a
// 32-bit timestamp. Bit 6 (0x40) of the device index byte is set on packets
// coming from the device.

(function (root) {
  'use strict';

  var SYSEX_HEADER = [0xf0, 0x00, 0x21, 0x10, 0x77];
  var SERIAL_REQUEST = [0xf0, 0x00, 0x21, 0x10, 0x78, 0x3f, 0xf7];
  var SERIAL_RESPONSE_HEADER = [0xf0, 0x00, 0x21, 0x10, 0x78];
  var PROTOCOL_VERSION = 1;
  var BROADCAST_INDEX = 63;

  var MessageFromHost = {
    deviceCommandMessage: 0x01,
    sharedDataChange: 0x02,
    programEventMessage: 0x03,
    firmwareUpdatePacket: 0x04,
    configMessage: 0x10,
    factoryReset: 0x11,
    blockReset: 0x12,
    setName: 0x20
  };

  var MessageFromDevice = {
    deviceTopology: 0x01,
    packetACK: 0x02,
    firmwareUpdateACK: 0x03,
    deviceTopologyExtend: 0x04,
    deviceTopologyEnd: 0x05,
    deviceVersion: 0x06,
    deviceName: 0x07,
    touchStart: 0x10,
    touchMove: 0x11,
    touchEnd: 0x12,
    touchStartWithVelocity: 0x13,
    touchMoveWithVelocity: 0x14,
    touchEndWithVelocity: 0x15,
    configMessage: 0x18,
    controlButtonDown: 0x20,
    controlButtonUp: 0x21,
    programEventMessage: 0x28,
    logMessage: 0x30
  };

  var DeviceCommands = {
    beginAPIMode: 0x00,
    requestTopologyMessage: 0x01,
    endAPIMode: 0x02,
    ping: 0x03,
    debugMode: 0x04,
    saveProgramAsDefault: 0x05
  };

  var ConfigCommands = {
    setConfig: 0x00,
    requestConfig: 0x01,
    requestFactorySync: 0x02,
    requestUserSync: 0x03,
    updateConfig: 0x04,
    updateUserConfig: 0x05,
    setConfigState: 0x06,
    factorySyncEnd: 0x07,
    clusterConfigSync: 0x08,
    factorySyncReset: 0x09
  };

  var Bits = {
    messageType: 7,
    protocolVersion: 8,
    timestamp: 32,
    timestampOffset: 5,
    deviceCommand: 9,
    configCommand: 4,
    configItemIndex: 8,
    configItemValue: 32,
    deviceCount: 7,
    connectionCount: 8,
    topologyIndex: 7,
    batteryLevel: 5,
    batteryCharging: 1,
    connectorPort: 5,
    packetCounter: 10,
    serialLength: 16,
    touchIndex: 5,
    touchX: 12,
    touchY: 12,
    touchZ: 8,
    touchV: 8,
    controlButtonId: 12,
    firmwareAckCode: 7,
    firmwareAckDetail: 32
  };

  // ---------------------------------------------------------------- checksum

  function checksum(bytes) {
    var c = bytes.length & 0xff;
    for (var i = 0; i < bytes.length; i++) {
      c = (c + (c * 2 + bytes[i])) & 0xff;
    }
    return c & 0x7f;
  }

  // ---------------------------------------------------------------- bit writer

  function BitWriter() {
    this.bytes = [];
    this.bitPos = 0; // bits used in the last byte (0 means start a new byte)
  }

  BitWriter.prototype.write = function (value, numBits) {
    // Values up to 32 bits. Use arithmetic rather than >>> on the full value
    // so that 32-bit values (including negatives) survive.
    var v = value < 0 ? value + 4294967296 : value;
    while (numBits > 0) {
      if (this.bitPos === 0) this.bytes.push(0);
      var space = 7 - this.bitPos;
      var take = Math.min(space, numBits);
      var chunk = v % (1 << take);
      this.bytes[this.bytes.length - 1] |= chunk << this.bitPos;
      v = Math.floor(v / (1 << take));
      numBits -= take;
      this.bitPos = (this.bitPos + take) % 7;
    }
    return this;
  };

  // ---------------------------------------------------------------- bit reader

  function BitReader(bytes) {
    this.bytes = bytes;
    this.byteIndex = 0;
    this.bitIndex = 0;
  }

  BitReader.prototype.remaining = function () {
    return (this.bytes.length - this.byteIndex) * 7 - this.bitIndex;
  };

  BitReader.prototype.read = function (numBits) {
    if (numBits > this.remaining()) throw new Error('read past end of packet');
    var value = 0;
    var scale = 1;
    while (numBits > 0) {
      var available = 7 - this.bitIndex;
      var take = Math.min(available, numBits);
      var chunk = (this.bytes[this.byteIndex] >> this.bitIndex) & ((1 << take) - 1);
      value += chunk * scale;
      scale *= 1 << take;
      numBits -= take;
      this.bitIndex += take;
      if (this.bitIndex === 7) {
        this.bitIndex = 0;
        this.byteIndex++;
      }
    }
    return value;
  };

  BitReader.prototype.readSigned32 = function () {
    var v = this.read(32);
    return v >= 2147483648 ? v - 4294967296 : v;
  };

  // ---------------------------------------------------------------- packet building

  function buildPacket(deviceIndex, writeFn) {
    var w = new BitWriter();
    writeFn(w);
    var payload = w.bytes;
    return SYSEX_HEADER.concat([deviceIndex & 0x3f], payload, [checksum(payload), 0xf7]);
  }

  function deviceCommand(deviceIndex, command) {
    return buildPacket(deviceIndex, function (w) {
      w.write(MessageFromHost.deviceCommandMessage, Bits.messageType);
      w.write(command, Bits.deviceCommand);
    });
  }

  function configSet(deviceIndex, item, value) {
    return buildPacket(deviceIndex, function (w) {
      w.write(MessageFromHost.configMessage, Bits.messageType);
      w.write(ConfigCommands.setConfig, Bits.configCommand);
      w.write(item, Bits.configItemIndex);
      w.write(value, Bits.configItemValue);
    });
  }

  // Note the field order: ROLI's builder writes a 32-bit zero before the item index.
  function configRequest(deviceIndex, item) {
    return buildPacket(deviceIndex, function (w) {
      w.write(MessageFromHost.configMessage, Bits.messageType);
      w.write(ConfigCommands.requestConfig, Bits.configCommand);
      w.write(0, 32);
      w.write(item, Bits.configItemIndex);
    });
  }

  function configRequestFactorySync(deviceIndex) {
    return buildPacket(deviceIndex, function (w) {
      w.write(MessageFromHost.configMessage, Bits.messageType);
      w.write(ConfigCommands.requestFactorySync, Bits.configCommand);
    });
  }

  function configRequestUserSync(deviceIndex) {
    return buildPacket(deviceIndex, function (w) {
      w.write(MessageFromHost.configMessage, Bits.messageType);
      w.write(ConfigCommands.requestUserSync, Bits.configCommand);
    });
  }

  // ---------------------------------------------------------------- packet decoding

  function startsWith(data, prefix) {
    if (data.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
    return true;
  }

  function isBlocksPacket(data) {
    return startsWith(data, SYSEX_HEADER) && data[data.length - 1] === 0xf7;
  }

  function readString(r, length) {
    var s = '';
    for (var i = 0; i < length; i++) s += String.fromCharCode(r.read(7));
    return s;
  }

  // Returns { deviceIndex, fromDevice, timestamp, messages: [...] } or { error }.
  function decodePacket(data) {
    if (!isBlocksPacket(data)) return { error: 'not a BLOCKS packet' };
    var indexByte = data[SYSEX_HEADER.length];
    var body = Array.prototype.slice.call(data, SYSEX_HEADER.length + 1, data.length - 1);
    if (body.length < 1) return { error: 'empty packet' };
    var payload = body.slice(0, body.length - 1);
    var sum = body[body.length - 1];
    if (checksum(payload) !== sum) return { error: 'bad checksum' };

    var result = {
      deviceIndex: indexByte & 0x3f,
      fromDevice: (indexByte & 0x40) !== 0,
      timestamp: null,
      messages: []
    };

    var r = new BitReader(payload);
    if (r.remaining() < Bits.timestamp) return result;
    result.timestamp = r.read(Bits.timestamp);

    try {
      while (r.remaining() >= Bits.messageType) {
        var type = r.read(Bits.messageType);
        if (type === 0) break;
        var msg = decodeMessage(type, r);
        if (!msg) break;
        result.messages.push(msg);
        if (msg.stop) break;
      }
    } catch (e) {
      result.messages.push({ type: 'truncated', error: String(e.message || e) });
    }
    return result;
  }

  function decodeTopology(r, kind) {
    var version = r.read(Bits.protocolVersion);
    if (version > PROTOCOL_VERSION) return { type: kind, unsupportedVersion: version, stop: true };
    var numDevices = r.read(Bits.deviceCount);
    var numConnections = r.read(Bits.connectionCount);
    var devices = [];
    var connections = [];
    for (var i = 0; i < numDevices; i++) {
      devices.push({
        serial: readString(r, Bits.serialLength),
        index: r.read(Bits.topologyIndex),
        batteryLevel: r.read(Bits.batteryLevel),
        batteryCharging: r.read(Bits.batteryCharging) === 1
      });
    }
    for (var j = 0; j < numConnections; j++) {
      connections.push({
        device1: r.read(Bits.topologyIndex),
        port1: r.read(Bits.connectorPort),
        device2: r.read(Bits.topologyIndex),
        port2: r.read(Bits.connectorPort)
      });
    }
    return { type: kind, version: version, devices: devices, connections: connections };
  }

  function decodeMessage(type, r) {
    var T = MessageFromDevice;
    switch (type) {
      case T.deviceTopology: return decodeTopology(r, 'topology');
      case T.deviceTopologyExtend: return decodeTopology(r, 'topologyExtend');
      case T.deviceTopologyEnd: return { type: 'topologyEnd', version: r.read(Bits.protocolVersion) };
      case T.deviceVersion: {
        var vi = r.read(Bits.topologyIndex);
        return { type: 'version', index: vi, version: readString(r, r.read(7)) };
      }
      case T.deviceName: {
        var ni = r.read(Bits.topologyIndex);
        return { type: 'name', index: ni, name: readString(r, r.read(7)) };
      }
      case T.packetACK: return { type: 'ack', counter: r.read(Bits.packetCounter) };
      case T.firmwareUpdateACK:
        return { type: 'firmwareAck', code: r.read(Bits.firmwareAckCode), detail: r.read(Bits.firmwareAckDetail) };
      case T.touchStart: case T.touchMove: case T.touchEnd:
      case T.touchStartWithVelocity: case T.touchMoveWithVelocity: case T.touchEndWithVelocity: {
        var withV = type >= T.touchStartWithVelocity;
        var t = {
          type: 'touch',
          offset: r.read(Bits.timestampOffset),
          touchIndex: r.read(Bits.touchIndex),
          x: r.read(Bits.touchX), y: r.read(Bits.touchY), z: r.read(Bits.touchZ)
        };
        if (withV) { t.vx = r.read(Bits.touchV); t.vy = r.read(Bits.touchV); t.vz = r.read(Bits.touchV); }
        return t;
      }
      case T.controlButtonDown: case T.controlButtonUp:
        return {
          type: type === T.controlButtonDown ? 'buttonDown' : 'buttonUp',
          offset: r.read(Bits.timestampOffset),
          button: r.read(Bits.controlButtonId)
        };
      case T.configMessage: {
        var cmd = r.read(Bits.configCommand);
        if (cmd === ConfigCommands.updateConfig) {
          return {
            type: 'configUpdate',
            item: r.read(Bits.configItemIndex),
            value: r.readSigned32(),
            min: r.readSigned32(),
            max: r.readSigned32()
          };
        }
        if (cmd === ConfigCommands.setConfig) {
          return { type: 'configSet', item: r.read(Bits.configItemIndex), value: r.readSigned32() };
        }
        if (cmd === ConfigCommands.factorySyncEnd) return { type: 'configSyncEnd' };
        if (cmd === ConfigCommands.factorySyncReset) return { type: 'configSyncReset' };
        // Other config commands (e.g. user config metadata) are not decoded yet.
        return { type: 'configOther', command: cmd, stop: true };
      }
      case T.programEventMessage: {
        var ints = [];
        for (var k = 0; k < 3 && r.remaining() >= 32; k++) ints.push(r.readSigned32());
        return { type: 'programEvent', data: ints };
      }
      case T.logMessage: {
        var s = '';
        while (r.remaining() >= 7) s += String.fromCharCode(r.read(7));
        return { type: 'log', text: s, stop: true };
      }
      default:
        return { type: 'unknown', messageType: type, stop: true };
    }
  }

  // The serial dump reply contains a MAC address starting 48:B6:20: followed by
  // the 16-character serial number.
  function parseSerialResponse(data) {
    if (!startsWith(data, SERIAL_RESPONSE_HEADER)) return null;
    var text = '';
    for (var i = 0; i < data.length; i++) text += String.fromCharCode(data[i] & 0x7f);
    var at = text.indexOf('48:B6:20:');
    if (at < 0) return { raw: true };
    var mac = text.substr(at, 17);
    var serial = text.substr(at + 17, 16);
    return { mac: mac, serial: serial };
  }

  function deviceTypeFromSerial(serial) {
    var p = (serial || '').substr(0, 3);
    return {
      SBB: 'Seaboard Block / Seaboard M',
      LPB: 'Lightpad Block', LPM: 'Lightpad Block M', LPX: 'Lightpad Pro',
      LKB: 'LUMI Keys / ROLI Piano M', RP4: 'ROLI Piano 49',
      LIC: 'Live Block', LOC: 'Loop Block', DCB: 'Developer Control Block', TCB: 'Touch Block',
      AW1: 'Airwave'
    }[p] || 'Unknown device';
  }

  function toHex(bytes) {
    return Array.prototype.map.call(bytes, function (b) {
      return (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
    }).join(' ');
  }

  var api = {
    SYSEX_HEADER: SYSEX_HEADER,
    SERIAL_REQUEST: SERIAL_REQUEST,
    BROADCAST_INDEX: BROADCAST_INDEX,
    MessageFromHost: MessageFromHost,
    MessageFromDevice: MessageFromDevice,
    DeviceCommands: DeviceCommands,
    ConfigCommands: ConfigCommands,
    Bits: Bits,
    checksum: checksum,
    BitWriter: BitWriter,
    BitReader: BitReader,
    buildPacket: buildPacket,
    deviceCommand: deviceCommand,
    configSet: configSet,
    configRequest: configRequest,
    configRequestFactorySync: configRequestFactorySync,
    configRequestUserSync: configRequestUserSync,
    isBlocksPacket: isBlocksPacket,
    decodePacket: decodePacket,
    parseSerialResponse: parseSerialResponse,
    deviceTypeFromSerial: deviceTypeFromSerial,
    toHex: toHex
  };

  if (typeof module !== 'undefined') module.exports = api; else root.BlocksProtocol = api;
})(this);
