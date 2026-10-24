import { z } from 'zod';

/**
 * The PATCH form of a create schema: every field optional, and a field the
 * request leaves out stays out.
 *
 * Zod 4's `.partial()` wraps each field in `.optional()`, and an optional
 * whose inner schema has a `.default()` now SUBSTITUTES that default for a
 * missing value (zod 3 left it absent). A PATCH built with `.partial()` from
 * a create schema with defaults would therefore write every default back on
 * each edit: renaming an SSO connection would re-enable it
 * (`enabled: z.boolean().default(true)`). This strips the defaults first, so
 * the result parses exactly as zod 3's `.partial()` did. Its type is the
 * same as `.partial()`'s.
 */
export function patchSchema<S extends z.core.$ZodShape, C extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<S, C>,
): z.ZodObject<{ -readonly [K in keyof S]: z.ZodOptional<S[K]> }, C> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) shape[key] = withoutDefault(field as z.ZodType);
  return schema.extend(shape).partial() as unknown as z.ZodObject<{ -readonly [K in keyof S]: z.ZodOptional<S[K]> }, C>;
}

/** The schema with its `.default()` (or `.prefault()`) removed, keeping the optional/nullable wrappers around it. */
function withoutDefault(s: z.ZodType): z.ZodType {
  if (s instanceof z.ZodDefault || s instanceof z.ZodPrefault) return withoutDefault(s.unwrap() as z.ZodType);
  if (s instanceof z.ZodOptional) return withoutDefault(s.unwrap() as z.ZodType).optional();
  if (s instanceof z.ZodNullable) return withoutDefault(s.unwrap() as z.ZodType).nullable();
  return s;
}
