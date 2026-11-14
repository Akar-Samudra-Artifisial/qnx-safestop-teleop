import Svg, { Polygon, Rect } from 'react-native-svg';

import { colors } from '../theme';

/** Product mark: a stop octagon with a bar — the app exists to stop the robot safely. */
export default function BrandMark({ size = 28 }: { size?: number }) {
  const k = size * 0.2929; // octagon corner cut = (1 - 1/√2) · size
  const pts = [
    [k, 0], [size - k, 0], [size, k], [size, size - k],
    [size - k, size], [k, size], [0, size - k], [0, k],
  ]
    .map((p) => p.join(','))
    .join(' ');
  return (
    // Decorative: no accessibilityLabel, so screen readers skip it.
    <Svg width={size} height={size}>
      <Polygon points={pts} fill={colors.dangerFill} />
      <Rect x={size * 0.22} y={size * 0.42} width={size * 0.56} height={size * 0.16} rx={1.5} fill={colors.onDanger} />
    </Svg>
  );
}
