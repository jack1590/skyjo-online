import type { ViewSlot } from "../engine/view";
import back from "./art/back.webp";
import high from "./art/band-high.webp";
import low from "./art/band-low.webp";
import mid from "./art/band-mid.webp";
import neg from "./art/band-neg.webp";
import zero from "./art/band-zero.webp";
import { useI18n } from "./i18n";

function art(card: number): string {
  if (card < 0) return neg;
  if (card === 0) return zero;
  if (card <= 4) return low;
  return card <= 8 ? mid : high;
}

/** Real minus sign so "−2" reads clearly at small sizes. */
export const formatCard = (card: number) => (card < 0 ? `−${-card}` : String(card));

interface CardProps {
  slot: ViewSlot;
  size: "sm" | "md" | "lg";
  /** Describes where the card is, e.g. "row 1, column 2". */
  label: string;
  onClick?: () => void;
  highlight?: boolean;
  testId?: string;
  /** Registers the element so moves can be animated from/to it. */
  cardRef?: (el: HTMLElement | null) => void;
  /** Tapped, lifted until the server answers (UX-3). */
  pending?: boolean;
  /** Lies tilted this many degrees (UX-19's thrown card); motion.ts measures it as if straight. */
  tilt?: number;
}

export function Card({
  slot,
  size,
  label,
  onClick,
  highlight,
  testId,
  cardRef,
  pending,
  tilt,
}: CardProps) {
  const { t } = useI18n();
  const face = slot === null ? "gone" : slot === "down" ? "down" : "up";
  const description =
    slot === null
      ? t("empty", { label })
      : slot === "down"
        ? t("faceDown", { label })
        : `${label}: ${formatCard(slot)}`;
  const attrs = {
    className: `card ${size} ${face}${highlight ? " hl" : ""}`,
    style: {
      backgroundImage: slot === null ? undefined : `url(${slot === "down" ? back : art(slot)})`,
      rotate: tilt ? `${tilt}deg` : undefined,
    },
    "data-face": face,
    "data-testid": testId,
    "data-pending": pending || undefined,
    "data-tilt": tilt || undefined,
    "aria-label": description,
  };
  const content = typeof slot === "number" ? <span className="num">{formatCard(slot)}</span> : null;
  return onClick ? (
    <button type="button" {...attrs} ref={cardRef} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span role="img" {...attrs} ref={cardRef}>
      {content}
    </span>
  );
}
