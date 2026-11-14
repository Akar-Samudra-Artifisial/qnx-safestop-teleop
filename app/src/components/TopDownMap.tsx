import { memo } from 'react';
import Svg, { G, Line, Polygon, Polyline, Rect } from 'react-native-svg';

import type { Pose } from '../protocol';
import type { TrailPoint } from '../net/teleopLink';
import { colors } from '../theme';

interface TopDownMapProps {
  /** Side length in pt (map is square). */
  size: number;
  pose: Pose | null;
  trail: TrailPoint[];
  /** World extent in metres; world origin is the map centre. */
  extentM?: number;
}

/** 10×10 m top-down view; +x right, +y up, theta CCW from +x. */
function TopDownMap({ size, pose, trail, extentM = 10 }: TopDownMapProps) {
  const half = extentM / 2;
  const s = size / extentM; // pt per metre
  const toPx = (x: number, y: number) => `${((x + half) * s).toFixed(1)},${((half - y) * s).toFixed(1)}`;

  const grid = [];
  for (let i = 0; i <= extentM; i++) {
    const p = i * s;
    const major = i === half;
    const stroke = major ? colors.border : colors.grid;
    grid.push(
      <Line key={`v${i}`} x1={p} y1={0} x2={p} y2={size} stroke={stroke} strokeWidth={1} />,
      <Line key={`h${i}`} x1={0} y1={p} x2={size} y2={p} stroke={stroke} strokeWidth={1} />,
    );
  }

  const robotLen = 0.5 * s;
  const robotW = 0.36 * s;

  return (
    <Svg
      width={size}
      height={size}
      accessibilityLabel={
        pose
          ? `Map. Robot at x ${pose.x.toFixed(1)} metres, y ${pose.y.toFixed(1)} metres`
          : 'Map. No robot pose yet'
      }
    >
      <Rect x={0} y={0} width={size} height={size} fill={colors.surface} />
      {grid}
      {trail.length > 1 && (
        <Polyline
          points={trail.map((p) => toPx(p.x, p.y)).join(' ')}
          fill="none"
          stroke={colors.trail}
          strokeWidth={2}
          strokeOpacity={0.7}
          strokeLinejoin="round"
        />
      )}
      {pose && (
        <G
          transform={`translate(${(pose.x + half) * s} ${(half - pose.y) * s}) rotate(${(-pose.theta * 180) / Math.PI})`}
        >
          <Polygon
            points={`${robotLen * 0.6},0 ${-robotLen * 0.4},${robotW / 2} ${-robotLen * 0.4},${-robotW / 2}`}
            fill={colors.text}
            stroke={colors.bg}
            strokeWidth={1.5}
          />
        </G>
      )}
    </Svg>
  );
}

export default memo(TopDownMap);
