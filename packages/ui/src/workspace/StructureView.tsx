import type { TableDetail } from '../api.ts'
import { Icon } from '../ui/icons.tsx'

/** TablePlus's Structure tab: the columns, then the indexes, foreign keys and checks. */
export function StructureView({ table }: { table: TableDetail }) {
  const primary = new Set(table.primaryKey)
  return (
    <div className="structure" aria-label="Structure">
      {table.comment && <p>{table.comment}</p>}
      <table aria-label="Columns">
        <thead>
          <tr>
            <th>#</th>
            <th>Column</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
            <th>Generated</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((column, i) => (
            <tr key={column.name}>
              <td>{i + 1}</td>
              <td>
                {primary.has(column.name) && <Icon name="key" size={12} label="Primary key" />}{' '}
                {column.name}
              </td>
              <td>
                <code>{column.type}</code>
              </td>
              <td>{column.nullable ? 'YES' : 'NO'}</td>
              <td>{column.default !== null && <code>{column.default}</code>}</td>
              <td>{column.generated}</td>
              <td>{column.comment}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Definitions title="Indexes" items={table.indexes} />
      <Definitions title="Foreign keys" items={table.foreignKeys} />
      <Definitions title="Checks" items={table.checks} />
    </div>
  )
}

function Definitions({ title, items }: { title: string; items: TableDetail['indexes'] }) {
  if (!items.length) return null
  return (
    <>
      <h2>{title}</h2>
      <table aria-label={title}>
        <tbody>
          {items.map((item) => (
            <tr key={item.name}>
              <td style={{ width: '30%' }}>{item.name}</td>
              <td>
                <code>{item.definition}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
