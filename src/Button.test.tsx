import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./App";

describe("reviewed Button props", () => {
  it("preserves labels, autofocus, classes, type and click delivery", () => {
    const onClick = vi.fn();
    render(<Button aria-label="Save changes" data-autofocus="true" className="wide" variant="primary" type="submit" onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toHaveAttribute("data-autofocus", "true");
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveClass("button", "primary", "wide");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("blocks clicks while pending or disabled and restores the default state", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button pending pendingLabel="Saving" onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toBeDisabled();
    expect(button).toHaveClass("is-pending");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<Button pending onClick={onClick}>Save</Button>);
    expect(button).toHaveTextContent("Save");
    rerender(<Button disabled onClick={onClick}>Save</Button>);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<Button onClick={onClick}>Save</Button>);
    expect(button).toBeEnabled();
    expect(button).toHaveClass("secondary");
    expect(button).not.toHaveClass("is-pending");
    expect(button).toHaveAttribute("type", "button");
    expect(button).not.toHaveAttribute("aria-label");
    expect(button).not.toHaveAttribute("data-autofocus");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
