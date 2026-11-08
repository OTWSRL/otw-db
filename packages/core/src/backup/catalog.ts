import { STAGING_SCHEMA } from './format.ts'

/*
 * The catalog queries a backup is written from. Each returns one JSON value (where an OID comes
 * back as a string: compare them as such, and say what's true of one as a boolean); $1 is always the
 * schemas backed up, as text[] (SCHEMAS_SQL and SERVER_SQL take none). They run with search_path empty, so every name the server prints
 * (in a default, a view, a function's signature) comes schema-qualified, as pg_dump has it.
 *
 * Objects that belong to an extension are left out: CREATE EXTENSION makes them again.
 */

/** The catalogs' OIDs, the same in every PostgreSQL. */
export const PG_TYPE = 1247
export const PG_PROC = 1255
export const PG_CLASS = 1259
export const PG_ATTRDEF = 2604
export const PG_CONSTRAINT = 2606
export const PG_NAMESPACE = 2615
export const PG_REWRITE = 2618
export const PG_EXTENSION = 3079

const notMember = (catalog: number, oid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = ${catalog} AND e.objid = ${oid} AND e.deptype = 'e')`

/** Not made along with something else, as a range type's constructors and cast are. */
const notInternal = (catalog: number, oid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend i WHERE i.classid = ${catalog} AND i.objid = ${oid} AND i.deptype = 'i')`

/**
 * An object's privileges as the grants and revokes that turn a new object's into them: what its
 * ACL has that the default for its owner hasn't, and the reverse. Null when it has the default.
 * `kind` is acldefault's letter: r relation, s sequence, f function, T type, n schema, c column.
 */
function acl(column: string, kind: string, owner: string): string {
  const explode = (value: string) =>
    `SELECT grantee, privilege_type, is_grantable FROM aclexplode(${value})`
  const actual = explode(column)
  const fresh = explode(`acldefault('${kind}', ${owner})`)
  const list = (from: string, minus: string) => `(SELECT coalesce(json_agg(json_build_object(
      'role', CASE WHEN g.grantee = 0 THEN NULL ELSE pg_get_userbyid(g.grantee) END,
      'privilege', g.privilege_type, 'grantable', g.is_grantable) ORDER BY g.grantee, g.privilege_type), '[]')
     FROM (${from} EXCEPT ${minus}) g)`
  return `CASE WHEN ${column} IS NULL THEN NULL ELSE json_build_object(
    'grant', ${list(actual, fresh)}, 'revoke', ${list(fresh, actual)}) END`
}

/** A collation that isn't the type's own, as a qualified name, else null. */
const collation = (coll: string, type: string) => `CASE WHEN ${coll} <> 0
    AND ${coll} <> (SELECT ty.typcollation FROM pg_type ty WHERE ty.oid = ${type})
    THEN (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co
          JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = ${coll}) END`

const inSchemas = (namespace: string) =>
  `${namespace} IN (SELECT oid FROM pg_namespace WHERE nspname = ANY($1))`

/** The session's settings: names printed qualified, values printed so they read back the same. */
export const SESSION_SQL = [
  `SELECT set_config('search_path', '', true)`,
  `SET LOCAL bytea_output = 'hex'`,
  `SET LOCAL extra_float_digits = 3`,
  `SET LOCAL datestyle = 'ISO, YMD'`,
  `SET LOCAL intervalstyle = 'postgres'`,
  `SET LOCAL TimeZone = 'UTC'`,
  // A table's rows filtered by row-level security would make a backup quietly incomplete: with
  // this off, reading such a table fails instead.
  `SET LOCAL row_security = off`,
]

export const SERVER_SQL = `SELECT json_build_object(
  'version', current_setting('server_version_num')::int, 'server', split_part(version(), ' ', 1)
    || ' ' || current_setting('server_version'), 'database', current_database(), 'user', current_user)`

/** Every schema a backup could hold, with what's in it; takes no parameters. */
export const SCHEMAS_SQL = `SELECT coalesce(json_agg(json_build_object(
    'name', n.nspname, 'owner', pg_get_userbyid(n.nspowner),
    'mine', pg_has_role(n.nspowner, 'USAGE'),
    'tables', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid
                 AND c.relkind IN ('r','p') AND NOT c.relispartition AND ${notMember(PG_CLASS, 'c.oid')}),
    'objects', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid
                  AND c.relkind IN ('r','p','v','m','S','f') AND ${notMember(PG_CLASS, 'c.oid')})
             + (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid AND ${notMember(PG_PROC, 'p.oid')})
             + (SELECT count(*) FROM pg_type t WHERE t.typnamespace = n.oid AND t.typtype IN ('e','d','r')
                  AND ${notMember(PG_TYPE, 't.oid')}),
    'extensions', (SELECT count(*) FROM pg_extension x WHERE x.extnamespace = n.oid))
    ORDER BY n.nspname), '[]')
  FROM pg_namespace n
  WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> '${STAGING_SCHEMA}'
    AND ${notMember(PG_NAMESPACE, 'n.oid')}`

/** The name of the schema with OID `namespace`. */
const schemaOf = (namespace: string) =>
  `(SELECT nspname FROM pg_namespace WHERE oid = ${namespace})`

/**
 * What the backup can't hold, in the schemas it backs up, and what's database-wide (schema null):
 * described as the server describes them, such as `aggregate public.median(numeric)`.
 */
export const NOT_INCLUDED_SQL = `SELECT coalesce(json_agg(json_build_object('schema', x.schema, 'what', x.what)
    ORDER BY x.schema NULLS FIRST, x.what), '[]') FROM (
  SELECT ${schemaOf('p.pronamespace')} AS schema, pg_describe_object(${PG_PROC}, p.oid, 0) AS what
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE ${inSchemas('p.pronamespace')} AND (p.prokind = 'a' OR l.lanname IN ('c', 'internal'))
     AND ${notMember(PG_PROC, 'p.oid')} AND ${notInternal(PG_PROC, 'p.oid')}
  UNION ALL SELECT ${schemaOf('t.typnamespace')}, pg_describe_object(${PG_TYPE}, t.oid, 0) FROM pg_type t
   WHERE ${inSchemas('t.typnamespace')} AND t.typtype = 'b' AND t.typcategory <> 'A'
     AND ${notMember(PG_TYPE, 't.oid')}
  UNION ALL SELECT ${schemaOf('t.typnamespace')}, pg_describe_object(${PG_TYPE}, t.oid, 0) || ' (it has a canonical function)'
    FROM pg_type t JOIN pg_range r ON r.rngtypid = t.oid
   WHERE ${inSchemas('t.typnamespace')} AND r.rngcanonical <> 0 AND ${notMember(PG_TYPE, 't.oid')}
  UNION ALL SELECT ${schemaOf('o.collnamespace')}, pg_describe_object('pg_collation'::regclass, o.oid, 0) FROM pg_collation o
   WHERE ${inSchemas('o.collnamespace')} AND ${notMember(3456, 'o.oid')}
  UNION ALL SELECT ${schemaOf('o.oprnamespace')}, pg_describe_object('pg_operator'::regclass, o.oid, 0) FROM pg_operator o
   WHERE ${inSchemas('o.oprnamespace')} AND ${notMember(2617, 'o.oid')}
  UNION ALL SELECT ${schemaOf('o.opfnamespace')}, pg_describe_object('pg_opfamily'::regclass, o.oid, 0) FROM pg_opfamily o
   WHERE ${inSchemas('o.opfnamespace')} AND ${notMember(2753, 'o.oid')}
  UNION ALL SELECT ${schemaOf('o.cfgnamespace')}, pg_describe_object('pg_ts_config'::regclass, o.oid, 0) FROM pg_ts_config o
   WHERE ${inSchemas('o.cfgnamespace')} AND ${notMember(3602, 'o.oid')}
  UNION ALL SELECT ${schemaOf('o.dictnamespace')}, pg_describe_object('pg_ts_dict'::regclass, o.oid, 0) FROM pg_ts_dict o
   WHERE ${inSchemas('o.dictnamespace')} AND ${notMember(3600, 'o.oid')}
  UNION ALL SELECT ${schemaOf('o.connamespace')}, pg_describe_object('pg_conversion'::regclass, o.oid, 0) FROM pg_conversion o
   WHERE ${inSchemas('o.connamespace')} AND ${notMember(2607, 'o.oid')}
  UNION ALL SELECT ${schemaOf('c.relnamespace')}, pg_describe_object(${PG_CLASS}, c.oid, 0) FROM pg_class c
   WHERE ${inSchemas('c.relnamespace')} AND ${notMember(PG_CLASS, 'c.oid')}
     AND (c.relkind = 'f' OR c.reloftype <> 0
          OR (c.relkind IN ('r','p') AND NOT c.relispartition
              AND EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid))
          OR (c.relispartition AND NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent
                WHERE i.inhrelid = c.oid AND ${inSchemas('pc.relnamespace')})))
  UNION ALL SELECT NULL, pg_describe_object('pg_cast'::regclass, k.oid, 0) FROM pg_cast k
   WHERE k.oid >= 16384 AND ${notMember(2605, 'k.oid')} AND ${notInternal(2605, 'k.oid')}
  UNION ALL SELECT NULL, pg_describe_object('pg_event_trigger'::regclass, v.oid, 0) FROM pg_event_trigger v
   WHERE ${notMember(3466, 'v.oid')}
  UNION ALL SELECT NULL, pg_describe_object('pg_publication'::regclass, b.oid, 0) FROM pg_publication b
  UNION ALL SELECT NULL, pg_describe_object('pg_foreign_server'::regclass, f.oid, 0) FROM pg_foreign_server f
   WHERE ${notMember(1417, 'f.oid')}
  UNION ALL SELECT NULL, count(*) || ' large objects' FROM pg_largeobject_metadata HAVING count(*) > 0
) x`

export const SCHEMA_DETAILS_SQL = `SELECT coalesce(json_agg(json_build_object(
    'name', n.nspname, 'owner', pg_get_userbyid(n.nspowner),
    'comment', obj_description(n.oid, 'pg_namespace'), 'acl', ${acl('n.nspacl', 'n', 'n.nspowner')},
    'defaults', (SELECT coalesce(json_agg(json_build_object('role', pg_get_userbyid(d.defaclrole),
        'type', d.defaclobjtype, 'grants', (SELECT coalesce(json_agg(json_build_object(
          'role', CASE WHEN g.grantee = 0 THEN NULL ELSE pg_get_userbyid(g.grantee) END,
          'privilege', g.privilege_type, 'grantable', g.is_grantable)), '[]') FROM aclexplode(d.defaclacl) g))), '[]')
      FROM pg_default_acl d WHERE d.defaclnamespace = n.oid))
    ORDER BY n.nspname), '[]')
  FROM pg_namespace n WHERE n.nspname = ANY($1)`

/** The extensions besides plpgsql, each with its schema; the backup keeps the ones it needs. */
export const EXTENSIONS_SQL = `SELECT coalesce(json_agg(json_build_object('oid', x.oid, 'name', x.extname,
    'schema', n.nspname) ORDER BY x.extname), '[]')
  FROM pg_extension x JOIN pg_namespace n ON n.oid = x.extnamespace WHERE x.extname <> 'plpgsql'`

/**
 * The extensions something in the schemas needs: a column of citext, a default calling
 * uuid_generate_v4(), an index with pg_trgm's operator class.
 */
export const NEEDED_EXTENSIONS_SQL = `SELECT coalesce(json_agg(DISTINCT m.refobjid), '[]')
  FROM pg_depend d
  JOIN pg_depend m ON m.classid = d.refclassid AND m.objid = d.refobjid AND m.deptype = 'e'
   AND m.refclassid = ${PG_EXTENSION}
  WHERE d.deptype IN ('n', 'a') AND d.classid IN (${PG_CLASS}, ${PG_TYPE}, ${PG_PROC}, ${PG_ATTRDEF}, ${PG_CONSTRAINT}, ${PG_REWRITE})
    AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = d.classid AND e.objid = d.objid AND e.deptype = 'e')
    AND CASE d.classid
      WHEN ${PG_CLASS} THEN (SELECT relnamespace FROM pg_class WHERE oid = d.objid)
      WHEN ${PG_TYPE} THEN (SELECT typnamespace FROM pg_type WHERE oid = d.objid)
      WHEN ${PG_PROC} THEN (SELECT pronamespace FROM pg_proc WHERE oid = d.objid)
      WHEN ${PG_ATTRDEF} THEN (SELECT c.relnamespace FROM pg_attrdef a JOIN pg_class c ON c.oid = a.adrelid WHERE a.oid = d.objid)
      WHEN ${PG_CONSTRAINT} THEN (SELECT connamespace FROM pg_constraint WHERE oid = d.objid)
      WHEN ${PG_REWRITE} THEN (SELECT c.relnamespace FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE r.oid = d.objid)
    END IN (SELECT oid FROM pg_namespace WHERE nspname = ANY($1))`

export const TYPES_SQL = `SELECT coalesce(json_agg(json_build_object(
    'oid', t.oid, 'schema', n.nspname, 'name', t.typname, 'kind', t.typtype,
    'owner', pg_get_userbyid(t.typowner), 'comment', obj_description(t.oid, 'pg_type'),
    'acl', ${acl('t.typacl', 'T', 't.typowner')},
    'labels', CASE WHEN t.typtype = 'e' THEN (SELECT json_agg(v.enumlabel ORDER BY v.enumsortorder)
                FROM pg_enum v WHERE v.enumtypid = t.oid) END,
    'attributes', CASE WHEN t.typtype = 'c' THEN (SELECT json_agg(json_build_object('name', a.attname,
        'type', format_type(a.atttypid, a.atttypmod), 'collation', ${collation('a.attcollation', 'a.atttypid')},
        'comment', col_description(a.attrelid, a.attnum)) ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) END,
    'base', CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END,
    'notNull', t.typnotnull,
    'default', CASE WHEN t.typtype = 'd' THEN coalesce(pg_get_expr(t.typdefaultbin, 0), t.typdefault) END,
    'collation', CASE WHEN t.typtype = 'd' THEN ${collation('t.typcollation', 't.typbasetype')} END,
    'checks', CASE WHEN t.typtype = 'd' THEN (SELECT json_agg(json_build_object('name', c.conname,
        'def', pg_get_constraintdef(c.oid), 'comment', obj_description(c.oid, 'pg_constraint')) ORDER BY c.conname)
      FROM pg_constraint c WHERE c.contypid = t.oid AND c.contype = 'c') END,
    'range', CASE WHEN t.typtype = 'r' THEN (SELECT json_build_object(
        'subtype', format_type(r.rngsubtype, NULL),
        'opclass', CASE WHEN NOT oc.opcdefault THEN quote_ident(ocn.nspname) || '.' || quote_ident(oc.opcname) END,
        'collation', ${collation('r.rngcollation', 'r.rngsubtype')},
        'diff', CASE WHEN r.rngsubdiff <> 0 THEN r.rngsubdiff::regproc::text END,
        'multirange', (SELECT quote_ident(mn.nspname) || '.' || quote_ident(mt.typname) FROM pg_type mt
            JOIN pg_namespace mn ON mn.oid = mt.typnamespace WHERE mt.oid = r.rngmultitypid))
      FROM pg_range r JOIN pg_opclass oc ON oc.oid = r.rngsubopc JOIN pg_namespace ocn ON ocn.oid = oc.opcnamespace
      WHERE r.rngtypid = t.oid AND r.rngcanonical = 0) END)
    ORDER BY n.nspname, t.typname), '[]')
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = ANY($1) AND ${notMember(PG_TYPE, 't.oid')}
    AND (t.typtype IN ('e', 'd')
         OR (t.typtype = 'r' AND NOT EXISTS (SELECT 1 FROM pg_range r WHERE r.rngtypid = t.oid AND r.rngcanonical <> 0))
         OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))`

export const FUNCTIONS_SQL = `SELECT coalesce(json_agg(json_build_object(
    'oid', p.oid, 'schema', n.nspname, 'name', p.proname, 'kind', p.prokind,
    'signature', p.oid::regprocedure::text, 'def', pg_get_functiondef(p.oid),
    'owner', pg_get_userbyid(p.proowner), 'comment', obj_description(p.oid, 'pg_proc'),
    'acl', ${acl('p.proacl', 'f', 'p.proowner')})
    ORDER BY n.nspname, p.proname, p.oid::regprocedure::text), '[]')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = ANY($1) AND p.prokind IN ('f', 'p', 'w') AND l.lanname NOT IN ('c', 'internal')
    AND ${notMember(PG_PROC, 'p.oid')}`

/** A sequence's settings, for CREATE SEQUENCE or an identity column's options. */
const sequenceSettings = (c: string, s: string) => `json_build_object(
    'name', quote_ident(sn.nspname) || '.' || quote_ident(${c}.relname),
    'type', format_type(${s}.seqtypid, NULL), 'start', ${s}.seqstart::text,
    'increment', ${s}.seqincrement::text, 'min', ${s}.seqmin::text, 'max', ${s}.seqmax::text,
    'cache', ${s}.seqcache::text, 'cycle', ${s}.seqcycle,
    'last', (SELECT ps.last_value::text FROM pg_sequences ps WHERE ps.schemaname = sn.nspname
               AND ps.sequencename = ${c}.relname))`

/** Sequences of their own; an identity column's comes with its table. */
export const SEQUENCES_SQL = `SELECT coalesce(json_agg(json_build_object(
    'oid', c.oid, 'schema', sn.nspname, 'name', c.relname, 'settings', ${sequenceSettings('c', 's')},
    'unlogged', c.relpersistence = 'u', 'owner', pg_get_userbyid(c.relowner),
    'comment', obj_description(c.oid, 'pg_class'), 'acl', ${acl('c.relacl', 's', 'c.relowner')},
    'ownedBy', (SELECT json_build_object('table', d.refobjid, 'column', a.attname) FROM pg_depend d
       JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
       WHERE d.classid = ${PG_CLASS} AND d.objid = c.oid AND d.refclassid = ${PG_CLASS} AND d.deptype = 'a' LIMIT 1))
    ORDER BY sn.nspname, c.relname), '[]')
  FROM pg_class c JOIN pg_sequence s ON s.seqrelid = c.oid JOIN pg_namespace sn ON sn.oid = c.relnamespace
  WHERE c.relkind = 'S' AND sn.nspname = ANY($1) AND ${notMember(PG_CLASS, 'c.oid')}
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = ${PG_CLASS} AND d.objid = c.oid AND d.deptype = 'i')`

/** A relation's columns: types, defaults, identity and generation, collations, comments, grants. */
const columns = (c: string) => `(SELECT coalesce(json_agg(json_build_object(
    'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
    'default', CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
    'generated', CASE WHEN a.attgenerated <> '' THEN json_build_object('kind', a.attgenerated,
        'expr', pg_get_expr(d.adbin, d.adrelid)) END,
    'identity', CASE WHEN a.attidentity <> '' THEN (SELECT json_build_object('kind', a.attidentity,
        'sequence', ${sequenceSettings('sc', 's')})
      FROM pg_depend sd JOIN pg_class sc ON sc.oid = sd.objid JOIN pg_sequence s ON s.seqrelid = sc.oid
      JOIN pg_namespace sn ON sn.oid = sc.relnamespace
      WHERE sd.classid = ${PG_CLASS} AND sd.refclassid = ${PG_CLASS} AND sd.refobjid = a.attrelid
        AND sd.refobjsubid = a.attnum AND sd.deptype = 'i' LIMIT 1) END,
    'collation', ${collation('a.attcollation', 'a.atttypid')}, 'local', a.attislocal,
    'comment', col_description(a.attrelid, a.attnum), 'acl', ${acl('a.attacl', 'c', `${c}.relowner`)})
    ORDER BY a.attnum), '[]')
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = ${c}.oid AND a.attnum > 0 AND NOT a.attisdropped)`

export const TABLES_SQL = `SELECT coalesce(json_agg(json_build_object(
    'oid', c.oid, 'schema', n.nspname, 'name', c.relname, 'kind', c.relkind,
    'unlogged', c.relpersistence = 'u',
    'parent', (SELECT i.inhparent FROM pg_inherits i WHERE i.inhrelid = c.oid AND c.relispartition),
    'bound', CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END,
    'partitionKey', CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
    'options', c.reloptions, 'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
    'replicaIdentity', c.relreplident,
    'replicaIndex', (SELECT ic.relname FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
                       WHERE x.indrelid = c.oid AND x.indisreplident),
    'owner', pg_get_userbyid(c.relowner), 'comment', obj_description(c.oid, 'pg_class'),
    'acl', ${acl('c.relacl', 'r', 'c.relowner')}, 'columns', ${columns('c')},
    'checks', (SELECT coalesce(json_agg(json_build_object('name', co.conname, 'def', pg_get_constraintdef(co.oid),
        'valid', co.convalidated, 'comment', obj_description(co.oid, 'pg_constraint')) ORDER BY co.conname), '[]')
      FROM pg_constraint co WHERE co.conrelid = c.oid AND co.contype = 'c' AND co.conislocal),
    'notNulls', (SELECT coalesce(json_agg(json_build_object('name', co.conname, 'column', a.attname,
        'def', pg_get_constraintdef(co.oid), 'valid', co.convalidated, 'local', co.conislocal,
        'noInherit', co.connoinherit, 'comment', obj_description(co.oid, 'pg_constraint'))), '[]')
      FROM pg_constraint co JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = co.conkey[1]
      WHERE co.conrelid = c.oid AND co.contype = 'n'))
    ORDER BY n.nspname, c.relname), '[]')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1) AND ${notMember(PG_CLASS, 'c.oid')}
    AND c.reloftype = 0
    AND (c.relispartition OR NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid))
    AND (NOT c.relispartition OR EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent
           WHERE i.inhrelid = c.oid AND ${inSchemas('pc.relnamespace')}))`

export const VIEWS_SQL = `SELECT coalesce(json_agg(json_build_object(
    'oid', c.oid, 'schema', n.nspname, 'name', c.relname, 'kind', c.relkind,
    'def', pg_get_viewdef(c.oid), 'options', c.reloptions, 'populated', c.relispopulated,
    'owner', pg_get_userbyid(c.relowner), 'comment', obj_description(c.oid, 'pg_class'),
    'acl', ${acl('c.relacl', 'r', 'c.relowner')}, 'columns', ${columns('c')})
    ORDER BY n.nspname, c.relname), '[]')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v', 'm') AND n.nspname = ANY($1) AND ${notMember(PG_CLASS, 'c.oid')}`

/** Primary keys, unique and exclusion constraints, and foreign keys. */
export const CONSTRAINTS_SQL = `SELECT coalesce(json_agg(json_build_object(
    'oid', co.oid, 'name', co.conname, 'type', co.contype, 'table', co.conrelid,
    'def', pg_get_constraintdef(co.oid), 'inherited', co.conparentid <> 0,
    'partitioned', c.relkind = 'p', 'comment', obj_description(co.oid, 'pg_constraint'))
    ORDER BY n.nspname, c.relname, co.conname), '[]')
  FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE co.contype IN ('p', 'u', 'x', 'f') AND n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
    AND ${notMember(PG_CLASS, 'c.oid')}`

export const INDEXES_SQL = `SELECT coalesce(json_agg(json_build_object(
    'oid', x.indexrelid, 'schema', n.nspname, 'name', ic.relname, 'table', x.indrelid,
    'def', pg_get_indexdef(x.indexrelid), 'clustered', x.indisclustered,
    'parent', (SELECT i.inhparent FROM pg_inherits i WHERE i.inhrelid = x.indexrelid),
    'constraint', EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conindid = x.indexrelid
                    AND co.conrelid = x.indrelid AND co.contype IN ('p', 'u', 'x')),
    'comment', obj_description(x.indexrelid, 'pg_class'))
    ORDER BY n.nspname, ic.relname), '[]')
  FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid JOIN pg_class tc ON tc.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  WHERE n.nspname = ANY($1) AND tc.relkind IN ('r', 'p', 'm') AND ${notMember(PG_CLASS, 'tc.oid')}`

export const TRIGGERS_SQL = `SELECT coalesce(json_agg(json_build_object(
    'name', t.tgname, 'table', t.tgrelid, 'def', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled,
    'comment', obj_description(t.oid, 'pg_trigger'))
    ORDER BY n.nspname, c.relname, t.tgname), '[]')
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal AND t.tgparentid = 0 AND n.nspname = ANY($1)
    AND ${notMember(PG_CLASS, 'c.oid')}`

/** Rules besides a view's own. */
export const RULES_SQL = `SELECT coalesce(json_agg(json_build_object('name', r.rulename, 'table', r.ev_class,
    'def', pg_get_ruledef(r.oid), 'comment', obj_description(r.oid, 'pg_rewrite'))
    ORDER BY n.nspname, c.relname, r.rulename), '[]')
  FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE r.rulename <> '_RETURN' AND n.nspname = ANY($1) AND ${notMember(PG_CLASS, 'c.oid')}`

export const POLICIES_SQL = `SELECT coalesce(json_agg(json_build_object(
    'name', p.polname, 'table', p.polrelid, 'command', p.polcmd, 'permissive', p.polpermissive,
    'roles', (SELECT json_agg(CASE WHEN r = 0 THEN NULL ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),
    'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid),
    'comment', obj_description(p.oid, 'pg_policy'))
    ORDER BY n.nspname, c.relname, p.polname), '[]')
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1)`

export const STATISTICS_SQL = `SELECT coalesce(json_agg(json_build_object(
    'name', quote_ident(n.nspname) || '.' || quote_ident(s.stxname),
    'def', pg_get_statisticsobjdef(s.oid), 'comment', obj_description(s.oid, 'pg_statistic_ext'))
    ORDER BY n.nspname, s.stxname), '[]')
  FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace WHERE n.nspname = ANY($1)`

/**
 * What depends on what, among the objects a backup creates before its data: [catalog, oid,
 * referenced catalog, referenced oid, how], with column defaults, a view's rule and check
 * constraints standing for their table, view or domain, and a row type for its relation.
 */
export const DEPENDENCIES_SQL = `SELECT coalesce(json_agg(json_build_array(x.cat, x.oid, x.refcat, x.refoid, x.how)), '[]')
  FROM (
    SELECT DISTINCT
      CASE WHEN d.classid IN (${PG_ATTRDEF}, ${PG_REWRITE}) THEN ${PG_CLASS}
           WHEN d.classid = ${PG_CONSTRAINT} THEN CASE WHEN co.contypid <> 0 THEN ${PG_TYPE} ELSE ${PG_CLASS} END
           WHEN d.classid = ${PG_CLASS} AND cc.relkind = 'c' THEN ${PG_TYPE}
           ELSE d.classid::int END AS cat,
      CASE WHEN d.classid = ${PG_ATTRDEF} THEN ad.adrelid
           WHEN d.classid = ${PG_REWRITE} THEN rw.ev_class
           WHEN d.classid = ${PG_CONSTRAINT} THEN CASE WHEN co.contypid <> 0 THEN co.contypid ELSE co.conrelid END
           WHEN d.classid = ${PG_CLASS} AND cc.relkind = 'c' THEN cc.reltype
           ELSE d.objid END AS oid,
      CASE WHEN d.refclassid = ${PG_TYPE} AND rc.relkind IS NOT NULL AND rc.relkind <> 'c' THEN ${PG_CLASS}
           ELSE d.refclassid::int END AS refcat,
      CASE WHEN d.refclassid = ${PG_TYPE} AND rc.relkind IS NOT NULL AND rc.relkind <> 'c' THEN rc.oid
           WHEN d.refclassid = ${PG_TYPE} AND rt.typcategory = 'A' AND rt.typelem <> 0 THEN rt.typelem
           ELSE d.refobjid END AS refoid,
      CASE WHEN d.classid = ${PG_ATTRDEF} AND att.attgenerated = '' THEN 'default' ELSE 'hard' END AS how
    FROM pg_depend d
    LEFT JOIN pg_attrdef ad ON d.classid = ${PG_ATTRDEF} AND ad.oid = d.objid
    LEFT JOIN pg_attribute att ON att.attrelid = ad.adrelid AND att.attnum = ad.adnum
    LEFT JOIN pg_rewrite rw ON d.classid = ${PG_REWRITE} AND rw.oid = d.objid
    LEFT JOIN pg_constraint co ON d.classid = ${PG_CONSTRAINT} AND co.oid = d.objid
    LEFT JOIN pg_class cc ON d.classid = ${PG_CLASS} AND cc.oid = d.objid
    LEFT JOIN pg_type rt ON d.refclassid = ${PG_TYPE} AND rt.oid = d.refobjid
    LEFT JOIN pg_class rc ON rc.oid = rt.typrelid
    WHERE d.deptype = 'n' AND d.refclassid IN (${PG_TYPE}, ${PG_PROC}, ${PG_CLASS})
      AND (d.classid IN (${PG_TYPE}, ${PG_PROC}, ${PG_CLASS}, ${PG_ATTRDEF})
           OR (d.classid = ${PG_REWRITE} AND rw.rulename = '_RETURN')
           OR (d.classid = ${PG_CONSTRAINT} AND co.contype = 'c'))
  ) x`
