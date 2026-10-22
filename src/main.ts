import * as A from '@automerge/automerge';
import {createDocument, PATH, type Document} from './model.ts';
import {Replica, LocalLink} from './replica.ts';
import {NativeEditor} from './editor.ts';
import './style.css';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="app-header"><a class="brand" href="/" aria-label="nteract native prose"><span class="brand-symbol">n</span>nteract<span class="slash">/</span><span class="brand-surface">Native prose</span></a><span class="experiment-label">EDITOR EXPLORATION</span></header>
  <main><section class="intro"><div><div class="eyebrow">A DOCUMENT, SHARED</div><h1>Think together. Write naturally.</h1><p>Two views of one living document. Real text, formatting, and passage comments—shared as you work.</p></div><div class="connection"><span class="connection-dot"></span><span id="sync-status" role="status">Connected</span></div></section>
  <nav class="workspace-actions" aria-label="Collaboration demo"><div class="view-switch"><button class="active" id="both-views" aria-pressed="true">Side by side</button><button id="single-view" aria-pressed="false">Focus view</button></div><div class="actions"><button id="pause">Pause connection</button><button id="agent">Try an agent edit</button><button id="inspect" aria-expanded="false">Inspect document</button></div></nav>
  <div id="storage-error" class="storage-error" role="alert" hidden></div>
  <div class="editors"><section class="editor-pane" id="left" aria-label="Your editing view"></section><section class="editor-pane peer-pane" id="right" aria-label="Collaborator editing view"></section></div>
  <aside class="inspector" hidden><div><h2>The document underneath</h2><span>Native Automerge spans · no Markdown round trip</span></div><pre id="spans"></pre></aside>
  <footer class="workspace-footer"><p><span class="footer-dot"></span><span id="activity" role="status">Select words to format or comment. Try typing three backticks, then Enter.</span></p><button id="new-demo">New demo</button></footer>
  <p class="scope-note">Local prototype · two independent replicas · saved in this browser · demo identities</p></main>`;

const documentId = new URL(location.href).searchParams.get('document') ?? 'first';
const storageKey = `nteract-wordgard-native-v1:${documentId}`;
function toBase64(bytes: Uint8Array) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function fromBase64(text: string) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
const seed = createDocument();
let initialLeft = seed, initialRight = seed, corruptStorage = false;
try {
  const saved = localStorage.getItem(storageKey);
  if (saved) { const value = JSON.parse(saved); initialLeft = A.load<Document>(fromBase64(value.left)); initialRight = A.load<Document>(fromBase64(value.right)); }
} catch {
  corruptStorage = true;
  const error = document.querySelector<HTMLElement>('#storage-error')!;
  error.hidden = false; error.textContent = 'This saved demo could not be opened. Its stored data has been kept. Choose New demo to start a separate document.';
}
const left = new Replica('You', initialLeft), right = new Replica('Collaborator', initialRight);
const views = [new NativeEditor(document.querySelector('#left')!, left), new NativeEditor(document.querySelector('#right')!, right)];
const link = new LocalLink(left, right);
let persistenceFailed = false;
function persist() {
  if (corruptStorage) {
    document.querySelectorAll('.save-state').forEach(e => e.textContent = 'Not saved — start a new demo');
    return;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify({left: toBase64(A.save(left.doc)), right: toBase64(A.save(right.doc))}));
    persistenceFailed = false;
  } catch { persistenceFailed = true; }
  document.querySelectorAll('.save-state').forEach(e => e.textContent = persistenceFailed ? 'Not saved — browser storage unavailable' : 'Saved on this device');
}
function refresh() {
  const equal = A.getHeads(left.doc).sort().join() === A.getHeads(right.doc).sort().join();
  document.querySelector('#sync-status')!.textContent = link.paused ? 'Working independently' : equal ? 'All changes shared' : 'Sharing changes…';
  document.querySelector('.connection')!.classList.toggle('paused', link.paused);
  document.querySelector('#spans')!.textContent = JSON.stringify({body: A.spans(left.doc, PATH), comments: left.doc.comments}, null, 2);
}
link.onStatus = refresh;
for (const replica of [left, right]) replica.observe(change => {
  persist(); refresh();
  if (change.patches.some(p => p.path[0] === 'body')) document.querySelector('#activity')!.textContent = change.remote ? `${replica.name === 'You' ? 'Your view' : 'Collaborator view'} received an edit. Local undo stays local.` : `${replica.name} edited the document.`;
});
for (const view of views) view.onChange = refresh;
document.querySelector('#pause')!.addEventListener('click', event => {
  link.setPaused(!link.paused);
  (event.currentTarget as HTMLElement).textContent = link.paused ? 'Reconnect views' : 'Pause connection';
  document.querySelector('#activity')!.textContent = link.paused ? 'Both views can keep editing. Reconnect to merge their changes.' : 'The independent changes have been merged.';
});
document.querySelector('#inspect')!.addEventListener('click', event => {
  const inspector = document.querySelector<HTMLElement>('.inspector')!; inspector.hidden = !inspector.hidden;
  (event.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!inspector.hidden));
});
function focusView(single: boolean) {
  document.querySelector('.editors')!.classList.toggle('single', single);
  for (const [id, active] of [['single-view', single], ['both-views', !single]] as const) { const b = document.getElementById(id)!; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }
}
document.querySelector('#single-view')!.addEventListener('click', () => focusView(true));
document.querySelector('#both-views')!.addEventListener('click', () => focusView(false));
document.querySelector('#new-demo')!.addEventListener('click', () => { const url = new URL(location.href); url.searchParams.set('document', crypto.randomUUID()); location.assign(url); });
document.querySelector('#agent')!.addEventListener('click', () => {
  const old = left.doc.body.includes('best ideas') ? 'best ideas' : 'strongest ideas';
  const at = left.doc.body.indexOf(old);
  if (at < 0) { document.querySelector('#activity')!.textContent = 'The sample passage has changed. This example edit leaves your writing intact.'; return; }
  const agent = A.clone(left.doc);
  const updated = A.change(agent, 'Example agent: targeted passage replacement', d => A.splice(d, PATH, at, old.length, old === 'best ideas' ? 'strongest ideas' : 'best ideas'));
  left.applyChanges(A.getChanges(agent, updated));
  document.querySelector('#activity')!.textContent = 'Example agent edit applied to one passage. The surrounding document stays intact.';
});
link.flush(); persist(); refresh();
window.addEventListener('pagehide', () => { persist(); views.forEach(v => v.destroy()); link.destroy(); });

// Local development/test harness only; this is not a hosted mutation API.
Object.assign(window, {nativeProse: {left, right, link, views, A, PATH}});
