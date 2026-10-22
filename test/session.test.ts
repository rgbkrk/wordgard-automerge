import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '@automerge/automerge';
import {DemoSession, EditorSession} from '../src/session.ts';
import {createDocument, PATH} from '../src/model.ts';
import {Replica} from '../src/replica.ts';

function storage() {
  const values = new Map<string, string>();
  return {values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }};
}
test('UI projections seed synchronously and preserve identity across unrelated changes', () => {
  const session = new DemoSession({storage: storage(), documentId: 'seed'});
  try {
    session.toggleConnection();
    const snapshot = session.connection.getSnapshot();
    const connections: unknown[] = [], saves: string[] = [];
    const a = session.connection.state$.subscribe(value => connections.push(value));
    const b = session.saveState.state$.subscribe(value => saves.push(value));
    assert.deepEqual(connections, [{paused: true, label: 'Working independently'}]);
    assert.deepEqual(saves, ['Saved on this device']);
    session.left.change('Type', d => A.splice(d, PATH, 1, 0, 'Hello '));
    assert.equal(session.connection.getSnapshot(), snapshot);
    assert.equal(connections.length, 1); assert.equal(saves.length, 1);
    assert.equal(session.leftDocument.getSnapshot(), session.left.doc);
    a.unsubscribe(); b.unsubscribe();
  } finally { session.dispose(); }
});
test('editor change streams preserve order, share one source, and detach without replay', () => {
  const replica = new Replica('Writer', createDocument()), editor = new EditorSession(replica);
  const seen: string[] = [], duplicate: string[] = [];
  const a = editor.changes$.subscribe(change => seen.push(change.after.body));
  const b = editor.changes$.subscribe(change => duplicate.push(change.after.body));
  assert.equal(replica.listeners.size, 1);
  replica.change('First', d => A.splice(d, PATH, 1, 0, 'A'));
  replica.change('Second', d => A.splice(d, PATH, 2, 0, 'B'));
  assert.equal(seen.length, 2); assert.deepEqual(seen, duplicate);
  assert.ok(seen[0].startsWith('\ufffcAA')); assert.ok(seen[1].startsWith('\ufffcABA'));
  a.unsubscribe(); b.unsubscribe(); assert.equal(replica.listeners.size, 0);
  const late: unknown[] = [], c = editor.changes$.subscribe(change => late.push(change));
  assert.deepEqual(late, []); c.unsubscribe();
  const p = editor.presence$.subscribe(); assert.equal(replica.presenceListeners.size, 1);
  p.unsubscribe(); assert.equal(replica.presenceListeners.size, 0);
});
test('a snapshot read between React subscriptions sees current state', () => {
  const session = new DemoSession({storage: storage(), documentId: 'resubscribe'});
  try {
    const unsubscribe = session.connection.subscribe(() => {});
    unsubscribe(); session.toggleConnection();
    assert.equal(session.connection.getSnapshot().paused, true);
    session.toggleConnection(); assert.equal(session.connection.getSnapshot().paused, false);
  } finally { session.dispose(); }
});
test('both independent replicas persist and can reconnect after a session restart', () => {
  const saved = storage(), session = new DemoSession({storage: saved, documentId: 'restart'});
  session.toggleConnection();
  session.left.change('Left', d => A.splice(d, PATH, 1, 0, 'LEFT '));
  session.right.change('Right', d => A.splice(d, PATH, 1, 0, 'RIGHT '));
  session.dispose();
  const restored = new DemoSession({storage: saved, documentId: 'restart'});
  try {
    assert.ok(restored.left.doc.body.includes('LEFT ')); assert.ok(restored.left.doc.body.includes('RIGHT '));
    assert.deepEqual(A.getHeads(restored.left.doc), A.getHeads(restored.right.doc));
  } finally { restored.dispose(); }
});
test('disposal removes source listeners and completes UI state without accepting commands', () => {
  const session = new DemoSession({storage: storage(), documentId: 'dispose'});
  let completed = false;
  session.activity.state$.subscribe({complete: () => {completed = true;}});
  session.dispose(); session.dispose();
  assert.equal(session.left.listeners.size, 0); assert.equal(session.right.listeners.size, 0);
  assert.equal(completed, true);
  const before = A.getHeads(session.left.doc);
  session.agentEdit(); session.toggleConnection();
  assert.deepEqual(A.getHeads(session.left.doc), before);
});
