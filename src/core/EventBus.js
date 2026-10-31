// EventBus - fixed vocabulary, pooled payloads (ARCHITECTURE.md section 5).
// emit() never allocates after the first emit of an id: listeners receive a reused payload
// object and must copy anything they keep beyond the dispatch.
export class EventBus {
  constructor(allowedIds = null) {
    this._listeners = new Map();   // id -> array of fns
    this._payloads = new Map();    // id -> reusable payload object
    this._allowed = allowedIds ? new Set(allowedIds) : null;
    this._depth = 0;
  }
  on(id, fn) {
    this._check(id);
    let list = this._listeners.get(id);
    if (!list) { list = []; this._listeners.set(id, list); }
    if (list.indexOf(fn) < 0) list.push(fn);
    return fn;
  }
  off(id, fn) {
    const list = this._listeners.get(id);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  // Returns the pooled payload for id; caller fills fields, then calls dispatch(id).
  payload(id) {
    this._check(id);
    let p = this._payloads.get(id);
    if (!p) { p = {}; this._payloads.set(id, p); }
    return p;
  }
  dispatch(id) {
    const list = this._listeners.get(id);
    if (!list || list.length === 0) return;
    const p = this._payloads.get(id);
    this._depth++;
    for (let i = 0; i < list.length; i++) list[i](p);
    this._depth--;
  }
  _check(id) {
    if (this._allowed && !this._allowed.has(id)) throw new Error('EventBus: unknown event id ' + id);
  }
  dispose() { this._listeners.clear(); this._payloads.clear(); }
}

export const EVENT_IDS = Object.freeze([
  'game/state', 'game/pause', 'wave/start', 'wave/clear', 'run/end', 'actor/spawn', 'actor/despawn',
  'actor/state', 'action/start', 'action/phase', 'action/end', 'combat/contact', 'combat/hitstop',
  'combat/parry', 'combat/guardbreak', 'combat/dodge', 'actor/damage', 'actor/death', 'boss/phase',
  'ai/telegraph', 'lock/target', 'world/footstep', 'fx/request', 'input/device',
  'weapon/equip',   // v2.10 { actorId, weapon } - appended, existing ids unchanged
]);
