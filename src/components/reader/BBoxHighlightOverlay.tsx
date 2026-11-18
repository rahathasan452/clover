import React from 'react';
import { BBox } from '../../types/search';
import { bboxToPercentStyle } from '../../utils/bboxUtils';

interface BBoxHighlightOverlayProps {
  bboxes: BBox[];
  isActivePage?: boolean;
}

export function BBoxHighlightOverlay({ bboxes }: BBoxHighlightOverlayProps) {
  if (!bboxes || bboxes.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-30">
      {bboxes.map((bbox, i) => (
        <div
          key={i}
          className="bbox-highlight"
          style={bboxToPercentStyle(bbox)}
          title="Search Match (OCR Bounding Box)"
        />
      ))}
    </div>
  );
}
