import * as A from '@automerge/automerge';
import {Schema, Leaf, Plot, Mark, type Node} from 'wordgard/doc';
import {Doc, Paragraph, Heading, CodeBlock, CodeBlockLanguage, LineBreak, Strong, Emphasis, Code, Link, Strikethrough} from 'wordgard/types';

// An explicit, deliberately small semantic schema. No Wordgard JSON is stored.
export const schema = Schema.define([Doc, Paragraph, Heading, CodeBlock, CodeBlockLanguage, LineBreak, Strong, Emphasis, Code, Link, Strikethrough]);
export const PATH = ['body'];
export interface Comment { id: string; body: string; quote: string; first: string; last: string; lastWidth: number; object: string; author: string; resolved: boolean }
export type Document = { version: number; body: string; comments: Record<string, Comment> };
export type NativeDoc = A.Doc<Document>;
export const expand = {defaultExpand: 'both' as const, perMarkExpand: {link: 'none' as const, code: 'none' as const}};
const markTypes = {strong: Strong, em: Emphasis, code: Code, strike: Strikethrough};
export function safeLink(href: string) {
  return /^(https?:\/\/|mailto:|#)/i.test(href) && !/[\u0000-\u0020\u007f]/.test(href);
}
export function fromMarks(marks: Record<string, unknown> = {}): Mark[] {
  const result: Mark[] = [];
  for (const [name, value] of Object.entries(marks)) {
    if (name in markTypes && value === true) result.push(markTypes[name as keyof typeof markTypes]);
    else if (name === 'link' && typeof value === 'string' && safeLink(value)) result.push(Link.of(value));
    else throw new Error(`Unsupported rich mark: ${name}`);
  }
  return result;
}
export function toMarks(marks: readonly Mark[]): Record<string, boolean | string> {
  const result: Record<string, boolean | string> = {};
  for (const mark of marks) {
    const name = Object.entries(markTypes).find(([, v]) => v.type === mark.type)?.[0];
    if (name) result[name] = true;
    else if (mark.type === Link && safeLink(String(mark.value))) result.link = String(mark.value);
    else throw new Error(`Unsupported editor mark: ${mark.name}`);
  }
  return result;
}
export function markName(mark: Mark) { return Object.keys(toMarks([mark]))[0]; }

export interface PositionMap { wgToAm: number[]; amToWg: number[] }
export function encode(doc: Plot.Doc): {spans: A.Span[]; map: PositionMap} {
  const spans: A.Span[] = [], wgToAm: number[] = [], amToWg: number[] = [];
  let wg = 0, am = 0;
  // Closing a Wordgard block consumes no Automerge position. The next
  // block's opening token therefore shares its native offset with the
  // preceding textblock end. Keep the first (inside-textblock) position
  // so a remote caret never becomes a widget between block elements.
  const position = () => { wgToAm[wg] = am; amToWg[am] ??= wg; };
  for (const node of doc.content) {
    if (!node.isPlot || ![Paragraph.type, Heading, CodeBlock.type].includes(node.type as never)) throw Error('Unsupported block');
    position();
    const type = node.type === Heading ? 'heading' : node.type === CodeBlock.type ? 'code-block' : 'paragraph';
    const attrs: Record<string, string | number> = {};
    if (type === 'heading') attrs.level = Number(node.tag.param);
    if (type === 'code-block') attrs.language = node.mark(CodeBlockLanguage) ?? '';
    spans.push({type: 'block', value: {type, parents: [], attrs}});
    wg++; am++; position();
    for (const child of node.content) {
      const text = child.isText ? String(child.param) : child.type === LineBreak.type ? '\n' : null;
      if (text === null) throw Error('Unsupported inline content');
      const marks = toMarks(child.marks);
      if (text.length) spans.push({type: 'text', value: text, ...(Object.keys(marks).length ? {marks} : {})});
      for (let i = 0; i < text.length; i++) { position(); wg++; am++; }
      position();
    }
    wgToAm[wg] = am; // A Wordgard closing token has no Automerge character.
    wg++;
  }
  wgToAm[wg] = am;
  if (amToWg[am] === undefined) amToWg[am] = Math.max(0, wg - 1);
  return {spans, map: {wgToAm, amToWg}};
}

export function decode(spans: A.Span[]): Plot.Doc {
  const blocks: Node[] = [];
  let tag: Plot.Tag | null = null, children: Node[] = [];
  const flush = () => { if (tag) blocks.push(tag.create(children)); children = []; };
  for (const span of spans) {
    if (span.type === 'block') {
      flush();
      const value = span.value as {type?: string; parents?: unknown[]; attrs?: Record<string, unknown>};
      if (value.parents?.length) throw Error('Nested blocks are outside this prototype schema');
      if (value.type === 'paragraph') tag = Paragraph;
      else if (value.type === 'heading') tag = Heading.of(Number(value.attrs?.level ?? 2));
      else if (value.type === 'code-block') {
        tag = CodeBlock;
        if (value.attrs?.language) tag = tag.withMarks([CodeBlockLanguage.of(String(value.attrs.language))]);
      } else throw Error(`Unsupported block type: ${value.type}`);
    } else {
      tag ??= Paragraph;
      const marks = fromMarks(span.marks);
      if (tag.type === CodeBlock.type) {
        if (span.value) children.push(Leaf.text(span.value, marks));
      } else {
        span.value.split('\n').forEach((part, i) => {
          if (i) children.push(LineBreak.withMarks(marks));
          if (part) children.push(Leaf.text(part, marks));
        });
      }
    }
  }
  flush();
  return schema.doc(blocks.length ? blocks : [Paragraph.create([])]);
}

export function createDocument(): NativeDoc {
  let doc = A.from<Document>({version: 1, body: '', comments: {}}, {actor: '00000000000000000000000000000001'});
  const seed = schema.doc([
    Heading.of(1).create([Leaf.text('A shared place to think')]),
    Paragraph.create([Leaf.text('A document for '), Leaf.text('people and agents', [Strong]), Leaf.text(' to shape together. Select a passage, leave a comment, or start writing.')]),
    Heading.of(2).create([Leaf.text('Make room for an idea')]),
    Paragraph.create([Leaf.text('The best ideas get better when we can work on them together. Every edit here belongs to the document, wherever it begins.')]),
    Paragraph.create([Leaf.text('Try editing in either view. Pause the connection to work independently, then reconnect and watch the changes come together.')]),
    CodeBlock.withMarks([CodeBlockLanguage.of('mermaid')]).create([Leaf.text('graph LR\n  Idea --> Conversation\n  Conversation --> SharedDocument')]),
    Paragraph.create([Leaf.text('Keep going from here…')]),
  ]);
  return A.change(doc, 'Create document', d => A.updateSpans(d, PATH, encode(seed).spans, expand));
}

export function resolveComment(doc: NativeDoc, comment: Comment): {from: number; to: number} | null {
  if (A.getObjectId(doc, 'body') !== comment.object) return null;
  try {
    const from = A.getCursorPosition(doc, PATH, comment.first);
    const last = A.getCursorPosition(doc, PATH, comment.last);
    // A deleted anchor resolves to a neighbour; check the exact cursor identity.
    if (A.getCursor(doc, PATH, from, 'after') !== comment.first || A.getCursor(doc, PATH, last, 'before') !== comment.last || last < from) return null;
    return {from, to: last + comment.lastWidth};
  } catch { return null; }
}
