import * as A from '@automerge/automerge';
import {BehaviorSubject, Observable, Subscription, distinctUntilChanged, map, share} from 'rxjs';
import {createDocument, PATH, type Document, type NativeDoc} from './model.ts';
import {LocalLink, Replica, type Change} from './replica.ts';

/** Ordered events are not replayed or debounced. Mounting reads the current
 * replica; after that the editor receives every change through this edge. */
export class EditorSession {
  readonly replica: Replica;
  readonly changes$: Observable<Change>;
  readonly presence$: Observable<void>;
  constructor(replica: Replica) {
    this.replica = replica;
    this.changes$ = new Observable<Change>(subscriber => replica.observe(change => subscriber.next(change))).pipe(share());
    this.presence$ = new Observable<void>(subscriber => {
      const notify = () => subscriber.next();
      replica.presenceListeners.add(notify);
      return () => { replica.presenceListeners.delete(notify); };
    }).pipe(share());
  }
}

export interface Projection<T> {
  readonly state$: Observable<T>;
  getSnapshot(): T;
  subscribe(notify: () => void): () => void;
}
function project<S, T>(source: BehaviorSubject<S>, select: (s: S) => T, equals: (a: T, b: T) => boolean = Object.is): Projection<T> {
  const state$ = source.pipe(map(select), distinctUntilChanged(equals));
  let snapshot = select(source.value);
  return {
    state$,
    getSnapshot: () => {
      const next = select(source.value);
      if (!equals(snapshot, next)) snapshot = next;
      return snapshot;
    },
    subscribe: notify => { const sub = state$.subscribe(() => notify()); return () => sub.unsubscribe(); },
  };
}

interface SessionState {
  readonly paused: boolean;
  readonly syncStatus: string;
  readonly saveState: string;
  readonly storageError: string | null;
  readonly activity: string;
  // Immutable Automerge handles, not a second mutable document model.
  readonly leftDoc: NativeDoc;
  readonly rightDoc: NativeDoc;
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export interface SessionOptions { storage: Storage; documentId: string }
const initialActivity = 'Select words to format or comment. Try typing three backticks, then Enter.';
function toBase64(bytes: Uint8Array) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function fromBase64(text: string) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }

/** App-owned lifetime. React owns editor views, never this session or its link. */
export class DemoSession {
  readonly left: Replica;
  readonly right: Replica;
  readonly editors: readonly [EditorSession, EditorSession];
  readonly link: LocalLink;
  private readonly state: BehaviorSubject<SessionState>;
  private readonly subscriptions = new Subscription();
  private readonly storage: Storage;
  private readonly storageKey: string;
  private readonly corruptStorage: boolean;
  private disposed = false;
  readonly connection: Projection<{paused: boolean; label: string}>;
  readonly saveState: Projection<string>;
  readonly storageError: Projection<string | null>;
  readonly activity: Projection<string>;
  readonly leftDocument: Projection<NativeDoc>;

  constructor(options: SessionOptions) {
    this.storage = options.storage;
    this.storageKey = `nteract-wordgard-native-v1:${options.documentId}`;
    const seed = createDocument();
    let initialLeft = seed, initialRight = seed, corrupt = false;
    try {
      const saved = this.storage.getItem(this.storageKey);
      if (saved) {
        const value = JSON.parse(saved);
        initialLeft = A.load<Document>(fromBase64(value.left));
        initialRight = A.load<Document>(fromBase64(value.right));
      }
    } catch { corrupt = true; }
    this.corruptStorage = corrupt;
    this.left = new Replica('You', initialLeft); this.right = new Replica('Collaborator', initialRight);
    this.editors = [new EditorSession(this.left), new EditorSession(this.right)];
    this.link = new LocalLink(this.left, this.right);
    this.state = new BehaviorSubject<SessionState>({paused: false, syncStatus: 'Connected', saveState: 'Saving…', storageError: corrupt ? 'This saved demo could not be opened. Its stored data has been kept. Choose New demo to start a separate document.' : null, activity: initialActivity, leftDoc: this.left.doc, rightDoc: this.right.doc});
    this.connection = project(this.state, s => ({paused: s.paused, label: s.syncStatus}), connectionEquals);
    this.saveState = project(this.state, s => s.saveState);
    this.storageError = project(this.state, s => s.storageError);
    this.activity = project(this.state, s => s.activity);
    this.leftDocument = project(this.state, s => s.leftDoc);
    this.link.onStatus = () => this.refresh();
    for (const editor of this.editors) this.subscriptions.add(editor.changes$.subscribe(change => {
      this.persist();
      const activity = change.patches.some(p => p.path[0] === 'body')
        ? change.remote ? `${editor.replica.name === 'You' ? 'Your view' : 'Collaborator view'} received an edit. Local undo stays local.` : `${editor.replica.name} edited the document.`
        : this.state.value.activity;
      this.refresh(activity);
    }));
    this.link.flush(); this.persist(); this.refresh();
  }
  private update(patch: Partial<SessionState>) { if (!this.disposed) this.state.next({...this.state.value, ...patch}); }
  private refresh(activity = this.state.value.activity) {
    const equal = A.getHeads(this.left.doc).sort().join() === A.getHeads(this.right.doc).sort().join();
    this.update({paused: this.link.paused, syncStatus: this.link.paused ? 'Working independently' : equal ? 'All changes shared' : 'Sharing changes…', activity, leftDoc: this.left.doc, rightDoc: this.right.doc});
  }
  persist() {
    if (this.disposed) return;
    if (this.corruptStorage) { this.update({saveState: 'Not saved — start a new demo'}); return; }
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({left: toBase64(A.save(this.left.doc)), right: toBase64(A.save(this.right.doc))}));
      this.update({saveState: 'Saved on this device'});
    } catch { this.update({saveState: 'Not saved — browser storage unavailable'}); }
  }
  toggleConnection() {
    if (this.disposed) return;
    this.link.setPaused(!this.link.paused);
    this.refresh(this.link.paused ? 'Both views can keep editing. Reconnect to merge their changes.' : 'The independent changes have been merged.');
  }
  agentEdit() {
    if (this.disposed) return;
    const old = this.left.doc.body.includes('best ideas') ? 'best ideas' : 'strongest ideas';
    const at = this.left.doc.body.indexOf(old);
    if (at < 0) { this.update({activity: 'The sample passage has changed. This example edit leaves your writing intact.'}); return; }
    const agent = A.clone(this.left.doc);
    const updated = A.change(agent, 'Example agent: targeted passage replacement', d => A.splice(d, PATH, at, old.length, old === 'best ideas' ? 'strongest ideas' : 'best ideas'));
    this.left.applyChanges(A.getChanges(agent, updated));
    this.update({activity: 'Example agent edit applied to one passage. The surrounding document stays intact.'});
  }
  dispose() {
    if (this.disposed) return;
    this.persist(); this.disposed = true;
    this.subscriptions.unsubscribe(); this.link.destroy(); this.link.onStatus = () => {};
    this.left.sendPresence = this.right.sendPresence = () => {};
    this.left.receivePresence(null); this.right.receivePresence(null);
    this.state.complete();
  }
}
function connectionEquals(a: {paused: boolean; label: string}, b: {paused: boolean; label: string}) {
  return a.paused === b.paused && a.label === b.label;
}
