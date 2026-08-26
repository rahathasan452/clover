import React, { useEffect, useRef } from 'react';
import { BBox } from '../../types/search';
import { bboxToPercentStyle } from '../../utils/bboxUtils';

interface BBoxHighlightOverlayProps {
  bboxes: BBox[];
  isActivePage?: boolean;
}

export function BBoxHighlightOverlay({ bboxes, isActivePage = false }: BBoxHighlightOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll first bbox into center of view
  useEffect(() => {
    if (bboxes.length > 0 && containerRef.current && isActivePage) {
      const timer = setTimeout(() => {
        const firstBox = containerRef.current?.querySelector('.bbox-highlight');
        if (firstBox) {
          firstBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [isActivePage, bboxes]);

  if (!bboxes || bboxes.length === 0) return null;

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-30">
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
