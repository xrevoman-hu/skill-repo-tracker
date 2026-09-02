import { posix } from "node:path";

export function frontendImportBoundaryViolation(importer, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0];
  const absolute = clean.startsWith("/");
  const relative = clean.startsWith(".");
  const destination = absolute
    ? posix.normalize(clean)
    : relative
      ? posix.normalize(posix.join(posix.dirname(importer), clean))
      : clean;
  const governed = absolute
    ? destination === "/src" || destination.startsWith("/src/")
    : destination === "src" || destination.startsWith("src/");
  if (clean.startsWith("file:") || ((absolute || relative) && !governed)) {
    return "imports outside governed src/";
  }
  return /[?#]/.test(specifier)
    ? "uses a Vite loader query or fragment outside the governed module contract"
    : undefined;
}
