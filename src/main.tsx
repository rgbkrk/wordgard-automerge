import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import * as A from '@automerge/automerge';
import {PATH} from './model.ts';
import {DemoSession} from './session.ts';
import {App} from './react/app.tsx';
import type {NativeEditor} from './editor.ts';
import type {ViewListener} from './react/wordgard-editor.tsx';
import './style.css';

// Construct once at the app boundary, outside React's Strict Mode lifecycle.
const session = new DemoSession({storage: {getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value)}, documentId: new URL(location.href).searchParams.get('document') ?? 'first'});
const root = createRoot(document.querySelector('#app')!);
const views: (NativeEditor | null)[] = [null, null];
const onView: ViewListener = (pane, view) => { views[pane] = view; };
const render = (showEditors = true) => root.render(<StrictMode><App session={session} showEditors={showEditors} onView={onView}/></StrictMode>);
render();
const persist = () => session.persist();
window.addEventListener('pagehide', persist);
// A cached page can return from pagehide; do not destroy its live editors.
// HMR, unlike pagehide, really replaces this app owner.
if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener('pagehide', persist); root.unmount(); session.dispose();
});
Object.assign(window, {nativeProse: {left: session.left, right: session.right, link: session.link, views, session, A, PATH, renderEditors: render}});
