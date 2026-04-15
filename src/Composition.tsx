import type {CSSProperties, ReactNode} from "react";
import {Easing, interpolate, interpolateColors, spring, useCurrentFrame, useVideoConfig} from "remotion";
import type {BatchBoardProps, MyCompositionProps} from "./types/batch-task";

const ICONS = [HomeIcon, SearchIcon, BellIcon, UserIcon] as const;
const STEPS = [0, 1, 2, 3, 0] as const;

const BAR_HEIGHT = 136;
const DOT_SIZE = 14;
const BASE_PADDING = 42;
const BASE_STAGE_WIDTH = 1920;
const BASE_STAGE_HEIGHT = 1080;

const DEFAULT_BOARD: BatchBoardProps = {
  columnName: "Kolom Produksi",
  listName: "List Utama",
  itemTitle: "Intro Motion",
  itemContent: "Batch renderer akan memproses item dari atas ke bawah secara otomatis.",
  itemIndex: 1,
  totalItems: 4,
  items: ["Intro Motion", "Scene Produk", "Highlight CTA", "Outro Brand"],
};

const normalizeBoard = (incoming?: Partial<BatchBoardProps>): BatchBoardProps => {
  const merged = {
    ...DEFAULT_BOARD,
    ...incoming,
  };

  const normalizedItems =
    merged.items.length > 0
      ? merged.items
      : Array.from({length: Math.max(1, merged.totalItems)}, (_, index) => `Item ${index + 1}`);

  const normalizedTotal = Math.max(1, merged.totalItems || normalizedItems.length);
  const normalizedIndex = Math.min(Math.max(1, merged.itemIndex || 1), normalizedTotal);

  return {
    ...merged,
    items: normalizedItems,
    totalItems: normalizedTotal,
    itemIndex: normalizedIndex,
  };
};

const getAnimationState = (frame: number, fps: number) => {
  const startHoldFrames = Math.round(fps * 0.45);
  const moveFrames = Math.round(fps * 0.5);
  const holdFrames = Math.round(fps * 0.35);
  const segmentFrames = moveFrames + holdFrames;
  const cycleFrames = startHoldFrames + (STEPS.length - 1) * segmentFrames;
  const cycleFrame = frame % cycleFrames;

  if (cycleFrame < startHoldFrames) {
    return {
      indicator: STEPS[0],
      targetIndex: STEPS[0],
      segmentProgress: 0,
      isMoving: false,
    };
  }

  const shiftedFrame = cycleFrame - startHoldFrames;
  const segmentIndex = Math.floor(shiftedFrame / segmentFrames);
  const frameInSegment = shiftedFrame % segmentFrames;
  const from = STEPS[segmentIndex];
  const to = STEPS[segmentIndex + 1];

  if (frameInSegment <= moveFrames) {
    const timing = interpolate(frameInSegment, [0, moveFrames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    });

    return {
      indicator: interpolate(timing, [0, 1], [from, to]),
      targetIndex: to,
      segmentProgress: timing,
      isMoving: true,
    };
  }

  return {
    indicator: to,
    targetIndex: to,
    segmentProgress: 1,
    isMoving: false,
  };
};

export const MyComposition = ({board: boardProps}: MyCompositionProps) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const board = normalizeBoard(boardProps);
  const scaleX = width / BASE_STAGE_WIDTH;
  const scaleY = height / BASE_STAGE_HEIGHT;

  const {indicator, targetIndex, segmentProgress, isMoving} = getAnimationState(frame, fps);
  const panelIn = spring({
    fps,
    frame,
    config: {
      damping: 16,
      mass: 0.9,
      stiffness: 140,
    },
  });
  const panelShift = interpolate(panelIn, [0, 1], [48, 0]);
  const panelOpacity = interpolate(panelIn, [0, 1], [0, 1]);

  const barWidth = Math.min(1300, Math.max(620, width * 0.33));
  const horizontalPadding = Math.max(BASE_PADDING, barWidth * 0.06);
  const slotWidth = (barWidth - horizontalPadding * 2) / ICONS.length;
  const dotLeft = horizontalPadding + indicator * slotWidth + slotWidth / 2 - DOT_SIZE / 2;
  const listPreview = board.items.slice(0, 6);

  return (
    <div style={styles.screen}>
      <div
        style={{
          ...styles.stage,
          transform: `scale(${scaleX}, ${scaleY})`,
        }}
      >
      <div style={styles.glowOne} />
      <div style={styles.glowTwo} />

      <div
        style={{
          ...styles.panelWrapper,
          transform: `translateY(${panelShift}px)`,
          opacity: panelOpacity,
        }}
      >
        <div style={styles.panelCard}>
          <div style={styles.panelBadgeRow}>
            <span style={styles.badgePrimary}>Kolom: {board.columnName}</span>
            <span style={styles.badgeSecondary}>List: {board.listName}</span>
          </div>

          <div style={styles.mainTitle}>{board.itemTitle}</div>
          <div style={styles.mainDescription}>{board.itemContent}</div>

          <div style={styles.progressLabel}>
            Item {board.itemIndex} / {board.totalItems}
          </div>

          <div style={styles.itemsContainer}>
            {listPreview.map((item, index) => {
              const itemNumber = index + 1;
              const isActive = itemNumber === board.itemIndex;

              return (
                <div
                  key={`${item}-${itemNumber}`}
                  style={{
                    ...styles.itemRow,
                    ...(isActive ? styles.itemRowActive : null),
                  }}
                >
                  <div style={{...styles.itemIndex, ...(isActive ? styles.itemIndexActive : null)}}>
                    {itemNumber}
                  </div>
                  <div style={styles.itemText}>{item}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={styles.navWrapper}>
        <div
          style={{
            ...styles.navBar,
            width: barWidth,
            height: BAR_HEIGHT,
            paddingLeft: horizontalPadding,
            paddingRight: horizontalPadding,
          }}
        >
          {ICONS.map((Icon, index) => {
            const activeAmount = Math.max(0, 1 - Math.abs(indicator - index));
            const isTarget = targetIndex === index;
            const iconColor = interpolateColors(activeAmount, [0, 1], ["#77819a", "#00efbf"]);
            const clickPulse =
              isTarget && isMoving
                ? spring({
                    fps,
                    frame: Math.round(segmentProgress * fps * 0.5),
                    config: {
                      damping: 16,
                      stiffness: 170,
                      mass: 0.75,
                    },
                  })
                : 0;
            const scale = 1 + activeAmount * 0.09 + clickPulse * 0.05;

            return (
              <div
                key={index}
                style={{
                  ...styles.iconSlot,
                  width: slotWidth,
                  color: iconColor,
                  transform: `scale(${scale})`,
                }}
              >
                <Icon />
              </div>
            );
          })}

          <div
            style={{
              ...styles.dot,
              left: dotLeft,
            }}
          />
        </div>
      </div>
      </div>
    </div>
  );
};

const IconShell = ({children}: {children: ReactNode}) => {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{width: 40, height: 40}}
    >
      {children}
    </svg>
  );
};

function HomeIcon() {
  return (
    <IconShell>
      <path d="M4.8 11.8 12 5.8l7.2 6" />
      <path d="M6.6 10.9V19h10.8v-8.1" />
      <path d="M10.2 19v-4.9h3.6V19" />
    </IconShell>
  );
}

function SearchIcon() {
  return (
    <IconShell>
      <circle cx="10.5" cy="10.5" r="5.6" />
      <path d="m14.7 14.7 4.5 4.5" />
    </IconShell>
  );
}

function BellIcon() {
  return (
    <IconShell>
      <path d="M8.3 9.2a3.7 3.7 0 1 1 7.4 0v2.1c0 1.2.4 2.4 1.2 3.3l.8.9H6.3l.8-.9c.8-.9 1.2-2.1 1.2-3.3V9.2Z" />
      <path d="M10.1 17.5a2 2 0 0 0 3.8 0" />
    </IconShell>
  );
}

function UserIcon() {
  return (
    <IconShell>
      <circle cx="12" cy="9" r="3.2" />
      <path d="M5.8 18.4a6.3 6.3 0 0 1 12.4 0" />
    </IconShell>
  );
}

const styles: Record<string, CSSProperties> = {
  screen: {
    flex: 1,
    background: "#0f1826",
    position: "relative",
    overflow: "hidden",
  },
  stage: {
    width: BASE_STAGE_WIDTH,
    height: BASE_STAGE_HEIGHT,
    position: "absolute",
    top: 0,
    left: 0,
    transformOrigin: "top left",
    background:
      "radial-gradient(80% 110% at 80% 10%, #163b54 0%, rgba(22, 59, 84, 0) 52%), linear-gradient(145deg, #0f1826 0%, #18263a 50%, #0f1926 100%)",
    fontFamily: "'Trebuchet MS', 'Segoe UI', sans-serif",
  },
  glowOne: {
    position: "absolute",
    width: 460,
    height: 460,
    borderRadius: 999,
    left: -150,
    top: -120,
    background: "radial-gradient(circle, rgba(41, 214, 169, 0.24) 0%, rgba(41, 214, 169, 0) 70%)",
  },
  glowTwo: {
    position: "absolute",
    width: 520,
    height: 520,
    borderRadius: 999,
    right: -180,
    bottom: -260,
    background: "radial-gradient(circle, rgba(44, 113, 255, 0.2) 0%, rgba(44, 113, 255, 0) 72%)",
  },
  panelWrapper: {
    position: "absolute",
    left: 220,
    top: 170,
  },
  panelCard: {
    width: 1240,
    borderRadius: 34,
    border: "1px solid rgba(255,255,255,0.11)",
    background:
      "linear-gradient(165deg, rgba(21,31,49,0.96) 0%, rgba(13,21,35,0.93) 100%)",
    boxShadow: "0 28px 60px rgba(3,10,19,0.45), inset 0 1px 0 rgba(255,255,255,0.1)",
    padding: "48px 52px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  panelBadgeRow: {
    display: "flex",
    gap: 14,
    alignItems: "center",
  },
  badgePrimary: {
    fontSize: 30,
    fontWeight: 700,
    color: "#0f1725",
    background: "linear-gradient(90deg, #00efbf 0%, #58f5cf 100%)",
    borderRadius: 999,
    padding: "10px 18px",
  },
  badgeSecondary: {
    fontSize: 28,
    fontWeight: 600,
    color: "#9cc6ff",
    background: "rgba(56, 113, 196, 0.25)",
    borderRadius: 999,
    border: "1px solid rgba(118, 178, 255, 0.28)",
    padding: "9px 18px",
  },
  mainTitle: {
    color: "#f4f8ff",
    fontSize: 68,
    lineHeight: 1.08,
    fontWeight: 800,
    letterSpacing: 0.4,
  },
  mainDescription: {
    color: "#adc3e8",
    fontSize: 34,
    lineHeight: 1.4,
    maxWidth: 1080,
  },
  progressLabel: {
    marginTop: 8,
    color: "#6beccc",
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: 0.5,
  },
  itemsContainer: {
    marginTop: 6,
    display: "flex",
    flexDirection: "column",
    gap: 11,
  },
  itemRow: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "12px 14px",
    borderRadius: 16,
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.05)",
  },
  itemRowActive: {
    background: "linear-gradient(95deg, rgba(0,239,191,0.18) 0%, rgba(0,239,191,0.04) 100%)",
    border: "1px solid rgba(0,239,191,0.42)",
  },
  itemIndex: {
    width: 40,
    height: 40,
    borderRadius: 999,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    color: "#98aac8",
    fontSize: 22,
    fontWeight: 700,
    background: "rgba(22,35,55,0.9)",
  },
  itemIndexActive: {
    color: "#0f1725",
    background: "#00efbf",
  },
  itemText: {
    color: "#d4dff2",
    fontSize: 26,
    lineHeight: 1.25,
    fontWeight: 500,
  },
  navWrapper: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 80,
    display: "flex",
    justifyContent: "center",
  },
  navBar: {
    borderRadius: 40,
    border: "1px solid rgba(255,255,255,0.1)",
    background:
      "linear-gradient(160deg, rgba(22,32,49,0.96) 0%, rgba(12,20,34,0.96) 100%)",
    boxShadow: "0 26px 52px rgba(3, 8, 18, 0.54), inset 0 1px 0 rgba(255,255,255,0.11)",
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  iconSlot: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    transformOrigin: "50% 50%",
  },
  dot: {
    position: "absolute",
    bottom: 18,
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: 999,
    background: "#00efbf",
    boxShadow: "0 0 16px rgba(0, 239, 191, 0.95)",
  },
};
