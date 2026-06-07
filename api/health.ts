export function GET(): Response {
  return Response.json({
    status: "ok",
    service: "Wilcraft Store webhook",
    timestamp: new Date().toISOString(),
  });
}
