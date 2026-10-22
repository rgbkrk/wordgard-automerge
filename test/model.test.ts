import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '@automerge/automerge';
import {GardState} from 'wordgard/state';
import {Leaf, Plot} from 'wordgard/doc';
import {Paragraph, Heading, Strong, Emphasis, CodeBlock, CodeBlockLanguage} from 'wordgard/types';
import {schema, PATH, encode, decode, createDocument, resolveComment} from '../src/model.ts';
import {projectChanges} from '../src/projection.ts';
import {Replica, LocalLink} from '../src/replica.ts';

function state(replica: Replica) { return GardState.create({doc: decode(A.spans(replica.doc, PATH)), config: schema.elements.map(e => GardState.schemaElement.of(e))}); }
function doc(text: string) { return schema.doc([Paragraph.create([Leaf.text(text)])]); }
function replica(text = 'hello 🌊 world') {
  const r = new Replica('Writer', createDocument());
  r.change('Fixture', d => A.updateSpans(d, PATH, encode(doc(text)).spans));
  return r;
}

test('native spans preserve nested marks, Unicode, headings and code language', () => {
  const tree = schema.doc([Heading.of(2).create([Leaf.text('Hi 🌊', [Strong, Emphasis])]), CodeBlock.withMarks([CodeBlockLanguage.of('mermaid')]).create([Leaf.text('graph LR\n A --> B')])]);
  assert.ok(decode(encode(tree).spans).eq(tree));
  const map = encode(tree).map;
  for (let i = 1; i < 6; i++) assert.equal(map.amToWg[map.wgToAm[i]], i);
});
test('incoming mark-only projection preserves text positions', () => {
  const old = doc('hello 🌊 world'), next = schema.doc([Paragraph.create([Leaf.text('hello 🌊', [Strong]), Leaf.text(' world')])]);
  const change = projectChanges(old, next);
  assert.ok(change.apply(old).eq(next));
  assert.equal(change.mapPos(8), 8);
  let replacements = 0; change.iterChanges(() => replacements++);
  assert.equal(replacements, 0);
});
test('native block boundaries resolve to the preceding textblock end', () => {
  const tree = schema.doc([Paragraph.create([Leaf.text('first')]), Paragraph.create([]), Heading.of(2).create([Leaf.text('last')])]);
  const {map} = encode(tree);
  let start = 0;
  for (const block of tree.content) {
    const end = start + block.length - 1;
    assert.equal(map.amToWg[map.wgToAm[end]], end, 'A caret at a paragraph end must stay inside that paragraph');
    start += block.length;
  }
});
test('multiple disjoint remote edits preserve an untouched middle', () => {
  const old = doc('one 🌊 two three'), next = doc('ONE 🌊 two THREE');
  const change = projectChanges(old, next);
  assert.ok(change.apply(old).eq(next)); assert.equal(change.mapPos(8), 8);
});
test('local text and mark operations retain the native text object and anchors', () => {
  const r = replica(); const object = A.getObjectId(r.doc, 'body'); const anchor = A.getCursor(r.doc, PATH, 7);
  let s = state(r), tr = s.update({changes: {from: 1, insert: [Leaf.text('New ')]}});
  r.applyEditorTransaction(tr);
  s = state(r); tr = s.update({changes: {from: 5, to: 10, add: Strong}}); r.applyEditorTransaction(tr);
  assert.equal(A.getObjectId(r.doc, 'body'), object);
  assert.equal(A.getCursorPosition(r.doc, PATH, anchor), 11);
  assert.equal(A.marksAt(r.doc, PATH, 5).strong, true);
});
test('offline independent formatting and typing converge using sync messages', () => {
  const left = replica('one two three'), right = new Replica('Peer', left.doc), link = new LocalLink(left, right);
  link.flush(); link.setPaused(true);
  left.applyEditorTransaction(state(left).update({changes: {from: 1, to: 8, add: Strong}}));
  right.applyEditorTransaction(state(right).update({changes: [{from: 5, to: 14, add: Emphasis}, {from: 14, insert: [Leaf.text('!')]}]}));
  link.setPaused(false);
  assert.deepEqual(A.spans(left.doc, PATH), A.spans(right.doc, PATH));
  assert.deepEqual(A.marksAt(left.doc, PATH, 5), {em: true, strong: true});
  assert.ok(left.doc.body.endsWith('!')); link.destroy();
});
test('structural split updates native block markers and preserves surviving text', () => {
  const r = replica('hello world'), cursor = A.getCursor(r.doc, PATH, 8);
  const target = schema.doc([Paragraph.create([Leaf.text('hello')]), Paragraph.create([Leaf.text(' world')])]);
  const s = state(r); r.applyEditorTransaction(s.update({changes: projectChanges(s.doc, target)}));
  assert.equal(A.spans(r.doc, PATH).filter(s => s.type === 'block').length, 2);
  assert.equal(r.doc.body[A.getCursorPosition(r.doc, PATH, cursor)], 'o');
});
test('comments follow prefixes and detach on deleted anchors rather than matching duplicate quotes', () => {
  const r = replica('hello hello'); const id = r.comment(1, 6, 'Discuss first');
  r.change('Prefix', d => A.splice(d, PATH, 1, 0, 'New '));
  assert.deepEqual(resolveComment(r.doc, r.doc.comments[id]), {from: 5, to: 10});
  r.change('Delete original', d => A.splice(d, PATH, 5, 5, ''));
  assert.equal(resolveComment(r.doc, r.doc.comments[id]), null);
});
test('presence waits for causal heads before resolving', () => {
  const left = replica(), right = new Replica('Peer', left.doc);
  left.change('Unseen edit', d => A.splice(d, PATH, 1, 0, 'X'));
  left.publish(2, 5); right.receivePresence(left.localPresence); assert.equal(right.peerRange(), null);
  const link = new LocalLink(left, right); link.flush(); assert.ok(right.peerRange()); link.destroy();
});
test('typing presence retains the last valid cursor until its new heads arrive', () => {
  const left = replica('hello'), right = new Replica('Peer', left.doc);
  left.publish(3, 3); right.receivePresence(left.localPresence);
  const previous = right.peerRange();
  left.change('Type ahead of sync', d => A.splice(d, PATH, 3, 0, 'X'));
  left.publish(4, 4); right.receivePresence(left.localPresence);
  assert.deepEqual(right.peerRange(), previous, 'Keep the visible cursor while the new cursor is causally pending');
  const link = new LocalLink(left, right); link.flush();
  assert.deepEqual(right.peerRange(), {anchor: 4, head: 4, name: 'Writer'});
  link.destroy();
});
test('pending presence never revives a departed, expired, or different peer', t => {
  const left = replica('hello'), right = new Replica('Peer', left.doc);
  left.publish(3, 3); const known = left.localPresence!;
  left.change('Pending edit', d => A.splice(d, PATH, 3, 0, 'X'));
  left.publish(4, 4); const pending = left.localPresence!;
  const prime = () => {right.receivePresence(known); right.receivePresence(pending); assert.ok(right.peerRange());};
  prime(); right.receivePresence(null); assert.equal(right.peerRange(), null);
  prime(); right.receivePresence({...pending, session: 'another-session'}); assert.equal(right.peerRange(), null);
  prime(); right.receivePresence({...pending, object: 'another-text-object'}); assert.equal(right.peerRange(), null);
  prime(); t.mock.method(Date, 'now', () => pending.at + 30001); assert.equal(right.peerRange(), null);
});
