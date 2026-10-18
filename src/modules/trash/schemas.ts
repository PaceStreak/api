import * as z from "zod";

export const TrashId = z.object({ trash_id: z.uuid() });
