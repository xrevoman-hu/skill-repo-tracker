import { useEffect, useRef } from "react";

type RepositorySelectAllProps = {
  state: { checked: boolean; mixed: boolean; selectableCount: number };
  label: string;
  onChange: (checked: boolean) => void;
};

export function RepositorySelectAll({ state, label, onChange }: RepositorySelectAllProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = state.mixed;
  }, [state.mixed]);

  return (
    <input
      aria-label={label}
      title={label}
      aria-checked={state.mixed ? "mixed" : state.checked}
      checked={state.checked}
      disabled={state.selectableCount === 0}
      onChange={(event) => onChange(event.target.checked)}
      ref={inputRef}
      type="checkbox"
    />
  );
}
