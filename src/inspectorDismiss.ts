export function shouldIgnoreInspectorDismiss(target: HTMLElement) {
  return Boolean(
    target.closest(".inspector") ||
      target.closest("button, input, textarea, select, a") ||
      target.closest(".data-table tbody tr") ||
      target.closest(".segmented") ||
      target.closest(".search-field") ||
      target.closest(".account-pill") ||
      target.closest(".account-pill-row") ||
      target.closest(".row-actions"),
  );
}
