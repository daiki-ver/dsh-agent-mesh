/**
 * The tool wrapper.
 *
 * Every Mesh tool is declared once with a zod schema and rendered as JSON. The wrapper
 * exists so tool definitions stay declarative: the schema is the contract, the Host gets
 * a JSON Schema, and the result is always structured text a model can read.
 *
 * `toJSONSchema` is implemented here rather than imported: this bundle pins zod v3, whose
 * `toJSONSchema` is a v4 API. The subset below covers what Mesh tool schemas actually use
 * — objects, strings, numbers, booleans, arrays, enums, records, optional, default,
 * union, literal — which is everything a tool signature needs.
 */

import { z } from 'zod'
import type { ToolDefinition, ToolExecution, ToolParameters } from '../host.ts'

/** A tool's implementation. */
export type ToolImpl<Schema extends z.ZodTypeAny> = (
  args: z.infer<Schema>,
  execution: ToolExecution,
) => Promise<unknown> | unknown

/**
 * Build a Host tool definition from a zod schema.
 *
 * @param name - tool name, prefixed `mesh_`.
 * @param description - what the tool is for, in one or two sentences.
 * @param schema - argument schema.
 * @param impl - implementation.
 */
export function tool<Schema extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: Schema,
  impl: ToolImpl<Schema>,
): ToolDefinition {
  return {
    name,
    description,
    parameters: toJsonSchema(schema),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: async (raw: unknown, execution: ToolExecution) =>
      impl(schema.parse(raw) as z.infer<Schema>, execution),
  }
}

/** A tool that takes no arguments. */
export const NoArgs = z.object({})

/**
 * Convert a zod v3 schema into the JSON Schema a Host tool declaration expects.
 *
 * Deliberately partial: unknown node kinds degrade to `{}` (any value) rather than
 * throwing, because a permissive parameter schema is always better than a failed boot.
 */
export function toJsonSchema(schema: z.ZodTypeAny): ToolParameters {
  const root = convert(schema)
  return (root.type === 'object' ? root : { type: 'object', properties: {} }) as ToolParameters
}

type Json = Record<string, unknown>

/** Convert one node. */
function convert(schema: z.ZodTypeAny): Json {
  const def = schema._def as { typeName?: string; [key: string]: unknown }
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
      const properties: Json = {}
      const required: string[] = []
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = convert(child)
        if (!isOptional(child)) required.push(key)
      }
      const out: Json = { type: 'object', properties }
      if (required.length > 0) out.required = required
      return out
    }
    case 'ZodString': {
      const out: Json = { type: 'string' }
      const checks = (def.checks as { kind: string; value?: number }[] | undefined) ?? []
      for (const check of checks) {
        if (check.kind === 'min' && check.value !== undefined) out.minLength = check.value
        if (check.kind === 'max' && check.value !== undefined) out.maxLength = check.value
      }
      if (def.description !== undefined) out.description = def.description
      return out
    }
    case 'ZodNumber': {
      const out: Json = { type: 'number' }
      const checks = (def.checks as { kind: string; value?: number }[] | undefined) ?? []
      for (const check of checks) {
        if (check.kind === 'int') out.type = 'integer'
        if (check.kind === 'min' && check.value !== undefined) out.minimum = check.value
        if (check.kind === 'max' && check.value !== undefined) out.maximum = check.value
      }
      return out
    }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodArray': {
      const items = convert(def.type as z.ZodTypeAny)
      const out: Json = { type: 'array', items }
      const min = (def.minLength as { value?: number } | null | undefined)?.value
      const max = (def.maxLength as { value?: number } | null | undefined)?.value
      if (min !== undefined) out.minItems = min
      if (max !== undefined) out.maxItems = max
      return out
    }
    case 'ZodEnum':
      return { type: 'string', enum: def.values as string[] }
    case 'ZodLiteral':
      return { const: def.value }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: convert(def.valueType as z.ZodTypeAny) }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
      // Wrappers do not change the wire shape; `isOptional` handles requiredness.
      return convert(def.innerType as z.ZodTypeAny)
    case 'ZodEffects':
      return convert(def.schema as z.ZodTypeAny)
    case 'ZodUnion': {
      const options = (def.options as z.ZodTypeAny[]).map(convert)
      return { anyOf: options }
    }
    case 'ZodDiscriminatedUnion': {
      const options = [...(def.options as Map<string, z.ZodTypeAny>).values()].map(convert)
      return { anyOf: options }
    }
    case 'ZodAny':
    case 'ZodUnknown':
      return {}
    default:
      return {}
  }
}

/** Whether a schema accepts omission. */
function isOptional(schema: z.ZodTypeAny): boolean {
  const name = (schema._def as { typeName?: string }).typeName
  if (name === 'ZodOptional' || name === 'ZodDefault' || name === 'ZodCatch') return true
  if (name === 'ZodEffects') {
    return isOptional((schema._def as { schema: z.ZodTypeAny }).schema)
  }
  return false
}
