import * as A from '@automerge/automerge';
import {Transaction} from 'wordgard/state';
import {Token} from 'wordgard/doc';
import {LineBreak} from 'wordgard/types';
import {PATH, decode, encode, expand, toMarks, markName, type Document, type NativeDoc, type Comment} from './model.ts';

export interface Presence {session: string; name: string; anchor: string; head: string; heads: string[]; object: string; at: number}
export interface Change {remote: boolean; patches: A.Patch[]; before: NativeDoc; after: NativeDoc}
export class Replica {
  doc: NativeDoc;
  syncState = A.initSyncState();
  readonly listeners = new Set<(change: Change) => void>();
  readonly presenceListeners = new Set<() => void>();
  peer: Presence | null = null;
  private visiblePeer: Presence | null = null;
  localPresence: Presence | null = null;
  sendPresence: (value: Presence | null) => void = () => {};
  sendChanges: () => void = () => {};
  edits = 0;
  readonly name: string;
  constructor(name: string, doc: NativeDoc) { this.name = name; this.doc = A.clone(doc); }
  change(message: string, fn: (d: Document) => void) {
    const before = this.doc;
    let patches: A.Patch[] = [];
    this.doc = A.change(this.doc, {message, patchCallback: p => { patches = p; }}, fn);
    if (A.getHeads(before).join() === A.getHeads(this.doc).join()) return;
    this.edits++;
    for (const listener of this.listeners) listener({remote: false, before, after: this.doc, patches});
    this.sendChanges();
  }
  receive(message: Uint8Array) {
    const before = this.doc;
    let patches: A.Patch[] = [];
    [this.doc, this.syncState] = A.receiveSyncMessage(this.doc, this.syncState, message, {patchCallback: p => { patches = p; }});
    if (A.getHeads(before).join() !== A.getHeads(this.doc).join()) {
      for (const listener of this.listeners) listener({remote: true, before, after: this.doc, patches});
    }
  }
  nextMessage() {
    let message: Uint8Array | null;
    [this.syncState, message] = A.generateSyncMessage(this.doc, this.syncState);
    return message;
  }
  applyChanges(changes: Uint8Array[]) {
    const before = this.doc; let patches: A.Patch[] = [];
    [this.doc] = A.applyChanges(this.doc, changes, {patchCallback: p => { patches = p; }});
    if (A.getHeads(before).join() !== A.getHeads(this.doc).join()) {
      for (const listener of this.listeners) listener({remote: true, before, after: this.doc, patches});
      this.sendChanges();
    }
  }
  observe(listener: (change: Change) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  receivePresence(value: Presence | null) {
    // A newer cursor can arrive before the changes it references. Retain the
    // last resolvable cursor for this session/object until those changes land.
    // Explicit departure, a different session, or a different text object
    // must never reuse an old cursor.
    if (!value || value.session !== this.peer?.session || value.object !== this.peer?.object) this.visiblePeer = null;
    this.peer = value;
    this.peerRange();
    this.presenceListeners.forEach(fn => fn());
  }
  publish(anchor: number, head: number) {
    const value: Presence = {session: A.getActorId(this.doc), name: this.name, anchor: A.getCursor(this.doc, PATH, anchor, 'after'), head: A.getCursor(this.doc, PATH, head, head <= anchor ? 'after' : 'before'), heads: A.getHeads(this.doc), object: A.getObjectId(this.doc, 'body')!, at: Date.now()};
    this.localPresence = value;
    this.sendPresence(value);
  }
  hidePresence() { this.localPresence = null; this.sendPresence(null); }
  peerRange(): {anchor: number; head: number; name: string} | null {
    const resolve = (peer: Presence | null) => {
      if (!peer || Date.now() - peer.at > 30000 || !A.hasHeads(this.doc, peer.heads) || peer.object !== A.getObjectId(this.doc, 'body')) return null;
      try { return {anchor: A.getCursorPosition(this.doc, PATH, peer.anchor), head: A.getCursorPosition(this.doc, PATH, peer.head), name: peer.name}; } catch { return null; }
    };
    const latest = resolve(this.peer);
    if (latest) { this.visiblePeer = this.peer; return latest; }
    return resolve(this.visiblePeer);
  }
  comment(from: number, to: number, body: string) {
    if (to <= from || !body.trim()) throw Error('Select a passage and enter a comment');
    const quote = this.doc.body.slice(from, to);
    const lastWidth = [...quote].at(-1)!.length;
    const comment: Comment = {id: crypto.randomUUID(), body: body.trim(), quote: quote.replaceAll('\ufffc', '\n'), first: A.getCursor(this.doc, PATH, from, 'after'), last: A.getCursor(this.doc, PATH, to - lastWidth, 'before'), lastWidth, object: A.getObjectId(this.doc, 'body')!, author: this.name, resolved: false};
    this.change('Comment on a passage', d => { d.comments[comment.id] = comment; });
    return comment.id;
  }
  applyEditorTransaction(tr: Transaction) {
    if (!tr.docChanged) return;
    const original = encode(tr.startState.doc), next = encode(tr.newDoc);
    // The view must be a current projection, never a stale independent writer.
    if (!decode(A.spans(this.doc, PATH)).eq(tr.startState.doc)) throw Error('Editor is behind its Automerge replica');
    const replacements: {from: number; to: number; fromB: number; toB: number; inserted: readonly Token[]}[] = [];
    const formats: {from: number; to: number; add?: ReturnType<typeof toMarks>; remove?: string}[] = [];
    let structural = false;
    tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
      if (inserted.some(t => t.tokenType !== Token.Type.Node || (!t.isText && t.type !== LineBreak.type))) structural = true;
      // Any removed structural token requires the span reconciliation path.
      if (to - from !== original.map.wgToAm[to] - original.map.wgToAm[from]) structural = true;
      if (tr.startState.doc.slice(from, to).some(t => t.tokenType !== Token.Type.Node || (!t.isText && t.type !== LineBreak.type))) structural = true;
      replacements.push({from, to, fromB, toB, inserted});
    }, (_a, _b, from, to, modifications) => {
      for (const mod of modifications ?? []) {
        try { formats.push('add' in mod ? {from, to, add: toMarks([mod.add])} : {from, to, remove: markName(mod.remove)}); }
        catch { structural = true; }
      }
    });
    this.change(tr.annotation(Transaction.userEvent) ?? 'Edit prose', d => {
      if (structural) {
        A.updateSpans(d, PATH, next.spans, expand);
      } else {
        // Wordgard ranges use the original document. Apply in reverse order.
        for (const range of [...replacements].reverse()) {
          const text = range.inserted.map(t => t.tokenType === Token.Type.Node ? t.isText ? String(t.param) : '\n' : '').join('');
          const from = original.map.wgToAm[range.from], to = original.map.wgToAm[range.to];
          A.splice(d, PATH, from, to - from, text);
        }
        for (const range of replacements) {
          let pos = next.map.wgToAm[range.fromB];
          for (const token of range.inserted) {
            if (token.tokenType !== Token.Type.Node) continue;
            const length = token.isText ? String(token.param).length : 1;
            const desired = toMarks(token.marks);
            for (const name of ['strong', 'em', 'code', 'strike', 'link']) {
              const range = {start: pos, end: pos + length, expand: name === 'link' || name === 'code' ? 'none' as const : 'both' as const};
              if (desired[name] !== undefined) A.mark(d, PATH, range, name, desired[name]);
              else if (A.marks(d, PATH).some(m => m.name === name && m.start < pos + length && m.end > pos)) A.unmark(d, PATH, range, name);
            }
            pos += length;
          }
        }
        for (const format of formats) {
          const start = next.map.wgToAm[format.from], end = next.map.wgToAm[format.to];
          if (end <= start) continue;
          if (format.remove) A.unmark(d, PATH, {start, end, expand: 'both'}, format.remove);
          if (format.add) for (const [name, value] of Object.entries(format.add)) A.mark(d, PATH, {start, end, expand: name === 'link' ? 'none' : 'both'}, name, value);
        }
      }
      if (!decode(A.spans(d, PATH)).eq(tr.newDoc)) throw Error('Editor operation did not reproduce its native rich-text projection');
    });
  }
}

// Real Automerge sync messages between separate documents, with an explicit
// offline switch. This transport is local to the demo, not an auth server.
export class LocalLink {
  paused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  onStatus: () => void = () => {};
  readonly left: Replica;
  readonly right: Replica;
  constructor(left: Replica, right: Replica) {
    this.left = left; this.right = right;
    left.sendChanges = right.sendChanges = () => this.schedule();
    left.sendPresence = value => { if (!this.paused) right.receivePresence(value); };
    right.sendPresence = value => { if (!this.paused) left.receivePresence(value); };
  }
  schedule() { if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 35); }
  flush() {
    if (this.paused) { this.onStatus(); return; }
    for (let i = 0; i < 50; i++) {
      const a = this.left.nextMessage(); if (a) this.right.receive(a);
      const b = this.right.nextMessage(); if (b) this.left.receive(b);
      if (!a && !b) { this.onStatus(); return; }
    }
    throw Error('Sync did not quiesce');
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) { this.left.receivePresence(null); this.right.receivePresence(null); }
    else { this.flush(); this.left.receivePresence(this.right.localPresence); this.right.receivePresence(this.left.localPresence); }
    this.onStatus();
  }
  destroy() { clearTimeout(this.timer); this.left.sendChanges = this.right.sendChanges = () => {}; }
}
