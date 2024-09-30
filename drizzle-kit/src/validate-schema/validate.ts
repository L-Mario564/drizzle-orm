import { getTableConfig as getPgTableConfig, getViewConfig as getPgViewConfig, getMaterializedViewConfig as getPgMaterializedViewConfig, PgEnum, PgMaterializedView, pgSchema, PgSchema, PgSequence, PgTable, PgView, IndexedColumn, uniqueKeyName as pgUniqueKeyName, PgColumn, PgDialect } from 'drizzle-orm/pg-core';
import { Sequence as SequenceCommon, Table as TableCommon } from './utils';
import { MySqlTable, MySqlView } from 'drizzle-orm/mysql-core';
import { SQLiteTable, SQLiteView } from 'drizzle-orm/sqlite-core';
import { GeneratedIdentityConfig, getTableName, is, SQL } from 'drizzle-orm';
import { ValidateDatabase } from './db';
import { CasingType } from 'src/cli/validations/common';
import { getColumnCasing, getForeignKeyName, getIdentitySequenceName } from 'src/utils';
import { indexName as pgIndexName } from 'src/serializer/pgSerializer';

export function validatePgSchema(
  casing: CasingType | undefined,
  schemas: PgSchema[],
  tables: PgTable[],
  views: PgView[],
  materializedViews: PgMaterializedView[],
  enums: PgEnum<any>[],
  sequences: PgSequence[],
) {
  const dialect = new PgDialect({ casing });
  const tableConfigs = tables.map((table) => getPgTableConfig(table));
  const viewConfigs = views.map((view) => getPgViewConfig(view));
  const materializedViewConfigs = materializedViews.map((view) => getPgMaterializedViewConfig(view));

  const allSchemas = [
    pgSchema('public'),
    ...schemas
  ].map((schema) => {
    const schemaTables = tableConfigs
      .filter((table) => (table.schema ?? 'public') === schema.schemaName)
      .map((table) => ({
        ...table,
        columns: table.columns.map((column) => ({
          ...column,
          name: getColumnCasing(column, casing)
        }))
      }));

    const schemaEnums = enums.filter((enum_) => (enum_.schema ?? 'public') === schema.schemaName);
    
    const schemaSequences = [
      // Sequences defined with `pgSequence`
      ...sequences.filter((sequence): sequence is PgSequence & { seqName: string } => (sequence.schema ?? 'public') === schema.schemaName && !!sequence.seqName),
      // Sequences defined with `column.generatedAlwaysAsIdentity`
      ...schemaTables
        .map(
          (table) => table.columns
            .filter((column): column is PgColumn & { generatedIdentity: GeneratedIdentityConfig } => !!column.generatedIdentity)
            .map((column) => ({
              seqName: getIdentitySequenceName(column.generatedIdentity.sequenceName, table.name, column.name),
              seqOptions: column.generatedIdentity.sequenceOptions
            }))
        ).flat(1)
    ] satisfies SequenceCommon[];
    
    const schemaViews = viewConfigs.filter((view) => (view.schema ?? 'public') === schema.schemaName);
    
    const schemaMaterializedViews = materializedViewConfigs.filter((materializedView) => (materializedView.schema ?? 'public') === schema.schemaName);

    const schemaIndexes = schemaTables.map(
      (table) => table.indexes.map(
        (index) => {
          const indexColumns = index.config.columns
            .filter((column): column is IndexedColumn => !is(column, SQL));

          const indexColumnNames = indexColumns
            .map((column) => column.name)
            .filter((c) => c !== undefined);

          return {
            name: index.config.name
              ? index.config.name
              : indexColumns.length === index.config.columns.length
                ? pgIndexName(table.name, indexColumnNames)
                : '',
            columns: index.config.columns.map((column) => {
              if (is(column, SQL)) {
                return column;
              }
              const c = column as IndexedColumn;
              return {
                type: c.type,
                op: c.indexConfig.opClass,
                name: getColumnCasing(c, casing),
              }
            })
          };
        }
      )
    ).flat(1) satisfies TableCommon['indexes'];

    const schemaForeignKeys = schemaTables.map(
      (table) => table.foreignKeys.map(
        (fk) => {
          const ref = fk.reference();
          return {
            name: getForeignKeyName(fk, casing),
            reference: {
              columns: ref.columns.map(
                (column) => ({
                  name: getColumnCasing(column, casing),
                  getSQLType: column.getSQLType
                })
              ),
              foreignColumns: ref.foreignColumns.map(
                (column) => ({
                  name: getColumnCasing(column, casing),
                  getSQLType: column.getSQLType
                })
              ),
            }
          };
        }
      )
    ).flat(1) satisfies TableCommon['foreignKeys'];

    const schemaChecks = schemaTables.map(
      (table) => table.checks.map(
        (check) => ({
          name: check.name
        })
      )
    ).flat(1) satisfies TableCommon['checks'];

    const schemaPrimaryKeys = schemaTables.map(
      (table) => table.primaryKeys.map(
        (pk) => ({
          name: pk.name,
          columns: pk.columns.map(
            (column) => ({
              name: getColumnCasing(column, casing)
            })
          )
        })
      )
    ).flat(1) satisfies TableCommon['primaryKeys'];

    const schemaUniqueConstraints = schemaTables.map(
      (table) => table.uniqueConstraints.map(
        (unique) => {
          const columnNames = unique.columns.map((column) => getColumnCasing(column, casing));

          return {
            name: unique.name ?? pgUniqueKeyName(tables.find((t) => getTableName(t) === table.name)!, columnNames)
          };
        }
      )
    ).flat(1) satisfies TableCommon['uniqueConstraints'];

    return {
      name: schema.schemaName,
      tables: schemaTables,
      enums: schemaEnums,
      sequences: schemaSequences,
      views: schemaViews,
      materializedViews: schemaMaterializedViews,
      indexes: schemaIndexes,
      foreignKeys: schemaForeignKeys,
      checks: schemaChecks,
      primaryKeys: schemaPrimaryKeys,
      uniqueConstraints: schemaUniqueConstraints
    };
  });
  const allTables = allSchemas.map((schema) => schema.tables).flat(1);

  const vDb = new ValidateDatabase();
  vDb.schemaNameCollisions(schemas);

  for (const schema of allSchemas) {
    const v = vDb.validateSchema(schema.name ?? 'public');

    v
      .constraintNameCollisions(
        schema.indexes,
        schema.foreignKeys,
        schema.checks,
        schema.primaryKeys,
        schema.uniqueConstraints
      )
      .entityNameCollisions(
        schema.tables,
        schema.views,
        schema.materializedViews,
        schema.enums,
        schema.sequences
      );

    for (const enum_ of schema.enums) {
      v.validateEnum(enum_.enumName).valueCollisions(enum_.enumValues);
    }

    for (const sequence of schema.sequences) {
      v.validateSequence(sequence.seqName).incorrectvalues(sequence);
    }

    for (const table of schema.tables) {
      v.validateTable(table.name).columnNameCollisions(table.columns);
    }

    for (const foreignKey of schema.foreignKeys) {
      v
        .validateForeignKey(foreignKey.name)
        .columnsMixingTables(foreignKey, allTables)
        .mismatchingColumnCount(foreignKey)
        .mismatchingDataTypes(foreignKey);
    }

    for (const index of schema.indexes) {
      v
        .validateIndex(index.name)
        .requiresName(index.columns, dialect)
        .vectorColumnRequiresOp(index.columns);
    }
  }

  return vDb.errors;
}

export function validateMySqlSchema(
  casing: CasingType | undefined,
  tables: MySqlTable[],
  views: MySqlView[],
) {

}

export function validateSQLiteSchema(
  casing: CasingType | undefined,
  tables: SQLiteTable[],
  views: SQLiteView[],
) {

}