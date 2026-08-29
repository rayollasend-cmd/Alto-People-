import {
  Beef,
  BookOpen,
  Croissant,
  FileText,
  Flag,
  Megaphone,
  Package,
  ShoppingBasket,
  Snowflake,
  Star,
  Store,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { OpsHandoverKind } from '@/lib/opsApi';

/**
 * Shared visual identity for the Store Ops module — one dialect across
 * the runner, the board, and the library so a department always wears
 * the same face everywhere.
 */

export const DEPT_ICON: Record<string, LucideIcon> = {
  'Frozen & Dairy': Snowflake,
  'Meat & Produce': Beef,
  'Deli & Bakery': Croissant,
  'Food & Consumables': ShoppingBasket,
  'General Merchandise': Store,
};
export const DEPT_FALLBACK_ICON: LucideIcon = BookOpen;

export const DEPT_TONE: Record<string, string> = {
  'Frozen & Dairy': 'text-sky',
  'Meat & Produce': 'text-alert',
  'Deli & Bakery': 'text-gold',
  'Food & Consumables': 'text-success',
  'General Merchandise': 'text-teal',
};

export const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};

export const HANDOVER_KIND_LABEL: Record<OpsHandoverKind, string> = {
  NOTE: 'Note',
  UNFINISHED_TASK: 'Unfinished task',
  SPECIAL_ORDER: 'Special order',
  COACH_COMPLAINT: 'Walmart coach complaint',
  EQUIPMENT: 'Equipment problem',
  STOCKING: 'Stocking issue',
};

export const HANDOVER_KIND_ICON: Record<OpsHandoverKind, LucideIcon> = {
  NOTE: FileText,
  UNFINISHED_TASK: Flag,
  SPECIAL_ORDER: Star,
  COACH_COMPLAINT: Megaphone,
  EQUIPMENT: Wrench,
  STOCKING: Package,
};
