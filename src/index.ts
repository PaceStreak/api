import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.json({ status: "healthy" }));

export default app satisfies ExportedHandler<Env>;
