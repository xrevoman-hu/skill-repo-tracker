import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonProps = Pick<ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "onClick" | "disabled" | "className" | "type" | "aria-label"> & {
  variant?: string;
  pending?: boolean;
  pendingLabel?: ReactNode;
  "data-autofocus"?: boolean | string;
};
