/** Common wire types shared between the API and the web client. */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  companies: { id: string; name: string; role: string }[];
}

/** A 2D point in normalized sheet coordinates (0..1 on both axes). */
export interface SheetPoint {
  x: number;
  y: number;
}

/**
 * Drawing markup shape — persisted as JSON on markup records. Coordinates are
 * normalized to the sheet so markups survive re-rendering at any resolution.
 */
export type MarkupShape =
  | { kind: "pen"; points: SheetPoint[]; color: string; width: number }
  | { kind: "line"; from: SheetPoint; to: SheetPoint; color: string; width: number }
  | { kind: "arrow"; from: SheetPoint; to: SheetPoint; color: string; width: number }
  | { kind: "rect"; from: SheetPoint; to: SheetPoint; color: string; width: number }
  | { kind: "ellipse"; from: SheetPoint; to: SheetPoint; color: string; width: number }
  | { kind: "cloud"; from: SheetPoint; to: SheetPoint; color: string; width: number }
  | { kind: "text"; at: SheetPoint; text: string; color: string; fontSize: number }
  | {
      kind: "measure";
      from: SheetPoint;
      to: SheetPoint;
      color: string;
      width: number;
      /** measured length in real-world units, computed from sheet calibration */
      value?: number;
      unit?: string;
    };

/** Sheet calibration: a known real-world distance between two sheet points. */
export interface SheetCalibration {
  from: SheetPoint;
  to: SheetPoint;
  realDistance: number;
  unit: string;
}

/** Location path rendered as "Building A > Level 3 > Zone 2 > Room 301". */
export interface LocationNode {
  id: string;
  name: string;
  parentId: string | null;
  children?: LocationNode[];
}
