import { throwIfInvalid, type ValidationResult, validationResult } from '../validate';
import type { FieldMapSet } from './types.ts';

const FORBIDDEN_FIELD_CHARS = /[.:]/;

/** Field names are plain identifiers: `.` walks a path and `:` names a bridge target. */
export const validateFieldMaps = (set: FieldMapSet): ValidationResult => {
  const errors = [];
  for (const [mapName, fieldMap] of Object.entries(set.maps))
    for (const [modelName, model] of Object.entries(fieldMap.models))
      for (const [fieldName, entry] of Object.entries(model.fields))
        if (entry.kind !== 'bridge' && FORBIDDEN_FIELD_CHARS.test(fieldName))
          errors.push({
            path: `${mapName}:${modelName}.${fieldName}`,
            message: 'contains forbidden character . or :',
            code: 'invalid_field_name',
          });
  return validationResult(errors);
};

export const assertValidFieldMaps = (set: FieldMapSet): void =>
  throwIfInvalid(validateFieldMaps(set), 'validateFieldMaps');
