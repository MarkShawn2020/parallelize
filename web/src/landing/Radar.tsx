import { RADAR_AXES } from "../paradigms";

export interface RadarSeries {
  label: string;
  values: readonly number[];
  /** Full class strings so Tailwind's scanner sees them. */
  stroke: string;
  fill: string;
}

interface Props {
  series: readonly RadarSeries[];
  size?: number;
  /** Axis names around the chart; off for small multiples. */
  labels?: boolean;
}

const C = 100;
const R = 78;

function point(i: number, v: number, n: number): [number, number] {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [C + R * (v / 100) * Math.cos(a), C + R * (v / 100) * Math.sin(a)];
}

export function Radar({ series, size = 240, labels = true }: Props) {
  const n = RADAR_AXES.length;
  const ring = (k: number) =>
    Array.from({ length: n }, (_, i) => point(i, k * 100, n))
      .map(([x, y]) => `${x},${y}`)
      .join(" ");
  const aria = series.map((s) => `${s.label}：${RADAR_AXES.map((a, i) => `${a} ${Math.round(s.values[i] ?? 0)}`).join("、")}`).join("；");
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={aria}>
        {[0.25, 0.5, 0.75, 1].map((k) => (
          <polygon key={k} points={ring(k)} className="fill-none stroke-grid" strokeWidth={1.5} />
        ))}
        {RADAR_AXES.map((a, i) => {
          const [x, y] = point(i, 100, n);
          return <line key={a} x1={C} y1={C} x2={x} y2={y} className="stroke-grid" strokeWidth={1.5} />;
        })}
        {series.map((s) => (
          <polygon
            key={s.label}
            points={s.values.map((v, i) => point(i, v, n).join(",")).join(" ")}
            className={`${s.fill} ${s.stroke}`}
            strokeWidth={3}
            strokeLinejoin="round"
          />
        ))}
      </svg>
      {labels &&
        RADAR_AXES.map((a, i) => {
          // Just past the spoke's tip, with the label box pushed outward along the same direction.
          const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          const [x, y] = point(i, 108, n);
          return (
            <span
              key={a}
              className="absolute text-sm whitespace-nowrap text-muted"
              style={{
                left: `${x / 2}%`,
                top: `${y / 2}%`,
                transform: `translate(${-50 + 50 * Math.cos(angle)}%, ${-50 + 50 * Math.sin(angle)}%)`,
              }}
            >
              {a}
            </span>
          );
        })}
    </div>
  );
}
