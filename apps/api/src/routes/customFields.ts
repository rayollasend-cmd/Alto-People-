import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

export const customFieldsRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

const FieldTypeSchema = z.enum([
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
  'MULTISELECT',
]);
const EntitySchema = z.enum(['ASSOCIATE', 'POSITION', 'CLIENT']);

const DefinitionInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  entityType: EntitySchema,
  key: z.string().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/, {
    message: 'Key must be lowercase, alphanumeric or underscore.',
  }),
  label: z.string().min(1).max(120),
  type: FieldTypeSchema,
  isRequired: z.boolean().optional(),
  isSensitive: z.boolean().optional(),
  helpText: z.string().max(500).optional().nullable(),
  options: z.array(z.string().min(1).max(80)).optional().nullable(),
  displayOrder: z.number().int().optional(),
});

customFieldsRouter.get('/definitions', VIEW, async (req: Request, res: Response) => {
  const clientId =
    typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const entityType =
    typeof req.query.entityType === 'string'
      ? (req.query.entityType as 'ASSOCIATE' | 'POSITION' | 'CLIENT')
      : undefined;
  const where: Prisma.CustomFieldDefinitionWhereInput = {
    deletedAt: null,
    ...(entityType ? { entityType } : {}),
    ...(clientId !== undefined
      ? { OR: [{ clientId: null }, { clientId }] }
      : {}),
  };
  const rows = await prisma.customFieldDefinition.findMany({
    take: 1000,
    where,
    orderBy: [{ entityType: 'asc' }, { displayOrder: 'asc' }, { label: 'asc' }],
  });
  res.json({
    definitions: rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      entityType: r.entityType,
      key: r.key,
      label: r.label,
      type: r.type,
      isRequired: r.isRequired,
      isSensitive: r.isSensitive,
      helpText: r.helpText,
      options: r.options,
      displayOrder: r.displayOrder,
    })),
  });
});

customFieldsRouter.post(
  '/definitions',
  MANAGE,
  async (req: Request, res: Response) => {
    const input = DefinitionInputSchema.parse(req.body);
    if ((input.type === 'SELECT' || input.type === 'MULTISELECT') && (!input.options || input.options.length === 0)) {
      throw new HttpError(
        400,
        'options_required',
        'SELECT / MULTISELECT fields must have at least one option.',
      );
    }
    const created = await prisma.customFieldDefinition.create({
      data: {
        clientId: input.clientId ?? null,
        entityType: input.entityType,
        key: input.key,
        label: input.label,
        type: input.type,
        isRequired: input.isRequired ?? false,
        isSensitive: input.isSensitive ?? false,
        helpText: input.helpText ?? null,
        options: input.options
          ? (input.options as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        displayOrder: input.displayOrder ?? 0,
      },
    });
    res.status(201).json({ id: created.id });
  },
);

customFieldsRouter.put(
  '/definitions/:id',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const input = DefinitionInputSchema.partial().parse(req.body);
    const existing = await prisma.customFieldDefinition.findUnique({
      where: { id },
    });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Definition not found.');
    }
    const updated = await prisma.customFieldDefinition.update({
      where: { id },
      data: {
        label: input.label ?? undefined,
        isRequired: input.isRequired ?? undefined,
        isSensitive: input.isSensitive ?? undefined,
        helpText: input.helpText === undefined ? undefined : input.helpText,
        options:
          input.options === undefined
            ? undefined
            : input.options === null
              ? Prisma.JsonNull
              : (input.options as Prisma.InputJsonValue),
        displayOrder: input.displayOrder ?? undefined,
      },
    });
    res.json({ id: updated.id });
  },
);

customFieldsRouter.delete(
  '/definitions/:id',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const existing = await prisma.customFieldDefinition.findUnique({
      where: { id },
    });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Definition not found.');
    }
    await prisma.customFieldDefinition.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  },
);

// ----- Per-entity values --------------------------------------------------

customFieldsRouter.get(
  '/values/:entityType/:entityId',
  VIEW,
  async (req: Request, res: Response) => {
    const entityType = req.params.entityType.toUpperCase() as
      | 'ASSOCIATE'
      | 'POSITION'
      | 'CLIENT';
    const entityId = req.params.entityId;
    if (!['ASSOCIATE', 'POSITION', 'CLIENT'].includes(entityType)) {
      throw new HttpError(400, 'invalid_entity', 'Invalid entity type.');
    }
    const values = await prisma.customFieldValue.findMany({
      take: 500,
      where: { entityType, entityId },
      include: { definition: true },
    });
    res.json({
      values: values.map((v) => ({
        definitionId: v.definitionId,
        key: v.definition.key,
        label: v.definition.label,
        type: v.definition.type,
        value: v.value,
      })),
    });
  },
);

const ValueUpdateSchema = z.object({
  values: z.array(
    z.object({
      definitionId: z.string().uuid(),
      value: z.unknown(),
    }),
  ),
});

customFieldsRouter.put(
  '/values/:entityType/:entityId',
  MANAGE,
  async (req: Request, res: Response) => {
    const entityType = req.params.entityType.toUpperCase() as
      | 'ASSOCIATE'
      | 'POSITION'
      | 'CLIENT';
    const entityId = req.params.entityId;
    if (!['ASSOCIATE', 'POSITION', 'CLIENT'].includes(entityType)) {
      throw new HttpError(400, 'invalid_entity', 'Invalid entity type.');
    }
    const input = ValueUpdateSchema.parse(req.body);
    await prisma.$transaction(async (tx) => {
      for (const item of input.values) {
        const def = await tx.customFieldDefinition.findUnique({
          where: { id: item.definitionId },
        });
        if (!def || def.deletedAt) continue;
        if (def.entityType !== entityType) {
          throw new HttpError(
            400,
            'entity_mismatch',
            `Definition ${item.definitionId} is not for ${entityType}.`,
          );
        }
        await tx.customFieldValue.upsert({
          where: {
            definitionId_entityId: {
              definitionId: item.definitionId,
              entityId,
            },
          },
          create: {
            definitionId: item.definitionId,
            entityType,
            entityId,
            value: { v: item.value } as Prisma.InputJsonValue,
          },
          update: {
            value: { v: item.value } as Prisma.InputJsonValue,
          },
        });
      }
    });
    res.json({ ok: true });
  },
);
