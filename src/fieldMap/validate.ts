import type { FieldMap } from '../toPrisma/types.ts';
import type { FieldMapSet } from './types.ts';

const FORBIDDEN_FIELD_CHARS = /[.:]/;

export const validateFieldMapSet = (set: FieldMapSet): void => {
  const errors: string[] = [];
  for (const [mapName, fieldMap] of Object.entries(set)) {
    for (const [modelName, model] of Object.entries(fieldMap)) {
      for (const fieldName of Object.keys(model.fields)) {
        if (FORBIDDEN_FIELD_CHARS.test(fieldName)) {
          errors.push(`'${mapName}:${modelName}.${fieldName}' contains forbidden character . or :`);
        }
      }
    }
  }
  if (errors.length) {
    throw new Error(`validateFieldMapSet:\n${errors.join('\n')}`);
  }
};

export const validateFieldMap = (fieldMap: FieldMap, mapName = 'fieldMap'): void => {
  validateFieldMapSet({ [mapName]: fieldMap });
};
