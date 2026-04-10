/**
 * @file BrandLogo.tsx
 * @description Reusable brand mark and lockup for GetChat.
 *
 * The desktop shell uses one canonical logo component so favicon assets,
 * startup states, navigation chrome, and empty states stay visually aligned.
 */

import brandLogoUrl from "../../assets/brand/getchat-logo.svg";

interface BrandLogoProps {
  /** Whether to render the icon alone or together with the wordmark. */
  variant?: "icon" | "lockup";
  /** Pixel size of the SVG icon. */
  size?: number;
  /** Optional subtitle shown below the product name in lockup mode. */
  subtitle?: string;
  /** Optional wrapper class name. */
  className?: string;
  /** Optional icon wrapper class name. */
  iconWrapperClassName?: string;
  /** Optional icon image class name. */
  iconClassName?: string;
  /** Optional title class name. */
  titleClassName?: string;
  /** Optional subtitle class name. */
  subtitleClassName?: string;
}

/** Canonical GetChat logo component used across the desktop shell. */
export function BrandLogo({
  variant = "icon",
  size = 32,
  subtitle,
  className,
  iconWrapperClassName,
  iconClassName,
  titleClassName,
  subtitleClassName,
}: BrandLogoProps) {
  const icon = (
    <span
      className={["flex shrink-0 items-center justify-center", iconWrapperClassName]
        .filter(Boolean)
        .join(" ")}
    >
      <img
        src={brandLogoUrl}
        alt="GetChat"
        width={size}
        height={size}
        className={["block shrink-0", iconClassName].filter(Boolean).join(" ")}
        style={{ width: size, height: size }}
      />
    </span>
  );

  if (variant === "icon") {
    return icon;
  }

  return (
    <div className={["flex min-w-0 items-center gap-3", className].filter(Boolean).join(" ")}>
      {icon}
      <div className="min-w-0">
        <div
          className={[
            "truncate font-display text-lg font-black tracking-[-0.04em] text-miro-text",
            titleClassName,
          ]
            .filter(Boolean)
            .join(" ")}
        >
          GetChat
        </div>
        {subtitle ? (
          <div
            className={[
              "truncate text-[10px] font-semibold uppercase tracking-[0.22em] text-miro-text-secondary",
              subtitleClassName,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
}
