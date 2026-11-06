import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  MariaSQL,
  MySQL,
  PostgreSQL,
  SQLite,
  sql,
  type SQLDialect,
  type SQLNamespace,
} from '@codemirror/lang-sql'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

/** Colors from the theme's tokens, so the editor follows light and dark with the rest. */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: '#2e9e62' },
  { tag: [tags.number, tags.bool, tags.null], color: '#d9822b' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--text-faint)',
    fontStyle: 'italic',
  },
  { tag: [tags.typeName, tags.standard(tags.name)], color: '#9b51e0' },
  { tag: tags.operator, color: 'var(--text-dim)' },
])

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--text)', padding: '6px 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-chrome)',
    color: 'var(--text-faint)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-tooltip': { backgroundColor: 'var(--bg)', border: '1px solid var(--border)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-text)',
  },
})

interface Props {
  value: string
  onChange(value: string): void
  /** ⌘↵ runs the statement at the cursor, ⇧⌘↵ them all. */
  onRun(mode: 'current' | 'all', text: string, cursor: number): void
  /** Tables (and their columns, where known) for completion. */
  schema: SQLNamespace
  /** Where unqualified names are looked up, such as `public`. */
  defaultSchema: string
  /** The database's kind, for its dialect: keywords, quoting, comments. */
  kind: string
  label: string
}

const DIALECTS: Record<string, SQLDialect> = {
  postgres: PostgreSQL,
  mysql: MySQL,
  mariadb: MariaSQL,
  sqlite: SQLite,
}

/** The SQL editor: CodeMirror 6, in the database's dialect, completion from the schema. */
export function Editor({ value, onChange, onRun, schema, defaultSchema, kind, label }: Props) {
  const dialect = DIALECTS[kind] ?? PostgreSQL
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const language = useRef(new Compartment())
  // The latest callbacks, for key bindings made once.
  const callbacks = useRef({ onChange, onRun })
  useEffect(() => {
    callbacks.current = { onChange, onRun }
  })

  useEffect(() => {
    const run = (mode: 'current' | 'all') => (v: EditorView) => {
      callbacks.current.onRun(mode, v.state.doc.toString(), v.state.selection.main.head)
      return true
    }
    const editor = new EditorView({
      parent: host.current!,
      // A shadow root, inside a host's page: the editor's styles go there, not to the document.
      root: host.current!.getRootNode() as Document | ShadowRoot,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run: run('current') },
              { key: 'Shift-Mod-Enter', run: run('all') },
            ]),
          ),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          language.current.of(sql({ dialect, schema, defaultSchema, upperCaseKeywords: true })),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          placeholder('SELECT * FROM …   ⌘↵ runs the statement at the cursor'),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
          }),
          theme,
        ],
      }),
    })
    view.current = editor
    return () => editor.destroy()
    // The editor is made once; value and schema changes reach it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(
        sql({ dialect, schema, defaultSchema, upperCaseKeywords: true }),
      ),
    })
  }, [schema, defaultSchema, dialect])

  return <div className="editor" ref={host} />
}
