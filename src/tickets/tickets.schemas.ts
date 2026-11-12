import { z } from 'zod';

export const fileKind = z.enum(['pdf', 'image', 'share']);
export const resendBody = z.object({ toEmail: z.string().trim().toLowerCase().email().max(200).optional() });
export type ResendBody = z.infer<typeof resendBody>;
