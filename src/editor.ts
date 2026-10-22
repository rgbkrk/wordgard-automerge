import * as A from '@automerge/automerge';
import {Wordgard, Decoration, Widget, KeyBinding} from 'wordgard/editor';
import {GardState, GardSelection, Transaction} from 'wordgard/state';
import {Command, toggleMark, setTextblockType} from 'wordgard/command';
import {history, undo, redo, undoDepth, redoDepth} from 'wordgard/history';
import {blockDoc, paragraph, heading, lineBreak, strong, emphasis, code, strikethrough, codeBlock, codeBlockLanguage} from 'wordgard/schema';
import {Paragraph, Heading, Strong, Emphasis, Code, Link, CodeBlock} from 'wordgard/types';
import {PATH, decode, encode, resolveComment, safeLink} from './model.ts';
import {projectChanges} from './projection.ts';
import {Replica, type Change} from './replica.ts';
import {Subscription} from 'rxjs';
import type {EditorSession} from './session.ts';
import {mountMermaid} from './mermaid-renderer.ts';

const peerCaret = Widget.define<string>({
  render(name) { const caret = document.createElement('span'); caret.className = 'peer-caret'; const label = caret.appendChild(document.createElement('span')); label.textContent = name; caret.setAttribute('aria-hidden', 'true'); return caret; },
  inFlow: false,
});
export class NativeEditor {
  readonly replica: Replica;
  readonly root: HTMLElement;
  readonly editor: Wordgard;
  private writing = false;
  private destroyed = false;
  private readonly subscriptions = new Subscription();
  private heartbeat: ReturnType<typeof setInterval>;
  private flash: {from: string; to: string; until: number} | null = null;
  private preview: ReturnType<typeof mountMermaid> | null = null;
  private previewSource = '';
  private pendingSelection: {first: string; last: string; width: number} | null = null;
  readonly error: HTMLElement;
  constructor(root: HTMLElement, session: EditorSession) {
    const replica = session.replica;
    this.root = root; this.replica = replica;
    root.innerHTML = `
      <div class="pane-heading"><span class="avatar">${replica.name === 'You' ? 'Y' : 'C'}</span><strong></strong><span class="view-label">Independent replica</span></div>
      <div class="toolbar" role="toolbar" aria-label="Formatting">
        <select aria-label="Block style"><option value="p">Paragraph</option><option value="h1">Title</option><option value="h2">Heading</option><option value="code">Code block</option></select>
        <span class="separator"></span><button data-action="bold" aria-label="Bold" title="Bold · ⌘B"><b>B</b></button><button data-action="italic" aria-label="Italic" title="Italic · ⌘I"><i>I</i></button><button data-action="code" aria-label="Inline code" title="Inline code">&lt;/&gt;</button><button data-action="link" aria-label="Link" title="Add or open a link">↗</button>
        <span class="separator"></span><button data-action="undo" aria-label="Undo" title="Undo · ⌘Z">↶</button><button data-action="redo" aria-label="Redo" title="Redo · ⇧⌘Z">↷</button>
        <button data-action="comment" class="comment-action" aria-label="Comment on selection">Comment</button>
      </div>
      <div class="editor-error" role="alert" hidden></div><div class="editor-mount"></div>
      <div class="selection-toolbar" role="toolbar" aria-label="Selection actions" hidden><button data-action="bold" aria-label="Bold selection"><b>B</b></button><button data-action="italic" aria-label="Italic selection"><i>I</i></button><button data-action="comment">Comment</button></div>
      <form class="comment-form" hidden><label>Add a passage comment<textarea required placeholder="What would you like to discuss?" aria-label="Comment text"></textarea></label><div><button type="button" data-dismiss>Cancel</button><button type="submit" class="primary">Add comment</button></div></form>
      <form class="link-form" hidden><label>Link URL<input type="url" aria-label="Link URL" placeholder="https://…" required></label><div><a class="open-link" target="_blank" rel="noopener noreferrer" hidden>Open link ↗</a><button type="button" data-remove>Remove</button><button type="button" data-dismiss>Cancel</button><button type="submit" class="primary">Apply</button></div><p class="form-error" role="alert"></p></form>
      <section class="diagram" aria-label="Diagram preview" hidden><div class="diagram-label">DIAGRAM PREVIEW <span>Mermaid</span></div><div class="diagram-mount"></div><p class="diagram-error" role="status"></p></section>
      <div class="pane-footer"><span class="word-count"></span><span class="save-state">Saved on this device</span></div>
      <section class="comments" aria-label="Passage comments"></section>`;
    root.querySelector('.pane-heading strong')!.textContent = replica.name;
    this.error = root.querySelector('.editor-error')!;
    this.editor = Wordgard.create({
      parent: root.querySelector('.editor-mount')!, doc: decode(A.spans(replica.doc, PATH)),
      config: [
        blockDoc(), paragraph(), heading(), lineBreak(), strong(), emphasis(), code(), strikethrough(),
        GardState.schemaElement.of(Link),
        Decoration.Mark.shape<string>(Link, {element: 'a', attributes: (href): Record<string, string> => safeLink(href) ? {href, target: '_blank', rel: 'noopener noreferrer'} : {}}),
        codeBlock(), codeBlockLanguage({languages: ['JavaScript', 'Python', 'Rust', 'Mermaid', 'SQL', 'JSON']}), history(),
        KeyBinding.of({key: 'Mod-k', run: () => { this.openLink(); return true; }}),
        Wordgard.contentAttributes.of({'aria-label': `${replica.name} document`, spellcheck: 'true'}),
        Wordgard.exceptionSink.of(error => this.showError(error)),
        Wordgard.transactionListener.of(transactions => this.onTransactions(transactions)),
        Wordgard.updateListener.of(() => this.updateUI()),
        Decoration.Range.source.of(() => this.ranges()),
        Decoration.Point.source.of(() => this.points()),
      ],
    });
    this.editor.dom.classList.add('native-document');
    this.subscriptions.add(session.changes$.subscribe(change => this.receive(change)));
    this.subscriptions.add(session.presence$.subscribe(this.repaint));
    this.heartbeat = setInterval(() => {
      if (this.editor.hasFocus) this.publishSelection();
      this.repaint();
    }, 1000);
    root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      button.addEventListener('pointerdown', e => e.preventDefault());
      button.addEventListener('click', () => this.action(button.dataset.action!));
    });
    root.querySelector('select')!.addEventListener('change', e => {
      const value = (e.target as HTMLSelectElement).value;
      Command.dispatch(this.editor, setTextblockType, value === 'h1' ? Heading.of(1) : value === 'h2' ? Heading.of(2) : value === 'code' ? CodeBlock : Paragraph);
      this.editor.focus();
    });
    const commentForm = root.querySelector<HTMLFormElement>('.comment-form')!;
    commentForm.querySelector('[data-dismiss]')!.addEventListener('click', () => { commentForm.hidden = true; this.editor.focus(); });
    commentForm.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const range = this.pendingRange();
        if (!range || range.to <= range.from) throw Error('The selected passage was deleted. Select a new passage.');
        replica.comment(range.from, range.to, commentForm.querySelector('textarea')!.value);
        commentForm.reset(); commentForm.hidden = true; this.editor.focus();
      } catch (error) { this.showError(error); }
    });
    const linkForm = root.querySelector<HTMLFormElement>('.link-form')!;
    linkForm.querySelector('[data-dismiss]')!.addEventListener('click', () => { linkForm.hidden = true; this.editor.focus(); });
    linkForm.querySelector('[data-remove]')!.addEventListener('click', () => { this.applyLink(null); linkForm.hidden = true; });
    linkForm.addEventListener('submit', event => {
      event.preventDefault(); const value = linkForm.querySelector('input')!.value.trim();
      if (!safeLink(value)) { linkForm.querySelector('.form-error')!.textContent = 'Use an https, http, or mailto link.'; return; }
      this.applyLink(value); linkForm.hidden = true;
    });
    this.editor.contentDOM.addEventListener('click', e => {
      const anchor = (e.target as Element).closest('a');
      if (anchor) { e.preventDefault(); this.openLink(); }
    });
    this.editor.contentDOM.addEventListener('focusout', () => setTimeout(() => { if (!this.destroyed && !this.editor.hasFocus) replica.hidePresence(); }, 0));
    this.refreshContent(); this.updateUI();
  }
  showError(error: unknown) {
    this.error.hidden = false; this.error.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
  private onTransactions(transactions: readonly Transaction[]) {
    if (this.destroyed) return;
    this.writing = true;
    try {
      for (const tr of transactions) if (!tr.annotation(Transaction.remote)) this.replica.applyEditorTransaction(tr);
      if (transactions.some(tr => tr.docChanged && !tr.annotation(Transaction.remote))) this.error.hidden = true;
    } catch (error) {
      this.showError(error);
      // A rejected local operation must not leave an unsaved view masquerading
      // as the document. Roll back only the view; canonical content is intact.
      this.editor.dispatch({changes: projectChanges(this.editor.state.doc, decode(A.spans(this.replica.doc, PATH))), annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false), history.isolate.of(true)]});
    } finally { this.writing = false; }
    this.publishSelection();
    if (transactions.some(tr => tr.docChanged)) this.refreshContent();
  }
  private receive(change: Change) {
    if (this.writing || this.destroyed) return;
    try {
      const before = this.editor.state.doc, target = decode(A.spans(change.after, PATH));
      const changes = projectChanges(before, target);
      let selection: Transaction.Spec['selection'];
      if (!changes.empty) {
        const map = encode(before).map, next = encode(target).map, sel = this.editor.state.selection;
        const cursor = (pos: number) => A.getCursor(change.before, PATH, map.wgToAm[pos], 'after');
        const anchor = A.getCursorPosition(change.after, PATH, cursor(sel.anchor));
        const head = A.getCursorPosition(change.after, PATH, cursor(sel.head));
        selection = cx => GardSelection.range(GardSelection.near(cx, next.amToWg[anchor] ?? target.length - 1).anchor, GardSelection.near(cx, next.amToWg[head] ?? target.length - 1).head);
        let from = target.length, to = 0;
        changes.iterChangedRanges((_a, _b, a, b) => { from = Math.min(from, a); to = Math.max(to, b); });
        if (change.remote && to > from) this.flash = {from: A.getCursor(change.after, PATH, next.wgToAm[from], 'after'), to: A.getCursor(change.after, PATH, next.wgToAm[to], 'before'), until: Date.now() + 1800};
      }
      this.editor.dispatch({changes, selection, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false), history.isolate.of(true)]});
      this.refreshContent();
    } catch (error) { this.showError(error); }
  }
  private publishSelection() {
    if (!this.editor?.hasFocus) return;
    const map = encode(this.editor.state.doc).map, sel = this.editor.state.selection;
    this.replica.publish(map.wgToAm[sel.anchor], map.wgToAm[sel.head]);
  }
  private repaint = () => {
    if (!this.destroyed && !this.editor.composing) this.editor.dispatch({annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)]});
  };
  private ranges() {
    const map = encode(decode(A.spans(this.replica.doc, PATH))).map;
    const entries: [Decoration.Range, number, number][] = [];
    const add = (from: number, to: number, className: string, title: string) => {
      const a = map.amToWg[Math.min(from, to)], b = map.amToWg[Math.max(from, to)];
      if (a !== undefined && b !== undefined && b > a) entries.push([Decoration.Range.wrapper('span', {attributes: {class: className, title}}), a, b]);
    };
    const peer = this.replica.peerRange();
    if (peer) add(peer.anchor, peer.head, 'peer-selection', peer.name);
    for (const comment of Object.values(this.replica.doc.comments)) {
      const range = resolveComment(this.replica.doc, comment);
      if (range && !comment.resolved) add(range.from, range.to, 'comment-anchor', comment.body);
    }
    if (this.flash && this.flash.until > Date.now()) {
      try { add(A.getCursorPosition(this.replica.doc, PATH, this.flash.from), A.getCursorPosition(this.replica.doc, PATH, this.flash.to), 'remote-edit', 'Received collaborator edit'); } catch { /* Deleted range. */ }
    }
    entries.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    return Decoration.Range.set(entries);
  }
  private points() {
    const peer = this.replica.peerRange(); if (!peer) return Decoration.Point.none;
    const pos = encode(decode(A.spans(this.replica.doc, PATH))).map.amToWg[peer.head];
    return pos === undefined ? Decoration.Point.none : Decoration.Point.set([[Decoration.Point.widget(peerCaret.of(peer.name), {side: 1}), pos]]);
  }
  private rememberSelection() {
    const sel = this.editor.state.selection, map = encode(this.editor.state.doc).map;
    const from = map.wgToAm[sel.from], to = map.wgToAm[sel.to];
    if (to <= from) return false;
    const width = [...this.replica.doc.body.slice(from, to)].at(-1)!.length;
    this.pendingSelection = {first: A.getCursor(this.replica.doc, PATH, from, 'after'), last: A.getCursor(this.replica.doc, PATH, to - width, 'before'), width};
    return true;
  }
  private pendingRange() {
    const selected = this.pendingSelection; if (!selected) return null;
    const d = this.replica.doc;
    const from = A.getCursorPosition(d, PATH, selected.first), last = A.getCursorPosition(d, PATH, selected.last);
    if (A.getCursor(d, PATH, from, 'after') !== selected.first || A.getCursor(d, PATH, last, 'before') !== selected.last) return null;
    return {from, to: last + selected.width};
  }
  private action(action: string) {
    if (action === 'comment') {
      if (!this.rememberSelection()) return;
      const form = this.root.querySelector<HTMLFormElement>('.comment-form')!; form.hidden = false; form.querySelector('textarea')!.focus(); return;
    }
    if (action === 'link') { this.openLink(); return; }
    if (action === 'undo' || action === 'redo') Command.dispatch(this.editor, action === 'undo' ? undo : redo);
    else Command.dispatch(this.editor, toggleMark, action === 'bold' ? Strong : action === 'italic' ? Emphasis : Code);
    this.editor.focus();
  }
  private openLink() {
    const sel = this.editor.state.selection, map = encode(this.editor.state.doc).map;
    const index = map.wgToAm[sel.head];
    const existing = A.marks(this.replica.doc, PATH).find(m => m.name === 'link' && m.start <= index && m.end >= index);
    if (sel.empty && existing) this.editor.dispatch({selection: {anchor: map.amToWg[existing.start], head: map.amToWg[existing.end]}});
    if (!this.rememberSelection()) return;
    const form = this.root.querySelector<HTMLFormElement>('.link-form')!;
    form.hidden = false; form.querySelector('input')!.value = existing ? String(existing.value) : '';
    const open = form.querySelector<HTMLAnchorElement>('.open-link')!;
    open.hidden = !existing || !safeLink(String(existing.value)); if (!open.hidden) open.href = String(existing!.value);
    form.querySelector('.form-error')!.textContent = ''; form.querySelector('input')!.focus();
  }
  private applyLink(href: string | null) {
    const range = this.pendingRange(); if (!range) { this.showError('The link selection was deleted.'); return; }
    const map = encode(this.editor.state.doc).map;
    const from = map.amToWg[range.from], to = map.amToWg[range.to];
    const changes: import('wordgard/doc').ChangeSet.Change[] = [];
    this.editor.state.doc.iterate(from, to, node => { const mark = Link.isInSet(node.marks); if (mark && !changes.some(c => c.remove?.eq(mark))) changes.push({from, to, remove: mark}); });
    if (href) changes.push({from, to, add: Link.of(href)});
    this.editor.dispatch({changes}); this.editor.focus();
  }
  private updateUI() {
    if (!this.editor) return;
    const sel = this.editor.state.selection;
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="comment"]').forEach(b => b.disabled = sel.empty);
    this.root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.disabled = undoDepth(this.editor.state) === 0;
    this.root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.disabled = redoDepth(this.editor.state) === 0;
    const floating = this.root.querySelector<HTMLElement>('.selection-toolbar')!;
    floating.hidden = sel.empty || !this.editor.hasFocus || this.editor.composing;
    if (!floating.hidden) {
      const rect = this.editor.coordsAtPos(sel.head), pane = this.root.getBoundingClientRect();
      if (rect) { floating.style.left = `${Math.max(12, Math.min(rect.left - pane.left - 60, pane.width - 190))}px`; floating.style.top = `${rect.top - pane.top - 46}px`; }
    }
    const type = this.editor.state.sel.head.textblockParent?.node.type;
    const style = this.root.querySelector<HTMLSelectElement>('select')!;
    if (document.activeElement !== style) style.value = type === Heading ? Number(this.editor.state.sel.head.textblockParent?.node.tag.param) === 1 ? 'h1' : 'h2' : type === CodeBlock.type ? 'code' : 'p';
  }
  private refreshContent() {
    const spans = A.spans(this.replica.doc, PATH);
    const text = spans.filter(s => s.type === 'text').map(s => s.value).join(' ');
    this.root.querySelector('.word-count')!.textContent = `${text.trim().split(/\s+/).filter(Boolean).length} words`;
    const comments = this.root.querySelector<HTMLElement>('.comments')!; comments.replaceChildren();
    for (const comment of Object.values(this.replica.doc.comments)) {
      const range = resolveComment(this.replica.doc, comment);
      const card = comments.appendChild(document.createElement('article')); card.className = 'comment-card';
      const top = card.appendChild(document.createElement('div')); top.className = 'comment-meta';
      const author = top.appendChild(document.createElement('strong')); author.textContent = comment.author;
      const status = top.appendChild(document.createElement('span')); status.textContent = comment.resolved ? 'Resolved' : range ? 'On this passage' : 'Passage removed';
      const quote = card.appendChild(document.createElement('blockquote')); quote.textContent = comment.quote;
      const body = card.appendChild(document.createElement('p')); body.textContent = comment.body;
      const button = card.appendChild(document.createElement('button')); button.textContent = comment.resolved ? 'Reopen' : 'Resolve';
      button.onclick = () => this.replica.change('Update comment', d => { d.comments[comment.id].resolved = !comment.resolved; });
    }
    let inMermaid = false, source = '';
    for (const span of spans) {
      if (span.type === 'block') { if (inMermaid) break; const value = span.value as {type?: string; attrs?: {language?: string}}; inMermaid = value.type === 'code-block' && value.attrs?.language?.toLowerCase() === 'mermaid'; }
      else if (inMermaid) source += span.value;
    }
    const panel = this.root.querySelector<HTMLElement>('.diagram')!; panel.hidden = !source;
    if (source !== this.previewSource) {
      this.previewSource = source;
      const error = this.root.querySelector<HTMLElement>('.diagram-error')!; error.textContent = '';
      if (!source) { this.preview?.destroy(); this.preview = null; }
      else {
        const callbacks = {onRender: () => { error.textContent = ''; }, onError: (e: unknown) => { error.textContent = `Check the diagram source: ${e instanceof Error ? e.message : e}`; }};
        try {
          if (this.preview) this.preview.update(source);
          else this.preview = mountMermaid(this.root.querySelector('.diagram-mount')!, source, A.getActorId(this.replica.doc), callbacks);
        } catch (e) { callbacks.onError(e); }
      }
    }
  }
  setSaveState(value: string) { this.root.querySelector('.save-state')!.textContent = value; }
  destroy() { if (this.destroyed) return; this.destroyed = true; clearInterval(this.heartbeat); this.subscriptions.unsubscribe(); this.replica.hidePresence(); this.preview?.destroy(); this.editor.dom.remove(); }
}
