import { BBox } from '../types/search';
import React from 'react';

export function bboxToPercentStyle(bbox: BBox): React.CSSProperties {
  const [x0, y0, x1, y1] = bbox;
  const left = Math.max(0, Math.min(100, x0 * 100));
  const top = Math.max(0, Math.min(100, y0 * 100));
  const width = Math.max(0.5, Math.min(100 - left, (x1 - x0) * 100));
  const height = Math.max(0.5, Math.min(100 - top, (y1 - y0) * 100));

  return {
    left: `${left}%`,
    top: `${top}%`,
    width: `${width}%`,
    height: `${height}%`,
  };
}
