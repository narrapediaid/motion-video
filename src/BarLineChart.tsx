import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];

const REVENUE = [8000, 12000, 15000, 11000, 18000, 22000];

const CONVERSION = [2.1, 2.8, 3.2, 2.9, 3.8, 4.2];

const BAR_COLOR_START = "#4F46E5";
const BAR_COLOR_END = "#7C3AED";
const LINE_COLOR = "#0B84F3";
const AXIS_COLOR = "#3A3A5C";
const LABEL_COLOR = "#A0AEC0";
const GRID_COLOR = "#2A2A4A";
const BACKGROUND = "#1A1A2E";

const CHART_LEFT = 120;
const CHART_RIGHT = 1760;
const CHART_TOP = 160;
const CHART_BOTTOM = 860;
const CHART_WIDTH = CHART_RIGHT - CHART_LEFT;
const CHART_HEIGHT = CHART_BOTTOM - CHART_TOP;

const BAR_GROUP_WIDTH = CHART_WIDTH / MONTHS.length;
const BAR_WIDTH = BAR_GROUP_WIDTH * 0.45;

const MAX_REVENUE = 25000;
const MIN_CONVERSION = 1.5;
const MAX_CONVERSION = 5.0;

function revenueToY(value: number): number {
  return CHART_BOTTOM - (value / MAX_REVENUE) * CHART_HEIGHT;
}

function conversionToY(value: number): number {
  const ratio = (value - MIN_CONVERSION) / (MAX_CONVERSION - MIN_CONVERSION);
  return CHART_BOTTOM - ratio * CHART_HEIGHT;
}

function barX(index: number): number {
  return CHART_LEFT + index * BAR_GROUP_WIDTH + BAR_GROUP_WIDTH / 2 - BAR_WIDTH / 2;
}

function barCenterX(index: number): number {
  return CHART_LEFT + index * BAR_GROUP_WIDTH + BAR_GROUP_WIDTH / 2;
}

function formatRevenue(value: number): string {
  return `$${(value / 1000).toFixed(0)}K`;
}

export const BarLineChart: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Title fade in
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [0, 20], [-30, 0], {
    extrapolateRight: "clamp",
  });

  // Axes fade in
  const axisOpacity = interpolate(frame, [10, 30], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Grid lines
  const gridOpacity = interpolate(frame, [15, 35], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Bar animations — each bar starts 8 frames apart, with slight overlap
  const barSprings = REVENUE.map((_, i) => {
    const delay = 20 + i * 8;
    return spring({
      frame: frame - delay,
      fps,
      config: {
        damping: 14,
        stiffness: 100,
        mass: 0.8,
      },
    });
  });

  // Line point progressions — line follows after bars
  const lineDelay = 50;
  const lineProgress = CONVERSION.map((_, i) => {
    const delay = lineDelay + i * 10;
    return spring({
      frame: frame - delay,
      fps,
      config: {
        damping: 18,
        stiffness: 80,
        mass: 0.6,
      },
    });
  });

  // Pulsing dot
  const pulseScale = interpolate(
    Math.sin((frame / fps) * Math.PI * 2),
    [-1, 1],
    [0.8, 1.4]
  );
  const lastLineProgress = lineProgress[lineProgress.length - 1];
  const dotOpacity = interpolate(lastLineProgress, [0.5, 1], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Build SVG line path progressively
  const linePoints = CONVERSION.map((val, i) => ({
    x: barCenterX(i),
    y: conversionToY(val),
    progress: lineProgress[i],
  }));

  // Build path segments
  function buildLinePath(): string {
    let path = "";
    for (let i = 0; i < linePoints.length; i++) {
      const p = lineProgress[i];
      if (p <= 0) break;

      if (i === 0) {
        path += `M ${linePoints[0].x} ${linePoints[0].y} `;
      } else {
        const prev = linePoints[i - 1];
        const curr = linePoints[i];
        const px = interpolate(p, [0, 1], [prev.x, curr.x]);
        const py = interpolate(p, [0, 1], [prev.y, curr.y]);

        // Smooth cubic bezier
        const cpx1 = prev.x + (curr.x - prev.x) * 0.5;
        const cpy1 = prev.y;
        const cpx2 = curr.x - (curr.x - prev.x) * 0.5;
        const cpy2 = curr.y;

        if (p < 1) {
          path += `C ${cpx1} ${cpy1} ${cpx2} ${cpy2} ${px} ${py} `;
        } else {
          path += `C ${cpx1} ${cpy1} ${cpx2} ${cpy2} ${curr.x} ${curr.y} `;
        }
      }
    }
    return path;
  }

  // Revenue Y axis labels
  const revenueGridValues = [0, 5000, 10000, 15000, 20000, 25000];

  // Last visible line tip
  let tipX = linePoints[0].x;
  let tipY = linePoints[0].y;
  for (let i = linePoints.length - 1; i >= 0; i--) {
    if (lineProgress[i] > 0) {
      if (i === 0) {
        tipX = linePoints[0].x;
        tipY = linePoints[0].y;
      } else {
        const prev = linePoints[i - 1];
        const curr = linePoints[i];
        tipX = interpolate(lineProgress[i], [0, 1], [prev.x, curr.x]);
        tipY = interpolate(lineProgress[i], [0, 1], [prev.y, curr.y]);
      }
      break;
    }
  }

  const linePath = buildLinePath();

  return (
    <div
      style={{
        width,
        height,
        background: BACKGROUND,
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Background ambient glow */}
      <div
        style={{
          position: "absolute",
          width: 800,
          height: 800,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(11,132,243,0.06) 0%, transparent 70%)",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
        }}
      />

      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 40,
          left: CHART_LEFT,
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
        }}
      >
        <div
          style={{
            fontSize: 36,
            fontWeight: 700,
            color: "#FFFFFF",
            letterSpacing: "-0.5px",
          }}
        >
          Monthly Sales Performance
        </div>
        <div
          style={{
            fontSize: 18,
            color: LABEL_COLOR,
            marginTop: 6,
            fontWeight: 400,
          }}
        >
          Revenue & Conversion Rate — Jan to Jun 2024
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          position: "absolute",
          top: 50,
          right: 100,
          display: "flex",
          gap: 32,
          opacity: titleOpacity,
        }}
      >
        {/* Revenue legend */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              background: "linear-gradient(180deg, #4F46E5, #7C3AED)",
            }}
          />
          <span style={{ color: LABEL_COLOR, fontSize: 16, fontWeight: 500 }}>
            Revenue
          </span>
        </div>
        {/* Conversion legend */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 28,
              height: 3,
              borderRadius: 2,
              background: LINE_COLOR,
              boxShadow: `0 0 8px ${LINE_COLOR}`,
            }}
          />
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: LINE_COLOR,
              boxShadow: `0 0 6px ${LINE_COLOR}`,
            }}
          />
          <span style={{ color: LABEL_COLOR, fontSize: 16, fontWeight: 500 }}>
            Conversion Rate
          </span>
        </div>
      </div>

      {/* SVG Chart */}
      <svg
        width={width}
        height={height}
        style={{ position: "absolute", top: 0, left: 0 }}
       viewBox="0 0 1920 1080">
        <defs>
          {/* Bar gradient */}
          <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BAR_COLOR_START} stopOpacity={1} />
            <stop offset="100%" stopColor={BAR_COLOR_END} stopOpacity={0.7} />
          </linearGradient>

          {/* Bar hover gradient (lighter) */}
          <linearGradient id="barGradHover" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366F1" stopOpacity={1} />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0.8} />
          </linearGradient>

          {/* Line glow filter */}
          <filter id="lineGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Dot glow filter */}
          <filter id="dotGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="6" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Bar shadow */}
          <filter id="barShadow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow
              dx="0"
              dy="4"
              stdDeviation="6"
              floodColor={BAR_COLOR_START}
              floodOpacity={0.4}
            />
          </filter>
        </defs>

        {/* Grid lines */}
        {revenueGridValues.map((val, i) => {
          const y = revenueToY(val);
          return (
            <g key={i} opacity={gridOpacity}>
              <line
                x1={CHART_LEFT}
                y1={y}
                x2={CHART_RIGHT}
                y2={y}
                stroke={GRID_COLOR}
                strokeWidth={1}
                strokeDasharray={val === 0 ? "none" : "6 4"}
              />
              {/* Y axis labels - Revenue */}
              <text
                x={CHART_LEFT - 12}
                y={y + 5}
                textAnchor="end"
                fill={LABEL_COLOR}
                fontSize={14}
                fontFamily="Inter, sans-serif"
              >
                {formatRevenue(val)}
              </text>
            </g>
          );
        })}

        {/* Conversion Y axis (right side) */}
        {[1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0].map((val, i) => {
          const y = conversionToY(val);
          return (
            <g key={i} opacity={gridOpacity}>
              <text
                x={CHART_RIGHT + 14}
                y={y + 5}
                textAnchor="start"
                fill={LINE_COLOR}
                fontSize={13}
                fontFamily="Inter, sans-serif"
                opacity={0.8}
              >
                {val.toFixed(1)}%
              </text>
            </g>
          );
        })}

        {/* X Axis baseline */}
        <line
          x1={CHART_LEFT}
          y1={CHART_BOTTOM}
          x2={CHART_RIGHT}
          y2={CHART_BOTTOM}
          stroke={AXIS_COLOR}
          strokeWidth={2}
          opacity={axisOpacity}
        />

        {/* Y Axis */}
        <line
          x1={CHART_LEFT}
          y1={CHART_TOP}
          x2={CHART_LEFT}
          y2={CHART_BOTTOM}
          stroke={AXIS_COLOR}
          strokeWidth={2}
          opacity={axisOpacity}
        />

        {/* Right Y Axis for conversion */}
        <line
          x1={CHART_RIGHT}
          y1={CHART_TOP}
          x2={CHART_RIGHT}
          y2={CHART_BOTTOM}
          stroke={LINE_COLOR}
          strokeWidth={1.5}
          opacity={axisOpacity * 0.5}
          strokeDasharray="4 4"
        />

        {/* Axis titles */}
        <text
          x={CHART_LEFT - 80}
          y={CHART_TOP + CHART_HEIGHT / 2}
          textAnchor="middle"
          fill={LABEL_COLOR}
          fontSize={15}
          fontFamily="Inter, sans-serif"
          transform={`rotate(-90, ${CHART_LEFT - 80}, ${CHART_TOP + CHART_HEIGHT / 2})`}
          opacity={axisOpacity}
        >
          Revenue (USD)
        </text>

        <text
          x={CHART_RIGHT + 80}
          y={CHART_TOP + CHART_HEIGHT / 2}
          textAnchor="middle"
          fill={LINE_COLOR}
          fontSize={15}
          fontFamily="Inter, sans-serif"
          transform={`rotate(90, ${CHART_RIGHT + 80}, ${CHART_TOP + CHART_HEIGHT / 2})`}
          opacity={axisOpacity * 0.9}
        >
          Conversion Rate (%)
        </text>

        {/* Bars */}
        {REVENUE.map((rev, i) => {
          const progress = barSprings[i];
          const fullBarHeight = CHART_BOTTOM - revenueToY(rev);
          const animatedHeight = fullBarHeight * progress;
          const x = barX(i);
          const y = CHART_BOTTOM - animatedHeight;
          const labelOpacity = interpolate(progress, [0.7, 1], [0, 1], {
            extrapolateRight: "clamp",
          });

          return (
            <g key={i}>
              {/* Bar glow background */}
              <rect
                x={x - 4}
                y={y - 4}
                width={BAR_WIDTH + 8}
                height={animatedHeight + 4}
                rx={8}
                fill={BAR_COLOR_START}
                opacity={0.15 * progress}
              />

              {/* Main bar */}
              <rect
                x={x}
                y={y}
                width={BAR_WIDTH}
                height={animatedHeight}
                rx={6}
                fill="url(#barGrad)"
                filter="url(#barShadow)"
              />

              {/* Bar top shine */}
              <rect
                x={x + 4}
                y={y}
                width={BAR_WIDTH - 8}
                height={Math.min(animatedHeight * 0.3, 30)}
                rx={4}
                fill="rgba(255,255,255,0.12)"
              />

              {/* Bar value label */}
              <text
                x={x + BAR_WIDTH / 2}
                y={y - 10}
                textAnchor="middle"
                fill="#FFFFFF"
                fontSize={15}
                fontWeight={600}
                fontFamily="Inter, sans-serif"
                opacity={labelOpacity}
              >
                {formatRevenue(rev)}
              </text>

              {/* Month label */}
              <text
                x={barCenterX(i)}
                y={CHART_BOTTOM + 30}
                textAnchor="middle"
                fill={LABEL_COLOR}
                fontSize={16}
                fontWeight={500}
                fontFamily="Inter, sans-serif"
                opacity={axisOpacity}
              >
                {MONTHS[i]}
              </text>
            </g>
          );
        })}

        {/* Line path (glow layer - thicker, blurred) */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#lineGlow)"
            opacity={0.5}
          />
        )}

        {/* Line path (main) */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Conversion data point dots */}
        {CONVERSION.map((val, i) => {
          const p = lineProgress[i];
          const dotOpacityLocal = interpolate(p, [0.8, 1], [0, 1], {
            extrapolateRight: "clamp",
          });
          const cx = barCenterX(i);
          const cy = conversionToY(val);

          // Only show for completed points (not the last/active tip)
          const isLast = i === CONVERSION.length - 1;
          if (isLast) return null;

          return (
            <g key={i} opacity={dotOpacityLocal}>
              <circle cx={cx} cy={cy} r={6} fill={LINE_COLOR} opacity={0.3} />
              <circle cx={cx} cy={cy} r={4} fill={LINE_COLOR} />
              <circle cx={cx} cy={cy} r={2} fill="#FFFFFF" />

              {/* Conversion label */}
              <text
                x={cx}
                y={cy - 16}
                textAnchor="middle"
                fill={LINE_COLOR}
                fontSize={13}
                fontWeight={600}
                fontFamily="Inter, sans-serif"
              >
                {val.toFixed(1)}%
              </text>
            </g>
          );
        })}

        {/* Pulsing tip dot */}
        <g opacity={dotOpacity}>
          {/* Outer pulse ring */}
          <circle
            cx={tipX}
            cy={tipY}
            r={14 * pulseScale}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={1.5}
            opacity={0.3 / pulseScale}
          />
          {/* Middle ring */}
          <circle
            cx={tipX}
            cy={tipY}
            r={9}
            fill={LINE_COLOR}
            opacity={0.25}
            filter="url(#dotGlow)"
          />
          {/* Inner dot */}
          <circle
            cx={tipX}
            cy={tipY}
            r={6}
            fill={LINE_COLOR}
            filter="url(#dotGlow)"
          />
          {/* White center */}
          <circle cx={tipX} cy={tipY} r={2.5} fill="#FFFFFF" />

          {/* Tooltip for tip value */}
          {(() => {
            // Find the current active value
            let activeVal = CONVERSION[0];
            for (let i = CONVERSION.length - 1; i >= 0; i--) {
              if (lineProgress[i] > 0) {
                if (i === 0) {
                  activeVal = CONVERSION[0];
                } else {
                  activeVal = interpolate(
                    lineProgress[i],
                    [0, 1],
                    [CONVERSION[i - 1], CONVERSION[i]]
                  );
                }
                break;
              }
            }
            return (
              <g>
                <rect
                  x={tipX - 32}
                  y={tipY - 42}
                  width={64}
                  height={26}
                  rx={6}
                  fill={LINE_COLOR}
                  opacity={0.9}
                />
                <text
                  x={tipX}
                  y={tipY - 24}
                  textAnchor="middle"
                  fill="#FFFFFF"
                  fontSize={13}
                  fontWeight={700}
                  fontFamily="Inter, sans-serif"
                >
                  {activeVal.toFixed(1)}%
                </text>
              </g>
            );
          })()}
        </g>

        {/* Frame counter (debug - remove in production) */}
        {/* <text x={20} y={30} fill="white" fontSize={12}>Frame: {frame}</text> */}
      </svg>

      {/* Bottom watermark / label */}
      <div
        style={{
          position: "absolute",
          bottom: 28,
          left: "50%",
          transform: "translateX(-50%)",
          color: LABEL_COLOR,
          fontSize: 14,
          opacity: 0.5,
          letterSpacing: "0.5px",
        }}
      >
        Sales Analytics Dashboard · 2024
      </div>
    </div>
  );
};
