import {useState} from 'react';
import * as A from '@automerge/automerge';
import {PATH} from '../model.ts';
import type {DemoSession} from '../session.ts';
import {SessionContext, useActivity, useConnection, useLeftDocument, useSession, useStorageError} from './session-hooks.ts';
import {WordgardEditor, type ViewListener} from './wordgard-editor.tsx';

function Connection() {
  const {paused, label} = useConnection();
  return <div className={`connection${paused ? ' paused' : ''}`}><span className="connection-dot"/><span id="sync-status" role="status">{label}</span></div>;
}
function PauseButton() {
  const session = useSession(), {paused} = useConnection();
  return <button id="pause" onClick={() => session.toggleConnection()}>{paused ? 'Reconnect views' : 'Pause connection'}</button>;
}
function StorageError() {
  const message = useStorageError();
  return <div id="storage-error" className="storage-error" role="alert" hidden={!message}>{message}</div>;
}
function Inspector() {
  const doc = useLeftDocument();
  return <aside className="inspector"><div><h2>The document underneath</h2><span>Native Automerge spans · no Markdown round trip</span></div><pre id="spans">{JSON.stringify({body: A.spans(doc, PATH), comments: doc.comments}, null, 2)}</pre></aside>;
}
function Activity() { return <span id="activity" role="status">{useActivity()}</span>; }
function Workspace({showEditors, onView}: {showEditors: boolean; onView?: ViewListener}) {
  const session = useSession();
  const [single, setSingle] = useState(false), [inspect, setInspect] = useState(false);
  return <>
    <header className="app-header"><a className="brand" href="/" aria-label="nteract native prose"><span className="brand-symbol">n</span>nteract<span className="slash">/</span><span className="brand-surface">Native prose</span></a><span className="experiment-label">REACT + RXJS EXPLORATION</span></header>
    <main>
      <section className="intro"><div><div className="eyebrow">A DOCUMENT, SHARED</div><h1>Think together. Write naturally.</h1><p>Two views of one living document. Real text, formatting, and passage comments—shared as you work.</p></div><Connection/></section>
      <nav className="workspace-actions" aria-label="Collaboration demo"><div className="view-switch"><button className={!single ? 'active' : ''} id="both-views" aria-pressed={!single} onClick={() => setSingle(false)}>Side by side</button><button className={single ? 'active' : ''} id="single-view" aria-pressed={single} onClick={() => setSingle(true)}>Focus view</button></div><div className="actions"><PauseButton/><button id="agent" onClick={() => session.agentEdit()}>Try an agent edit</button><button id="inspect" aria-expanded={inspect} onClick={() => setInspect(!inspect)}>Inspect document</button></div></nav>
      <StorageError/>
      <div className={`editors${single ? ' single' : ''}`}>{showEditors && <><WordgardEditor session={session.editors[0]} pane={0} onView={onView}/><WordgardEditor session={session.editors[1]} pane={1} onView={onView}/></>}</div>
      {inspect && <Inspector/>}
      <footer className="workspace-footer"><p><span className="footer-dot"/><Activity/></p><button id="new-demo" onClick={() => {const url = new URL(location.href); url.searchParams.set('document', crypto.randomUUID()); location.assign(url);}}>New demo</button></footer>
      <p className="scope-note">Local prototype · two independent replicas · saved in this browser · demo identities</p>
    </main>
  </>;
}
export function App({session, showEditors = true, onView}: {session: DemoSession; showEditors?: boolean; onView?: ViewListener}) {
  return <SessionContext.Provider value={session}><Workspace showEditors={showEditors} onView={onView}/></SessionContext.Provider>;
}
