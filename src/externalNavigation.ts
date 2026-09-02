const GITHUB_AUTHORITY = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i;

export function openGithub(value: string): boolean {
  if (value !== value.trim()) return false;
  const authority = GITHUB_AUTHORITY.exec(value)?.[1];
  if (authority?.toLowerCase() !== "github.com") return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== ""
    ) return false;
    window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}
