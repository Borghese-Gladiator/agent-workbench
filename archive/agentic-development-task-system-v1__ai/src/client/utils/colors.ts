import type { EpicColor } from "@shared/types";

const EPIC_COLOR_MAP: Record<EpicColor, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  purple: '#a855f7',
  orange: '#f97316',
  pink: '#ec4899',
  cyan: '#06b6d4',
};

export function epicColorToCss(color: EpicColor | string | undefined): string {
  return EPIC_COLOR_MAP[(color as EpicColor) ?? 'blue'] ?? EPIC_COLOR_MAP.blue;
}
