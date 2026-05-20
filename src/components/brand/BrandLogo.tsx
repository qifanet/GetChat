/**
 * @file BrandLogo.tsx
 * @description Reusable brand mark and lockup for GetChat.
 *
 * The desktop shell uses one canonical logo component so favicon assets,
 * startup states, navigation chrome, and empty states stay visually aligned.
 *
 * The SVG is inlined as a React component to avoid <img src> loading failures
 * that can occur in Tauri WebView2 (HMR invalidation, CSP, cold-start race).
 */

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
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        fill="none"
        role="img"
        aria-label="GetChat"
        width={size}
        height={size}
        className={["block shrink-0", iconClassName].filter(Boolean).join(" ")}
        style={{ width: size, height: size }}
      >
        <title>GetChat Logo</title>
        <path
          d="M27.2 27.9 24.4 22.3A5.6 5.6 0 0 0 30 16.7v-7a5.6 5.6 0 0 0-5.6-5.6H7.6A5.6 5.6 0 0 0 2 9.7v7a5.6 5.6 0 0 0 5.6 5.6H16Z"
          stroke="#4E5AEA"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="9" cy="13.2" r="1.4" fill="#959CF2" />
        <circle cx="16" cy="13.2" r="1.4" fill="#959CF2" />
        <circle cx="23" cy="13.2" r="1.4" fill="#959CF2" />
      </svg>
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
