/** Grenzen fuer Bereiche und Tische (Spezifikation §3.3). */
export const LABEL_MAX = 20;
export const SEATS_MAX = 99;
export const TABLE_SIZE_MIN = 20;
export const TABLE_SIZE_MAX = 1000;
export const ROTATION_MAX = 359;
export const AREA_SIZE_MIN = 400;
export const AREA_SIZE_MAX = 5000;
export const GRID_SIZE_MIN = 5;
export const GRID_SIZE_MAX = 100;
export const DECOR_MAX = 100;
/** Hoechstens so viele Punkte je Wand, Zone oder Umriss. */
export const SHAPE_POINTS_MAX = 100;
/** Wand (Linienzug) braucht 2, Zone und Umriss (Polygon) 3 Punkte. */
export const LINE_POINTS_MIN = 2;
export const POLYGON_POINTS_MIN = 3;
/** Wandstaerke in Einheiten. */
export const WALL_THICKNESS_MIN = 2;
export const WALL_THICKNESS_MAX = 100;
export const BULK_MAX = 100;

/** Mindestens ein Zeichen, keine Steuerzeichen. */
export const NO_CONTROL_CHARS = /^[^\p{Cc}]+$/u;

/** Gruppierungsschluessel einer Tischbezeichnung: `upper(trim(label))`. */
export function tableKey(label: string): string {
  return label.trim().toUpperCase();
}
