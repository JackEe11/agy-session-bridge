'use strict';

const cp = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');

const turnAls = new AsyncLocalStorage();

class BusyError extends Error {
  constructor(message = 'TurnQueue is busy') {
    super(message);
    this.name = 'BusyError';
    this.code = 'EBUSY';
  }
}

function registerActiveChild(child) {
  if (!child) return;
  const store = turnAls.getStore();
  if (store) {
    store.addChild(child);
  }
}

globalThis.__agyRegisterChild = registerActiveChild;

if (cp.ChildProcess && cp.ChildProcess.prototype && !cp.ChildProcess.prototype.__agyHooked) {
  const origSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (...args) {
    const ret = origSpawn.apply(this, args);
    registerActiveChild(this);
    return ret;
  };
  cp.ChildProcess.prototype.__agyHooked = true;
}

class TurnQueue {
  constructor({
    maxConcurrent = config.MAX_CONCURRENT,
    limit = config.QUEUE_LIMIT,
    timeoutMs = config.QUEUE_TIMEOUT_MS,
    preemptWaitMs = config.PREEMPT_WAIT_MS,
  } = {}) {
    this.maxConcurrent = Number(maxConcurrent) > 0 ? Number(maxConcurrent) : 1;
    this.limit = Number(limit) >= 0 ? Number(limit) : 2;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000;
    this.preemptWaitMs = Number(preemptWaitMs) > 0 ? Number(preemptWaitMs) : 1500;
    this.running = new Map();
    this.waiting = [];
    this._reserved = 0;
  }

  get size() {
    return this.waiting.length;
  }

  _killEntryChildren(entry, sig = 'SIGTERM') {
    if (entry.ctx) {
      const attached = entry.ctx.child || entry.ctx.proc || entry.ctx.process;
      if (attached) entry.addChild(attached);
    }
    for (const child of entry.children) {
      try {
        if (child && typeof child.kill === 'function' && !child.killed && child.exitCode === null) {
          child.kill(sig);
        }
      } catch {}
    }
  }

  _drain() {
    while (this.running.size + this._reserved < this.maxConcurrent && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next.timer) clearTimeout(next.timer);
      if (next.cancelled) continue;
      this._reserved++;
      next.grant();
    }
  }

  async _preemptRunning(taskKey) {
    const existing = this.running.get(taskKey);
    if (!existing) return;

    existing.preempted = true;
    if (typeof existing.onPreempt === 'function') {
      try { existing.onPreempt(); } catch {}
    }
    try { existing.controller.abort(); } catch {}
    this._killEntryChildren(existing, 'SIGTERM');

    let timer;
    const waitMs = this.preemptWaitMs;
    const released = await Promise.race([
      existing.donePromise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    clearTimeout(timer);

    if (!released && this.running.get(taskKey) === existing) {
      throw new BusyError(`Key "${taskKey}" is still occupied ${waitMs}ms after SIGTERM`);
    }
  }

  /**
   * 同一个 key 已有任务在跑时：先 SIGTERM 旧进程，300ms 后仍占用则抛 BusyError
   */
  async run(key, fn, { onPreempt } = {}) {
    const taskKey = String(key || 'default');

    // If same key is waiting in queue, remove and preempt the queued entry
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i].key === taskKey) {
        const queued = this.waiting.splice(i, 1)[0];
        queued.cancelled = true;
        if (queued.timer) clearTimeout(queued.timer);
        if (typeof queued.onPreempt === 'function') {
          try { queued.onPreempt(); } catch {}
        }
        queued.reject(new BusyError(`Queued task for key "${taskKey}" was preempted`));
      }
    }

    // If same key is currently running, preempt it with SIGTERM and wait up to 300ms
    if (this.running.has(taskKey)) {
      await this._preemptRunning(taskKey);
    }

    // If concurrency limit is reached, wait in queue
    if (this.running.size + this._reserved >= this.maxConcurrent) {
      if (this.waiting.length >= this.limit) {
        throw new BusyError(`Queue limit (${this.limit}) exceeded`);
      }
      await new Promise((resolve, reject) => {
        const waiter = {
          key: taskKey,
          onPreempt,
          cancelled: false,
          timer: null,
          grant: resolve,
          reject,
        };
        waiter.timer = setTimeout(() => {
          const idx = this.waiting.indexOf(waiter);
          if (idx >= 0) this.waiting.splice(idx, 1);
          waiter.cancelled = true;
          reject(new BusyError(`Queue timeout after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
        this.waiting.push(waiter);
      });

      try {
        if (this.running.has(taskKey)) {
          await this._preemptRunning(taskKey);
        }
        if (this.running.has(taskKey)) {
          throw new BusyError(`Key "${taskKey}" is already running`);
        }
      } catch (err) {
        this._reserved--;
        setImmediate(() => this._drain());
        throw err;
      }
      this._reserved--;
    } else if (this.running.has(taskKey)) {
      throw new BusyError(`Key "${taskKey}" is already running`);
    }

    let resolveDone;
    const donePromise = new Promise((r) => { resolveDone = r; });
    const controller = new AbortController();
    const children = new Set();

    const entry = {
      key: taskKey,
      onPreempt,
      preempted: false,
      controller,
      children,
      donePromise,
      resolveDone,
      ctx: null,
      addChild(child) {
        if (!child) return;
        if (!children.has(child)) {
          children.add(child);
          const cleanup = () => {
            children.delete(child);
          };
          if (typeof child.once === 'function') {
            child.once('exit', cleanup);
            child.once('close', cleanup);
          } else if (typeof child.on === 'function') {
            child.on('exit', cleanup);
            child.on('close', cleanup);
          }
        }
        if (entry.preempted) {
          try {
            if (typeof child.kill === 'function' && !child.killed && child.exitCode === null) {
              child.kill('SIGTERM');
            }
          } catch {}
        }
      },
    };

    const ctx = function registerProcess(child) {
      entry.addChild(child);
    };
    ctx.register = (child) => entry.addChild(child);
    ctx.setChild = (child) => entry.addChild(child);
    ctx.setProcess = (child) => entry.addChild(child);
    ctx.signal = controller.signal;
    ctx.addEventListener = controller.signal.addEventListener.bind(controller.signal);
    ctx.removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
    Object.defineProperty(ctx, 'aborted', {
      get() {
        return controller.signal.aborted;
      },
    });
    entry.ctx = ctx;

    this.running.set(taskKey, entry);

    try {
      const taskPromise = turnAls.run(entry, () => Promise.resolve().then(() => fn(ctx)));
      if (taskPromise && typeof taskPromise === 'object') {
        const attached = taskPromise.child || taskPromise.proc || taskPromise.process;
        if (attached) entry.addChild(attached);
      }
      return await taskPromise;
    } finally {
      if (this.running.get(taskKey) === entry) {
        this.running.delete(taskKey);
      }
      entry.resolveDone();
      setImmediate(() => this._drain());
    }
  }
}

module.exports = {
  TurnQueue,
  BusyError,
};
