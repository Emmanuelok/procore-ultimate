import { z } from "zod";

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export function pageOffset(q: PageQuery): number {
  return (q.page - 1) * q.pageSize;
}

export function paginate<T>(items: T[], total: number, q: PageQuery) {
  return { items, total, page: q.page, pageSize: q.pageSize };
}
