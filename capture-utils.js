export function sanitizeCaptures(captures) {
  return captures
    .map((c) => ({
      role: c.role,
      text: String(c.text ?? "").trim(),
    }))
    .filter((c) => c.text.length > 0)
    .filter((c) => !c.text.includes("<relevant-memories>"));
}
