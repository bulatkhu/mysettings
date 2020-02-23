// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const { Object } = primordials;

const errors = require('internal/errors');
const {
  kStateSymbol,
  _createSocketHandle,
  newHandle,
} = require('internal/dgram');
const { guessHandleType } = internalBinding('util');
const {
  isLegalPort,
} = require('internal/net');
const {
  ERR_INVALID_ARG_TYPE,
  ERR_MISSING_ARGS,
  ERR_SOCKET_ALREADY_BOUND,
  ERR_SOCKET_BAD_BUFFER_SIZE,
  ERR_SOCKET_BAD_PORT,
  ERR_SOCKET_BUFFER_SIZE,
  ERR_SOCKET_CANNOT_SEND,
  ERR_SOCKET_DGRAM_IS_CONNECTED,
  ERR_SOCKET_DGRAM_NOT_CONNECTED,
  ERR_SOCKET_DGRAM_NOT_RUNNING,
  ERR_INVALID_FD_TYPE
} = errors.codes;
const {
  isInt32,
  validateString,
  validateNumber
} = require('internal/validators');
const { Buffer } = require('buffer');
const { deprecate } = require('internal/util');
const { isUint8Array } = require('internal/util/types');
const EventEmitter = require('events');
const {
  defaultTriggerAsyncIdScope,
  symbols: { async_id_symbol, owner_symbol }
} = require('internal/async_hooks');
const { UV_UDP_REUSEADDR } = internalBinding('constants').os;

const {
  constants: { UV_UDP_IPV6ONLY },
  UDP,
  SendWrap
} = internalBinding('udp_wrap');

const BIND_STATE_UNBOUND = 0;
const BIND_STATE_BINDING = 1;
const BIND_STATE_BOUND = 2;

const CONNECT_STATE_DISCONNECTED = 0;
const CONNECT_STATE_CONNECTING = 1;
const CONNECT_STATE_CONNECTED = 2;

const RECV_BUFFER = true;
const SEND_BUFFER = false;

// Lazily loaded
let cluster = null;

const errnoException = errors.errnoException;
const exceptionWithHostPort = errors.exceptionWithHostPort;


function Socket(type, listener) {
  EventEmitter.call(this);
  let lookup;
  let recvBufferSize;
  let sendBufferSize;

  let options;
  if (type !== null && typeof type === 'object') {
    options = type;
    type = options.type;
    lookup = options.lookup;
    recvBufferSize = options.recvBufferSize;
    sendBufferSize = options.sendBufferSize;
  }

  const handle = newHandle(type, lookup);
  handle[owner_symbol] = this;

  this[async_id_symbol] = handle.getAsyncId();
  this.type = type;

  if (typeof listener === 'function')
    this.on('message', listener);

  this[kStateSymbol] = {
    handle,
    receiving: false,
    bindState: BIND_STATE_UNBOUND,
    connectState: CONNECT_STATE_DISCONNECTED,
    queue: undefined,
    reuseAddr: options && options.reuseAddr, // Use UV_UDP_REUSEADDR if true.
    ipv6Only: options && options.ipv6Only,
    recvBufferSize,
    sendBufferSize
  };
}
Object.setPrototypeOf(Socket.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Socket, EventEmitter);


function createSocket(type, listener) {
  return new Socket(type, listener);
}


function startListening(socket) {
  const state = socket[kStateSymbol];

  state.handle.onmessage = onMessage;
  // Todo: handle errors
  state.handle.recvStart();
  state.receiving = true;
  state.bindState = BIND_STATE_BOUND;

  if (state.recvBufferSize)
    bufferSize(socket, state.recvBufferSize, RECV_BUFFER);

  if (state.sendBufferSize)
    bufferSize(socket, state.sendBufferSize, SEND_BUFFER);

  socket.emit('listening');
}

function replaceHandle(self, newHandle) {
  const state = self[kStateSymbol];
  const oldHandle = state.handle;

  // Set up the handle that we got from master.
  newHandle.lookup = oldHandle.lookup;
  newHandle.bind = oldHandle.bind;
  newHandle.send = oldHandle.send;
  newHandle[owner_symbol] = self;

  // Replace the existing handle by the handle we got from master.
  oldHandle.close();
  state.handle = newHandle;
  // Check if the udp handle was connected and set the state accordingly
  if (isConnected(self))
    state.connectState = CONNECT_STATE_CONNECTED;
}

function bufferSize(self, size, buffer) {
  if (size >>> 0 !== size)
    throw new ERR_SOCKET_BAD_BUFFER_SIZE();

  const ctx = {};
  const ret = self[kStateSymbol].handle.bufferSize(size, buffer, ctx);
  if (ret === undefined) {
    throw new ERR_SOCKET_BUFFER_SIZE(ctx);
  }
  return ret;
}

// Query master process to get the server handle and utilize it.
function bindServerHandle(self, options, errCb) {
  if (!cluster)
    cluster = require('cluster');

  const state = self[kStateSymbol];
  cluster._getServer(self, options, (err, handle) => {
    if (err) {
      errCb(err);
      return;
    }

    if (!state.handle) {
      // Handle has been closed in the mean time.
      return handle.close();
    }

    replaceHandle(self, handle);
    startListening(self);
  });
}

Socket.prototype.bind = function(port_, address_ /* , callback */) {
  let port = port_;

  healthCheck(this);
  const state = this[kStateSymbol];

  if (state.bindState !== BIND_STATE_UNBOUND)
    throw new ERR_SOCKET_ALREADY_BOUND();

  state.bindState = BIND_STATE_BINDING;

  if (arguments.length && typeof arguments[arguments.length - 1] === 'function')
    this.once('listening', arguments[arguments.length - 1]);

  if (port instanceof UDP) {
    replaceHandle(this, port);
    startListening(this);
    return this;
  }

  // Open an existing fd instead of creating a new one.
  if (port !== null && typeof port === 'object' &&
      isInt32(port.fd) && port.fd > 0) {
    const fd = port.fd;
    const exclusive = !!port.exclusive;
    const state = this[kStateSymbol];

    if (!cluster)
      cluster = require('cluster');

    if (cluster.isWorker && !exclusive) {
      bindServerHandle(this, {
        address: null,
        port: null,
        addressType: this.type,
        fd,
        flags: null
      }, (err) => {
        // Callback to handle error.
        const ex = errnoException(err, 'open');
        this.emit('error', ex);
        state.bindState = BIND_STATE_UNBOUND;
      });
      return this;
    }

    const type = guessHandleType(fd);
    if (type !== 'UDP')
      throw new ERR_INVALID_FD_TYPE(type);
    const err = state.handle.open(fd);

    if (err)
      throw errnoException(err, 'open');

    // Check if the udp handle was connected and set the state accordingly
    if (isConnected(this))
      state.connectState = CONNECT_STATE_CONNECTED;

    startListening(this);
    return this;
  }

  let address;
  let exclusive;

  if (port !== null && typeof port === 'object') {
    address = port.address || '';
    exclusive = !!port.exclusive;
    port = port.port;
  } else {
    address = typeof address_ === 'function' ? '' : address_;
    exclusive = false;
  }

  // Defaulting address for bind to all interfaces
  if (!address) {
    if (this.type === 'udp4')
      address = '0.0.0.0';
    else
      address = '::';
  }

  // Resolve address first
  state.handle.lookup(address, (err, ip) => {
    if (err) {
      state.bindState = BIND_STATE_UNBOUND;
      this.emit('error', err);
      return;
    }

    if (!cluster)
      cluster = require('cluster');

    let flags = 0;
    if (state.reuseAddr)
      flags |= UV_UDP_REUSEADDR;
    if (state.ipv6Only)
      flags |= UV_UDP_IPV6ONLY;

    if (cluster.isWorker && !exclusive) {
      bindServerHandle(this, {
        address: ip,
        port: port,
        addressType: this.type,
        fd: -1,
        flags: flags
      }, (err) => {
        // Callback to handle error.
        const ex = exceptionWithHostPort(err, 'bind', ip, port);
        this.emit('error', ex);
        state.bindState = BIND_STATE_UNBOUND;
      });
    } else {
      if (!state.handle)
        return; // Handle has been closed in the mean time

      const err = state.handle.bind(ip, port || 0, flags);
      if (err) {
        const ex = exceptionWithHostPort(err, 'bind', ip, port);
        this.emit('error', ex);
        state.bindState = BIND_STATE_UNBOUND;
        // Todo: close?
        return;
      }

      startListening(this);
    }
  });

  return this;
};


function validatePort(port) {
  const legal = isLegalPort(port);
  if (legal)
    port = port | 0;

  if (!legal || port === 0)
    throw new ERR_SOCKET_BAD_PORT(port);

  return port;
}


Socket.prototype.connect = function(port, address, callback) {
  port = validatePort(port);
  if (typeof address === 'function') {
    callback = address;
    address = '';
  } else if (address === undefined) {
    address = '';
  }

  validateString(address, 'address');

  const state = this[kStateSymbol];

  if (state.connectState !== CONNECT_STATE_DISCONNECTED)
    throw new ERR_SOCKET_DGRAM_IS_CONNECTED();

  state.connectState = CONNECT_STATE_CONNECTING;
  if (state.bindState === BIND_STATE_UNBOUND)
    this.bind({ port: 0, exclusive: true }, null);

  if (state.bindState !== BIND_STATE_BOUND) {
    enqueue(this, _connect.bind(this, port, address, callback));
    return;
  }

  _connect.call(this, port, address, callback);
};


function _connect(port, address, callback) {
  const state = this[kStateSymbol];
  if (callback)
    this.once('connect', callback);

  const afterDns = (ex, ip) => {
    defaultTriggerAsyncIdScope(
      this[async_id_symbol],
      doConnect,
      ex, this, ip, address, port, callback
    );
  };

  state.handle.lookup(address, afterDns);
}


function doConnect(ex, self, ip, address, port, callback) {
  const state = self[kStateSymbol];
  if (!state.handle)
    return;

  if (!ex) {
    const err = state.handle.connect(ip, port);
    if (err) {
      ex = exceptionWithHostPort(err, 'connect', address, port);
    }
  }

  if (ex) {
    state.connectState = CONNECT_STATE_DISCONNECTED;
    return process.nextTick(() => {
      if (callback) {
        self.removeListener('connect', callback);
        callback(ex);
      } else {
        self.emit('error', ex);
      }
    });
  }

  state.connectState = CONNECT_STATE_CONNECTED;
  process.nextTick(() => self.emit('connect'));
}


Socket.prototype.disconnect = function() {
  const state = this[kStateSymbol];
  if (state.connectState !== CONNECT_STATE_CONNECTED)
    throw new ERR_SOCKET_DGRAM_NOT_CONNECTED();

  const err = state.handle.disconnect();
  if (err)
    throw errnoException(err, 'connect');
  else
    state.connectState = CONNECT_STATE_DISCONNECTED;
};


// Thin wrapper around `send`, here for compatibility with dgram_legacy.js
Socket.prototype.sendto = function(buffer,
                                   offset,
                                   length,
                                   port,
                                   address,
                                   callback) {
  validateNumber(offset, 'offset');
  validateNumber(length, 'length');
  validateNumber(port, 'port');
  validateString(address, 'address');

  this.send(buffer, offset, length, port, address, callback);
};


function sliceBuffer(buffer, offset, length) {
  if (typeof buffer === 'string') {
    buffer = Buffer.from(buffer);
  } else if (!isUint8Array(buffer)) {
    throw new ERR_INVALID_ARG_TYPE('buffer',
                                   ['Buffer', 'Uint8Array', 'string'], buffer);
  }

  offset = offset >>> 0;
  length = length >>> 0;

  return buffer.slice(offset, offset + length);
}


function fixBufferList(list) {
  const newlist = new Array(list.length);

  for (let i = 0, l = list.length; i < l; i++) {
    const buf = list[i];
    if (typeof buf === 'string')
      newlist[i] = Buffer.from(buf);
    else if (!isUint8Array(buf))
      return null;
    else
      newlist[i] = buf;
  }

  return newlist;
}


function enqueue(self, toEnqueue) {
  const state = self[kStateSymbol];

  // If the send queue hasn't been initialized yet, do it, and install an
  // event handler that flushes the send queue after binding is done.
  if (state.queue === undefined) {
    state.queue = [];
    self.once('error', onListenError);
    self.once('listening', onListenSuccess);
  }
  state.queue.push(toEnqueue);
}


function onListenSuccess() {
  this.removeListener('error', onListenError);
  clearQueue.call(this);
}


function onListenError(err) {
  this.removeListener('listening', onListenSuccess);
  this[kStateSymbol].queue = undefined;
  this.emit('error', new ERR_SOCKET_CANNOT_SEND());
}


function clearQueue() {
  const state = this[kStateSymbol];
  const queue = state.queue;
  state.queue = undefined;

  // Flush the send queue.
  for (let i = 0; i < queue.length; i++)
    queue[i]();
}

function isConnected(self) {
  try {
    self.remoteAddress();
    return true;
  } catch {
    return false;
  }
}


// valid combinations
// For connectionless sockets
// send(buffer, offset, length, port, address, callback)
// send(buffer, offset, length, port, address)
// send(buffer, offset, length, port, callback)
// send(buffer, offset, length, port)
// send(bufferOrList, port, address, callback)
// send(bufferOrList, port, address)
// send(bufferOrList, port, callback)
// send(bufferOrList, port)
// For connected sockets
// send(buffer, offset, length, callback)
// send(buffer, offset, length)
// send(bufferOrList, callback)
// send(bufferOrList)
Socket.prototype.send = function(buffer,
                                 offset,
                                 length,
                                 port,
                                 address,
                                 callback) {

  let list;
  const state = this[kStateSymbol];
  const connected = state.connectState === CONNECT_STATE_CONNECTED;
  if (!connected) {
    if (address || (port && typeof port !== 'function')) {
      buffer = sliceBuffer(buffer, offset, length);
    } else {
      callback = port;
      port = offset;
      address = length;
    }
  } else {
    if (typeof length === 'number') {
      buffer = sliceBuffer(buffer, offset, length);
      if (typeof port === 'function') {
        callback = port;
        port = null;
      }
    } else {
      callback = offset;
    }

    if (port || address)
      throw new ERR_SOCKET_DGRAM_IS_CONNECTED();
  }

  if (!Array.isArray(buffer)) {
    if (typeof buffer === 'string') {
      list = [ Buffer.from(buffer) ];
    } else if (!isUint8Array(buffer)) {
      throw new ERR_INVALID_ARG_TYPE('buffer',
                                     ['Buffer', 'Uint8Array', 'string'],
                                     buffer);
    } else {
      list = [ buffer ];
    }
  } else if (!(list = fixBufferList(buffer))) {
    throw new ERR_INVALID_ARG_TYPE('buffer list arguments',
                                   ['Buffer', 'string'], buffer);
  }

  if (!connected)
    port = validatePort(port);

  // Normalize callback so it's either a function or undefined but not anything
  // else.
  if (typeof callback !== 'function')
    callback = undefined;

  if (typeof address === 'function') {
    callback = address;
    address = undefined;
  } else if (address && typeof address !== 'string') {
    throw new ERR_INVALID_ARG_TYPE('address', ['string', 'falsy'], address);
  }

  healthCheck(this);

  if (state.bindState === BIND_STATE_UNBOUND)
    this.bind({ port: 0, exclusive: true }, null);

  if (list.length === 0)
    list.push(Buffer.alloc(0));

  // If the socket hasn't been bound yet, push the outbound packet onto the
  // send queue and send after binding is complete.
  if (state.bindState !== BIND_STATE_BOUND) {
    enqueue(this, this.send.bind(this, list, port, address, callback));
    return;
  }

  const afterDns = (ex, ip) => {
    defaultTriggerAsyncIdScope(
      this[async_id_symbol],
      doSend,
      ex, this, ip, list, address, port, callback
    );
  };

  if (!connected) {
    state.handle.lookup(address, afterDns);
  } else {
    afterDns(null, null);
  }
};

function doSend(ex, self, ip, list, address, port, callback) {
  const state = self[kStateSymbol];

  if (ex) {
    if (typeof callback === 'function') {
      process.nextTick(callback, ex);
      return;
    }

    process.nextTick(() => self.emit('error', ex));
    return;
  } else if (!state.handle) {
    return;
  }

  const req = new SendWrap();
  req.list = list;  // Keep reference alive.
  req.address = address;
  req.port = port;
  if (callback) {
    req.callback = callback;
    req.oncomplete = afterSend;
  }

  let err;
  if (port)
    err = state.handle.send(req, list, list.length, port, ip, !!callback);
  else
    err = state.handle.send(req, list, list.length, !!callback);

  if (err >= 1) {
    // Synchronous finish. The return code is msg_length + 1 so that we can
    // distinguish between synchronous success and asynchronous success.
    if (callback)
      process.nextTick(callback, null, err - 1);
    return;
  }

  if (err && callback) {
    // Don't emit as error, dgram_legacy.js compatibility
    const ex = exceptionWithHostPort(err, 'send', address, port);
    process.nextTick(callback, ex);
  }
}

function afterSend(err, sent) {
  if (err) {
    err = exceptionWithHostPort(err, 'send', this.address, this.port);
  } else {
    err = null;
  }

  this.callback(err, sent);
}

Socket.prototype.close = function(callback) {
  const state = this[kStateSymbol];
  const queue = state.queue;

  if (typeof callback === 'function')
    this.on('close', callback);

  if (queue !== undefined) {
    queue.push(this.close.bind(this));
    return this;
  }

  healthCheck(this);
  stopReceiving(this);
  state.handle.close();
  state.handle = null;
  defaultTriggerAsyncIdScope(this[async_id_symbol],
                             process.nextTick,
                             socketCloseNT,
                             this);

  return this;
};


function socketCloseNT(self) {
  self.emit('close');
}


Socket.prototype.address = function() {
  healthCheck(this);

  const out = {};
  const err = this[kStateSymbol].handle.getsockname(out);
  if (err) {
    throw errnoException(err, 'getsockname');
  }

  return out;
};

Socket.prototype.remoteAddress = function() {
  healthCheck(this);

  const state = this[kStateSymbol];
  if (state.connectState !== CONNECT_STATE_CONNECTED)
    throw new ERR_SOCKET_DGRAM_NOT_CONNECTED();

  const out = {};
  const err = state.handle.getpeername(out);
  if (err)
    throw errnoException(err, 'getpeername');

  return out;
};


Socket.prototype.setBroadcast = function(arg) {
  const err = this[kStateSymbol].handle.setBroadcast(arg ? 1 : 0);
  if (err) {
    throw errnoException(err, 'setBroadcast');
  }
};


Socket.prototype.setTTL = function(ttl) {
  validateNumber(ttl, 'ttl');

  const err = this[kStateSymbol].handle.setTTL(ttl);
  if (err) {
    throw errnoException(err, 'setTTL');
  }

  return ttl;
};


Socket.prototype.setMulticastTTL = function(ttl) {
  validateNumber(ttl, 'ttl');

  const err = this[kStateSymbol].handle.setMulticastTTL(ttl);
  if (err) {
    throw errnoException(err, 'setMulticastTTL');
  }

  return ttl;
};


Socket.prototype.setMulticastLoopback = function(arg) {
  const err = this[kStateSymbol].handle.setMulticastLoopback(arg ? 1 : 0);
  if (err) {
    throw errnoException(err, 'setMulticastLoopback');
  }

  return arg; // 0.4 compatibility
};


Socket.prototype.setMulticastInterface = function(interfaceAddress) {
  healthCheck(this);
  validateString(interfaceAddress, 'interfaceAddress');

  const err = this[kStateSymbol].handle.setMulticastInterface(interfaceAddress);
  if (err) {
    throw errnoException(err, 'setMulticastInterface');
  }
};

Socket.prototype.addMembership = function(multicastAddress,
                                          interfaceAddress) {
  healthCheck(this);

  if (!multicastAddress) {
    throw new ERR_MISSING_ARGS('multicastAddress');
  }

  const { handle } = this[kStateSymbol];
  const err = handle.addMembership(multicastAddress, interfaceAddress);
  if (err) {
    throw errnoException(err, 'addMembership');
  }
};


Socket.prototype.dropMembership = function(multicastAddress,
                                           interfaceAddress) {
  healthCheck(this);

  if (!multicastAddress) {
    throw new ERR_MISSING_ARGS('multicastAddress');
  }

  const { handle } = this[kStateSymbol];
  const err = handle.dropMembership(multicastAddress, interfaceAddress);
  if (err) {
    throw errnoException(err, 'dropMembership');
  }
};


function healthCheck(socket) {
  if (!socket[kStateSymbol].handle) {
    // Error message from dgram_legacy.js.
    throw new ERR_SOCKET_DGRAM_NOT_RUNNING();
  }
}


function stopReceiving(socket) {
  const state = socket[kStateSymbol];

  if (!state.receiving)
    return;

  state.handle.recvStop();
  state.receiving = false;
}


function onMessage(nread, handle, buf, rinfo) {
  const self = handle[owner_symbol];
  if (nread < 0) {
    return self.emit('error', errnoException(nread, 'recvmsg'));
  }
  rinfo.size = buf.length; // compatibility
  self.emit('message', buf, rinfo);
}


Socket.prototype.ref = function() {
  const handle = this[kStateSymbol].handle;

  if (handle)
    handle.ref();

  return this;
};


Socket.prototype.unref = function() {
  const handle = this[kStateSymbol].handle;

  if (handle)
    handle.unref();

  return this;
};


Socket.prototype.setRecvBufferSize = function(size) {
  bufferSize(this, size, RECV_BUFFER);
};


Socket.prototype.setSendBufferSize = function(size) {
  bufferSize(this, size, SEND_BUFFER);
};


Socket.prototype.getRecvBufferSize = function() {
  return bufferSize(this, 0, RECV_BUFFER);
};


Socket.prototype.getSendBufferSize = function() {
  return bufferSize(this, 0, SEND_BUFFER);
};


// Deprecated private APIs.
Object.defineProperty(Socket.prototype, '_handle', {
  get: deprecate(function() {
    return this[kStateSymbol].handle;
  }, 'Socket.prototype._handle is deprecated', 'DEP0112'),
  set: deprecate(function(val) {
    this[kStateSymbol].handle = val;
  }, 'Socket.prototype._handle is deprecated', 'DEP0112')
});


Object.defineProperty(Socket.prototype, '_receiving', {
  get: deprecate(function() {
    return this[kStateSymbol].receiving;
  }, 'Socket.prototype._receiving is deprecated', 'DEP0112'),
  set: deprecate(function(val) {
    this[kStateSymbol].receiving = val;
  }, 'Socket.prototype._receiving is deprecated', 'DEP0112')
});


Object.defineProperty(Socket.prototype, '_bindState', {
  get: deprecate(function() {
    return this[kStateSymbol].bindState;
  }, 'Socket.prototype._bindState is deprecated', 'DEP0112'),
  set: deprecate(function(val) {
    this[kStateSymbol].bindState = val;
  }, 'Socket.prototype._bindState is deprecated', 'DEP0112')
});


Object.defineProperty(Socket.prototype, '_queue', {
  get: deprecate(function() {
    return this[kStateSymbol].queue;
  }, 'Socket.prototype._queue is deprecated', 'DEP0112'),
  set: deprecate(function(val) {
    this[kStateSymbol].queue = val;
  }, 'Socket.prototype._queue is deprecated', 'DEP0112')
});


Object.defineProperty(Socket.prototype, '_reuseAddr', {
  get: deprecate(function() {
    return this[kStateSymbol].reuseAddr;
  }, 'Socket.prototype._reuseAddr is deprecated', 'DEP0112'),
  set: deprecate(function(val) {
    this[kStateSymbol].reuseAddr = val;
  }, 'Socket.prototype._reuseAddr is deprecated', 'DEP0112')
});


Socket.prototype._healthCheck = deprecate(function() {
  healthCheck(this);
}, 'Socket.prototype._healthCheck() is deprecated', 'DEP0112');


Socket.prototype._stopReceiving = deprecate(function() {
  stopReceiving(this);
}, 'Socket.prototype._stopReceiving() is deprecated', 'DEP0112');


// Legacy alias on the C++ wrapper object. This is not public API, so we may
// want to runtime-deprecate it at some point. There's no hurry, though.
Object.defineProperty(UDP.prototype, 'owner', {
  get() { return this[owner_symbol]; },
  set(v) { return this[owner_symbol] = v; }
});


module.exports = {
  _createSocketHandle: deprecate(
    _createSocketHandle,
    'dgram._createSocketHandle() is deprecated',
    'DEP0112'
  ),
  createSocket,
  Socket
};