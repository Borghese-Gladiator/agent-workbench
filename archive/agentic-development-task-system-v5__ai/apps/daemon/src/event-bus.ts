import { EventEmitter } from 'node:events';
import type { SemanticEvent } from '@awb/domain';

/**
 * In-process fan-out for SemanticEvents to connected WebSocket clients. This is not the
 * durable store of these events (that's the `semantic_events` SQLite table via the daemon's data
 * layer) — this bus only handles live delivery to currently-connected clients. A client that
 * reconnects catches up via a REST query keyed on `sequence`, not by replaying through this bus.
 */
export class SemanticEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publish(event: SemanticEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(handler: (event: SemanticEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}
