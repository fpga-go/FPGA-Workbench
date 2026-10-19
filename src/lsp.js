'use strict';

const { spawn } = require('node:child_process');

/** Small stdio JSON-RPC client. It deliberately registers no editor providers. */
class StdioLsp {
  constructor(options = {}) {
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.expected = null;
    this.closed = true;
  }

  start(command, args = [], options = {}) {
    if (this.child && !this.closed) throw new Error('Language server is already running.');
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.expected = null;
    const child = this.child = spawn(command, args, { ...options, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => this.consume(chunk));
    child.stderr.on('data', chunk => this.options.onStderr?.(chunk.toString('utf8')));
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`Language server exited (${code ?? signal}).`)));
    child.stdin.on('error', error => this.fail(error));
    return this;
  }

  send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('Language server is not running.');
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  request(method, params, options = {}) {
    if (options.token?.isCancellationRequested) return Promise.reject(new Error('Request cancelled.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(entry.timer); entry.cancellation?.dispose(); this.pending.delete(id); };
      const entry = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
      this.pending.set(id, entry);
      entry.timer = setTimeout(() => {
        try { this.notify('$/cancelRequest', { id }); } catch (_) { /* process already exited */ }
        entry.reject(new Error(`${method} timed out.`));
      }, options.timeout ?? this.options.timeout ?? 10000);
      if (options.token) entry.cancellation = options.token.onCancellationRequested(() => {
        try { this.notify('$/cancelRequest', { id }); } catch (_) { /* process already exited */ }
        entry.reject(new Error('Request cancelled.'));
      });
      try { this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { entry.reject(error); }
    });
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        if (this.expected === null) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (this.buffer.length > 8192) throw new Error('Invalid LSP header.');
            return;
          }
          const header = this.buffer.subarray(0, end).toString('ascii');
          const length = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
          if (!length || Number(length[1]) > 64 * 1024 * 1024) throw new Error('Invalid LSP content length.');
          this.expected = Number(length[1]);
          this.buffer = this.buffer.subarray(end + 4);
        }
        if (this.buffer.length < this.expected) return;
        const body = this.buffer.subarray(0, this.expected);
        this.buffer = this.buffer.subarray(this.expected);
        this.expected = null;
        this.dispatch(JSON.parse(body.toString('utf8')));
      }
    } catch (error) {
      this.fail(error);
      this.child?.kill();
    }
  }

  dispatch(message) {
    if (message.method) {
      if (Object.hasOwn(message, 'id')) {
        Promise.resolve().then(() => this.options.onRequest?.(message.method, message.params)).then(result => {
          if (!this.closed) this.send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
        }).catch(error => {
          if (!this.closed) {
            try { this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }); }
            catch (_) { /* process exited while answering */ }
          }
        });
      } else {
        try { this.options.onNotification?.(message.method, message.params); }
        catch (error) { this.options.onStderr?.(`Notification handler: ${error.message}`); }
      }
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    if (message.error) request.reject(new Error(message.error.message || 'Language server request failed.'));
    else request.resolve(message.result);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.options.onExit?.(error);
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    if (!this.closed) {
      try { await this.request('shutdown', null, { timeout: 1500 }); } catch (_) { /* bounded shutdown */ }
      try { this.notify('exit'); } catch (_) { /* process already exited */ }
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.fail(new Error('Language server stopped.'));
    this.child = undefined;
  }
}

module.exports = { StdioLsp };
