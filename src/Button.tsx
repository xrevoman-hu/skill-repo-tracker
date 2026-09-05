import type { MouseEvent, ReactNode } from "react";

type ButtonProps = {
  children: ReactNode;
  variant?: string;
  pending?: boolean;
  pendingLabel?: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
  "aria-label"?: string;
  "data-autofocus"?: boolean | string;
};

export function Button({
  children,
  variant = "secondary",
  onClick,
  disabled = false,
  className = "",
  pending = false,
  pendingLabel,
  type = "button",
  "aria-label": ariaLabel,
  "data-autofocus": dataAutofocus,
}: ButtonProps) {
  return (
    <button
      aria-label={ariaLabel}
      className={`button ${variant} ${className} ${pending ? "is-pending" : ""}`}
      data-autofocus={dataAutofocus}
      onClick={onClick}
      disabled={disabled || pending}
      type={type}
    >
      {pending ? pendingLabel || children : children}
    </button>
  );
}
